// Card games with hidden hands. Same contract as games.js: pure, mutate state, return points when finished.
import { shuffle, int } from './games.js';

const hash = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const luck = (pid, salt) => hash(`${pid}:${salt}`) % 100; // a bot's stable "mood" for one decision
const nextSeat = (ctx, s, from, dir = 1) => {
  const n = s.players.length;
  for (let k = 1; k <= n; k++) {
    const j = (((from + dir * k) % n) + n) % n;
    if (ctx.active.includes(s.players[j]) && !s.out?.includes(s.players[j])) return j;
  }
  return from;
};
const handPoints = (s, winner) => { // winner 100, everyone else by how few cards they hold
  const most = Math.max(1, ...s.players.map(p => s.hands[p].length));
  return Object.fromEntries(s.players.map(p => [p, p === winner ? 100 : Math.round(60 * (1 - s.hands[p].length / most))]));
};

// ───────────── Bluff: play face down, claim the rank, call out the liars ─────────────
const RANKS = 'A23456789TJQK', SUITS = 'SHDC', TURN_MS = 30000, CALL_MS = 6000;
const bluff = {
  name: 'Bluff', icon: '🤥', min: 2, max: 8, secs: 360, desc: 'Play cards face down, claim a rank. Lie. Get caught',
  settings: () => ({}),
  init(ctx, players) {
    const hands = Object.fromEntries(players.map(p => [p, []]));
    shuffle(ctx.rng, [...RANKS].flatMap(r => [...SUITS].map(x => r + x))).forEach((c, i) => hands[players[i % players.length]].push(c));
    for (const p of players) hands[p].sort((a, b) => RANKS.indexOf(a[0]) - RANKS.indexOf(b[0]));
    return { players, hands, pile: [], rank: 0, turn: 0, last: null, reveal: null, winner: null, plays: 0, phase: 'play', deadline: ctx.now + TURN_MS };
  },
  input(ctx, s, pid, inp) {
    if (s.phase === 'play' && s.players[s.turn] === pid && Array.isArray(inp.play)) {
      const cards = [...new Set(inp.play)].filter(c => s.hands[pid].includes(c));
      if (!cards.length || cards.length > 4 || cards.length !== inp.play.length) return;
      bluffPlay(ctx, s, pid, cards);
    } else if (s.phase === 'call' && inp.call === true && pid !== s.last.pid && pid in s.hands) bluffCall(ctx, s, pid);
  },
  timer(ctx, s) {
    if (s.phase === 'play') return void bluffPlay(ctx, s, s.players[s.turn], [s.hands[s.players[s.turn]][0]]); // too slow: play your first card
    if (s.phase === 'over') return handPoints(s, s.winner);
    const won = !s.hands[s.last.pid].length && !(s.reveal?.lie); // emptied your hand and nobody caught you
    if (won) return void Object.assign(s, { winner: s.last.pid, phase: 'over', deadline: ctx.now + 4000 });
    Object.assign(s, { rank: (s.rank + 1) % 13, turn: nextSeat(ctx, s, s.players.indexOf(s.last.pid)), phase: 'play', reveal: null, deadline: ctx.now + TURN_MS });
  },
  status(ctx, s) {
    if (s.phase === 'play' && !ctx.active.includes(s.players[s.turn])) s.turn = nextSeat(ctx, s, s.turn);
  },
  view: (s, pid) => ({
    phase: s.phase, players: s.players, hand: s.hands[pid] ?? null, counts: s.players.map(p => [p, s.hands[p].length]),
    pile: s.pile.length, rank: RANKS[s.rank], turn: s.players[s.turn], deadline: s.deadline, winner: s.winner,
    last: s.last && { pid: s.last.pid, n: s.last.cards.length, rank: s.last.rank }, reveal: s.reveal,
  }),
  bot(ctx, s, pid) {
    const hand = s.hands[pid], delay = 1300 + ctx.rng() * 1500;
    if (s.phase === 'play' && s.players[s.turn] === pid) {
      const r = RANKS[s.rank], honest = hand.filter(c => c[0] === r).slice(0, 4);
      if (honest.length) return { input: { play: honest }, delay };
      return { input: { play: shuffle(ctx.rng, hand).slice(0, luck(pid, s.plays) < 30 && hand.length > 3 ? 2 : 1) }, delay }; // bluff
    }
    if (s.phase === 'call' && s.last.pid !== pid && pid in s.hands) {
      const mine = hand.filter(c => c[0] === s.last.rank).length, mood = luck(pid, s.plays);
      const sure = mine + s.last.n > 4, finishing = !s.hands[s.last.pid].length;
      if (sure || (finishing && mood < 70) || (s.last.n >= 3 && mood < 25)) return { input: { call: true }, delay: 900 + ctx.rng() * 1600 };
    }
    return null;
  },
};
function bluffPlay(ctx, s, pid, cards) {
  s.hands[pid] = s.hands[pid].filter(c => !cards.includes(c));
  s.pile.push(...cards);
  s.plays++;
  Object.assign(s, { last: { pid, cards, rank: RANKS[s.rank] }, phase: 'call', deadline: ctx.now + CALL_MS });
}
function bluffCall(ctx, s, caller) {
  const lie = s.last.cards.some(c => c[0] !== s.last.rank), taker = lie ? s.last.pid : caller;
  s.hands[taker].push(...s.pile);
  s.hands[taker].sort((a, b) => RANKS.indexOf(a[0]) - RANKS.indexOf(b[0]));
  Object.assign(s, { reveal: { caller, cards: s.last.cards, lie, taker, n: s.pile.length }, pile: [], phase: 'reveal', deadline: ctx.now + 4500 });
}

// ───────────── Color Clash: match colour or symbol; skips, reverses, +2 and wild +4 ─────────────
// cards: colour R/Y/G/B + 0–9, S (skip), R (reverse), D (draw two); wilds: WW and W4
const COLORS = 'RYGB', CTURN = 20000;
const playable = (s, c) => c[0] === 'W' || c[0] === s.color || c[1] === s.top[1];
const clash = {
  name: 'Color Clash', icon: '🌈', min: 2, max: 8, secs: 360, desc: 'Match colour or symbol. Skip, reverse, +2, wild +4',
  settings: r => ({ start: int(r?.start, 5, 10, 7) }),
  init(ctx, players, st) {
    const deck = shuffle(ctx.rng, [...COLORS].flatMap(c => ['0', ...'123456789SRD123456789SRD'].map(v => c + v)).concat(['WW', 'WW', 'WW', 'WW', 'W4', 'W4', 'W4', 'W4']));
    const hands = Object.fromEntries(players.map(p => [p, deck.splice(0, st.start)]));
    let i = deck.findIndex(c => /^[RYGB][0-9]$/.test(c)); // start on a plain number
    const top = deck.splice(i, 1)[0];
    return { players, hands, deck, discard: [top], top, color: top[0], dir: 1, turn: 0, drew: false, unsaid: null, winner: null, moves: 0, phase: 'play', deadline: ctx.now + CTURN, endsAt: ctx.now + 15 * 60e3 };
  },
  input(ctx, s, pid, inp) {
    if (s.phase !== 'play') return;
    if (typeof inp.catch === 'string' && s.unsaid === inp.catch && pid !== inp.catch && pid in s.hands) { // forgot to call "last card": +2
      draw(ctx, s, inp.catch, 2);
      s.unsaid = null;
      return;
    }
    if (s.players[s.turn] !== pid) return;
    if (inp.draw === true && !s.drew) {
      s.unsaid = null;
      const [c] = draw(ctx, s, pid, 1);
      s.drew = true;
      if (!c || !playable(s, c)) advance(ctx, s, 1);
      return;
    }
    if (inp.pass === true && s.drew) return void advance(ctx, s, 1);
    const c = inp.play, hand = s.hands[pid];
    if (typeof c !== 'string' || !hand.includes(c) || !playable(s, c)) return;
    s.unsaid = null;
    hand.splice(hand.indexOf(c), 1);
    s.discard.push(c);
    s.top = c;
    s.color = c[0] === 'W' ? (COLORS.includes(inp.color) && inp.color.length === 1 ? inp.color : mostColor(hand)) : c[0];
    s.moves++;
    if (hand.length === 1 && inp.last !== true) s.unsaid = pid;
    if (!hand.length) return void Object.assign(s, { winner: pid, phase: 'over', deadline: ctx.now + 4000 });
    const n = ctx.active.filter(p => s.players.includes(p)).length;
    if (c[1] === 'R') { s.dir *= -1; if (n === 2) return void advance(ctx, s, 2); }
    if (c[1] === 'S') return void advance(ctx, s, 2);
    if (c[1] === 'D' || c === 'W4') {
      const victim = s.players[nextSeat(ctx, s, s.turn, s.dir)];
      draw(ctx, s, victim, c === 'W4' ? 4 : 2);
      return void advance(ctx, s, 2);
    }
    advance(ctx, s, 1);
  },
  timer(ctx, s) {
    if (s.phase === 'over') return handPoints(s, s.winner);
    if (ctx.now >= s.endsAt) { // marathon cap: fewest cards wins
      const w = [...s.players].sort((a, b) => s.hands[a].length - s.hands[b].length)[0];
      return void Object.assign(s, { winner: w, phase: 'over', deadline: ctx.now + 4000 });
    }
    const p = s.players[s.turn], c = s.hands[p].find(x => playable(s, x)); // too slow: we play for you, or draw
    if (c) return clash.input(ctx, s, p, { play: c, last: true });
    if (!s.drew) draw(ctx, s, p, 1);
    advance(ctx, s, 1);
  },
  status(ctx, s) {
    if (s.phase === 'play' && !ctx.active.includes(s.players[s.turn])) advance(ctx, s, 1);
  },
  view: (s, pid) => ({
    phase: s.phase, players: s.players, hand: s.hands[pid] ?? null, counts: s.players.map(p => [p, s.hands[p].length]),
    top: s.top, color: s.color, dir: s.dir, turn: s.players[s.turn], drew: s.drew, deck: s.deck.length,
    unsaid: s.unsaid, winner: s.winner, deadline: s.deadline,
  }),
  bot(ctx, s, pid) {
    const delay = 1000 + ctx.rng() * 1100;
    if (s.phase !== 'play') return null;
    if (s.unsaid && s.unsaid !== pid && luck(pid, s.moves) < 55) return { input: { catch: s.unsaid }, delay: 1200 + ctx.rng() * 1500 };
    if (s.players[s.turn] !== pid) return null;
    const hand = s.hands[pid], ok = hand.filter(c => playable(s, c));
    const nextCount = s.hands[s.players[nextSeat(ctx, s, s.turn, s.dir)]].length;
    const score = c => (c === 'W4' ? -10 : c === 'WW' ? -5 : /[SRD]/.test(c[1]) ? (nextCount <= 3 ? 10 : 2) : 5) + (c[0] === mostColor(hand) ? 1 : 0);
    const c = ok.sort((a, b) => score(b) - score(a))[0];
    if (c) return { input: { play: c, color: mostColor(hand.filter(x => x !== c)), last: hand.length === 2 && luck(pid, s.moves) < 90 }, delay };
    return { input: s.drew ? { pass: true } : { draw: true }, delay };
  },
};
const mostColor = hand => [...COLORS].sort((a, b) => hand.filter(c => c[0] === b).length - hand.filter(c => c[0] === a).length)[0];
function draw(ctx, s, pid, n) {
  const got = [];
  for (let k = 0; k < n; k++) {
    if (!s.deck.length) { // reshuffle the discards under the top card
      if (s.discard.length < 2) break;
      s.deck = shuffle(ctx.rng, s.discard.slice(0, -1));
      s.discard = [s.top];
    }
    got.push(s.deck.pop());
  }
  s.hands[pid].push(...got);
  return got;
}
function advance(ctx, s, steps) {
  let t = s.turn;
  for (let k = 0; k < steps; k++) t = nextSeat(ctx, s, t, s.dir);
  Object.assign(s, { turn: t, drew: false, deadline: ctx.now + CTURN });
}

export const CARDS = { bluff, clash };
