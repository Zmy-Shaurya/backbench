// Pure game modules: no I/O, time and rng injected via ctx = { now, rng, active, host, clean }.
// Each module mutates its own state and returns `points` when the game is finished.
// `s.deadline` (absolute server ms) is the only timer; the Room calls timer() when it passes.
import { PAIRS, PROMPTS, WHO_PROMPTS, BOMB_CATS, EMOJI_PUZZLES, clean } from './content.js';

export const reject = m => { throw { reject: m }; };
export const pick = (rng, a) => a[Math.floor(rng() * a.length)];
export const shuffle = (rng, a) => {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
export const int = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
export const live = (ctx, s) => s.players.filter(p => ctx.active.includes(p));
const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export const text = (v, max) =>
  typeof v === 'string' ? Array.from(v.replace(/\p{Cc}/gu, '').trim()).slice(0, max).join('').trim() : '';
const lev = (a, b) => {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1]));
    prev = cur;
  }
  return prev[b.length];
};
export const fuzzy = (a, b) => lev(norm(a), norm(b)) <= 1;
// Crew weeks start Monday 00:00 IST. 1970-01-01 was a Thursday, hence the +3.
export const weekOf = t => Math.floor((Math.floor((t + 5.5 * 3600e3) / 864e5) + 3) / 7);
export const zero = ps => Object.fromEntries(ps.map(p => [p, 0]));
const avg = (total, rounds) => Object.fromEntries(Object.entries(total).map(([p, v]) => [p, Math.round(v / rounds)]));

// ───────────────────────── Tap Duel ─────────────────────────
const tapDuel = {
  name: 'Tap Duel', icon: '⚡', min: 1, max: 12, secs: 60, desc: 'Tap the instant it says TAP!',
  settings: r => ({ rounds: int(r?.rounds, 1, 10, 5) }),
  init(ctx, players, st) {
    const s = { players, rounds: st.rounds, round: 0, total: zero(players) };
    tapRound(ctx, s);
    return s;
  },
  input(ctx, s, pid, inp) {
    if (!['armed', 'go'].includes(s.phase) || pid in s.res) return;
    // false start: tapped before GO was revealed, client says early, or arrived before go time
    if (s.phase === 'armed' || inp.early || ctx.now < s.goAt) s.res[pid] = 'false';
    else {
      const ms = Number(inp.ms);
      s.res[pid] = !Number.isFinite(ms) || ms < 100 ? 'false' : ms > 3000 ? 'miss' : Math.round(ms);
    }
    if (live(ctx, s).every(p => p in s.res)) tapScore(ctx, s);
  },
  timer(ctx, s) {
    if (s.phase === 'countdown') {
      s.phase = 'armed';
      s.hiddenGo = ctx.now + 1500 + ctx.rng() * 3500;
      s.deadline = s.hiddenGo - 600; // reveal go time ~600 ms ahead so every phone flips at the same moment
    } else if (s.phase === 'armed') {
      s.phase = 'go';
      s.goAt = s.hiddenGo;
      s.deadline = s.goAt + 3000 + 1500; // max reaction + network grace
    } else if (s.phase === 'go') tapScore(ctx, s);
    else if (s.phase === 'result') {
      if (s.voided) s.round--;
      if (s.round >= s.rounds) return Object.fromEntries(Object.entries(s.total).map(([p, v]) => [p, Math.round((v * 5) / s.rounds)]));
      tapRound(ctx, s);
    }
  },
  status(ctx, s) {
    if (s.phase === 'go' && live(ctx, s).every(p => p in s.res)) tapScore(ctx, s);
  },
  view: (s, pid) => ({
    phase: s.phase, round: s.round, rounds: s.rounds, // no deadline: in 'armed' it would leak the go time
    goAt: s.phase === 'go' ? s.goAt : null,
    mine: s.res[pid] ?? null,
    last: s.phase === 'result' ? s.last : null,
    voided: s.voided, total: s.total,
  }),
};
function tapRound(ctx, s) {
  Object.assign(s, { round: s.round + 1, phase: 'countdown', deadline: ctx.now + 3000, res: {}, goAt: null, hiddenGo: null, last: null, voided: false });
}
function tapScore(ctx, s) {
  const r = s.res, ps = live(ctx, s);
  s.phase = 'result';
  s.deadline = ctx.now + 3000;
  s.voided = ps.length > 0 && ps.every(p => r[p] === 'false');
  if (s.voided) return;
  const tapped = s.players.filter(p => typeof r[p] === 'number');
  s.last = {};
  for (const p of s.players) {
    let pts = 0;
    if (r[p] === 'false') pts = -5;
    else if (typeof r[p] === 'number') {
      const pos = tapped.filter(q => r[q] < r[p] - 1).length; // ties within 1 ms share a position
      pts = [20, 12, 8][pos] ?? 3;
    }
    s.last[p] = { r: r[p] ?? 'miss', pts };
    s.total[p] += pts;
  }
}

// ───────────────────────── Imposter Word ─────────────────────────
const PHASE_MS = { reveal: 8000, discuss: 45000, vote: 25000, reveal_result: 6000, imposter_guess: 20000, round_result: 5000 };
const imposter = {
  name: 'Imposter Word', icon: '🕵️', min: 4, max: 12, secs: 240, desc: 'One of you doesn’t know the word',
  settings: r => ({ rounds: int(r?.rounds, 1, 5, 3), clueSec: int(r?.clueSec, 10, 60, 20), hard: r?.hard === true }),
  init(ctx, players, st) {
    const s = { players, st, round: 0, total: zero(players), used: [], imps: [] };
    impRound(ctx, s);
    return s;
  },
  input(ctx, s, pid, inp) {
    if (s.phase === 'discuss' && inp.skip && pid === ctx.host) return impNext(ctx, s);
    if (s.phase === 'clues' && pid === s.order[s.turn]) {
      let c = text(inp.clue, 20);
      if (!c || /\s/.test(c)) reject('One word, no spaces');
      const seen = s.imps.includes(pid) ? (s.st.hard ? s.pair.decoy : null) : s.pair.word;
      if (seen && norm(c).includes(norm(seen))) reject('Too obvious!');
      if (ctx.clean) c = clean(c);
      s.clues.push({ pid, clue: c });
      return impTurn(ctx, s, s.turn + 1);
    }
    if (s.phase === 'vote' && s.players.includes(pid) && s.players.includes(inp.vote) && inp.vote !== pid) {
      s.votes[pid] = inp.vote;
      if (live(ctx, s).every(p => p in s.votes)) impNext(ctx, s);
      return;
    }
    if (s.phase === 'imposter_guess' && pid === s.caught) {
      s.guess = text(inp.guess, 40);
      return impScore(ctx, s, fuzzy(s.guess, s.pair.word));
    }
  },
  timer(ctx, s) {
    if (s.phase === 'clues') {
      s.clues.push({ pid: s.order[s.turn], clue: null });
      return impTurn(ctx, s, s.turn + 1);
    }
    if (s.phase === 'imposter_guess') return impScore(ctx, s, false);
    if (s.phase === 'round_result') {
      if (s.round >= s.st.rounds) return avg(s.total, s.st.rounds);
      return impRound(ctx, s);
    }
    impNext(ctx, s);
  },
  status(ctx, s) {
    const on = live(ctx, s);
    if (s.phase === 'clues' && !on.includes(s.order[s.turn])) impTurn(ctx, s, s.turn);
    else if (s.phase === 'vote' && on.every(p => p in s.votes)) impNext(ctx, s);
    else if (s.phase === 'imposter_guess' && !on.includes(s.caught)) impScore(ctx, s, false);
  },
  view(s, pid) {
    const me = s.players.includes(pid), imp = s.imps.includes(pid), open = ['reveal_result', 'imposter_guess', 'round_result'].includes(s.phase);
    const card = !me ? null : !imp ? { category: s.pair.category, word: s.pair.word }
      : s.st.hard ? { category: s.pair.category, word: s.pair.decoy } : { category: s.pair.category, imposter: true };
    return {
      phase: s.phase, round: s.round, rounds: s.st.rounds, deadline: s.deadline, players: s.players,
      card, order: s.order, turn: s.order[s.turn] ?? null, clues: s.clues,
      voted: s.votes[pid] ?? null, votedCount: Object.keys(s.votes).length,
      votes: open ? s.votes : null, imps: open ? s.imps : null, caught: open ? s.caught : null,
      word: s.phase === 'round_result' ? s.pair.word : null,
      guess: s.phase === 'round_result' ? s.guess : null,
      roundPts: s.phase === 'round_result' ? s.roundPts : null,
      total: s.total,
    };
  },
};
function impRound(ctx, s) {
  const ps = live(ctx, s);
  let i = Math.floor(ctx.rng() * PAIRS.length);
  while (s.used.includes(i)) i = (i + 1) % PAIRS.length;
  s.used.push(i);
  const pool = ps.filter(p => !s.imps.includes(p)); // avoid last round's imposter(s)
  const n = ps.length >= 9 ? 2 : 1;
  Object.assign(s, {
    round: s.round + 1, pair: PAIRS[i], phase: 'reveal', deadline: ctx.now + PHASE_MS.reveal,
    imps: shuffle(ctx.rng, pool.length >= n ? pool : ps).slice(0, n),
    order: shuffle(ctx.rng, ps), turn: 0, clues: [], votes: {}, caught: null, guess: null, roundPts: null,
  });
}
function impTurn(ctx, s, turn) {
  const on = live(ctx, s);
  while (turn < s.order.length && !on.includes(s.order[turn])) turn++; // skip away players
  s.turn = turn;
  if (turn >= s.order.length) return impNext(ctx, s, 'discuss');
  s.phase = 'clues';
  s.deadline = ctx.now + s.st.clueSec * 1000;
}
function impNext(ctx, s, force) {
  const next = force ?? { reveal: 'clues', discuss: 'vote', vote: 'reveal_result', reveal_result: s.caught ? 'imposter_guess' : null }[s.phase];
  if (next === 'clues') return impTurn(ctx, s, 0);
  if (next === 'reveal_result') {
    const tally = {};
    for (const v of Object.values(s.votes)) tally[v] = (tally[v] || 0) + 1;
    const max = Math.max(0, ...Object.values(tally)), top = Object.keys(tally).filter(p => tally[p] === max);
    s.caught = top.length === 1 && s.imps.includes(top[0]) ? top[0] : null; // tie or wrong pick → imposter escapes
  }
  if (!next) return impScore(ctx, s, false);
  if (next === 'imposter_guess' && !live(ctx, s).includes(s.caught)) return impScore(ctx, s, false);
  s.phase = next;
  s.deadline = ctx.now + PHASE_MS[next];
}
function impScore(ctx, s, guessed) {
  const pts = zero(s.players);
  for (const i of s.imps) if (i !== s.caught) pts[i] += 100;
  if (s.caught) {
    if (guessed) pts[s.caught] += 60;
    for (const [v, t] of Object.entries(s.votes)) {
      if (guessed ? t === s.caught : s.imps.includes(t)) pts[v] += guessed ? 30 : 50;
    }
  }
  s.guessed = guessed;
  for (const p in pts) s.total[p] += pts[p];
  Object.assign(s, { roundPts: pts, phase: 'round_result', deadline: ctx.now + PHASE_MS.round_result });
}

// ───────────────────────── Doodle Telephone ─────────────────────────
const DMS = { write: 30000, draw: 60000, guess: 25000 }, GRACE = 2000, MAX_DRAWING = 48 * 1024;
const doodle = {
  name: 'Doodle Telephone', icon: '🎨', min: 4, max: 12, secs: 420, desc: 'Draw, guess, laugh at the mess',
  settings: () => ({}),
  init(ctx, players) {
    const s = { players: shuffle(ctx.rng, players), step: -1, chains: players.map(() => []), likes: {} };
    const pr = shuffle(ctx.rng, PROMPTS);
    s.suggest = Object.fromEntries(s.players.map((p, i) => [p, pr[i % pr.length]]));
    doodleStep(ctx, s);
    return s;
  },
  input(ctx, s, pid, inp) {
    const i = s.players.indexOf(pid);
    if (i < 0) return;
    if (s.phase === 'reveal') {
      if (inp.next && pid === ctx.host) {
        if (++s.rv >= s.players.length) return doodlePoints(s);
        return;
      }
      const [c, k] = String(inp.like ?? '').split('.').map(Number);
      const e = s.chains[s.rv]?.[k];
      if (c !== s.rv || !e || e.pid === pid) return;
      const key = `${c}.${k}`, l = (s.likes[key] ||= []);
      l.includes(pid) ? l.splice(l.indexOf(pid), 1) : l.push(pid);
      return;
    }
    if (pid in s.subs) return;
    let v;
    if (s.phase === 'draw') v = drawing(inp.drawing);
    else {
      v = text(inp.text, 40);
      if (v && ctx.clean) v = clean(v);
    }
    s.subs[pid] = v;
    if (live(ctx, s).every(p => p in s.subs)) doodleStep(ctx, s);
  },
  timer: (ctx, s) => doodleStep(ctx, s),
  status(ctx, s) {
    if (s.phase !== 'reveal' && live(ctx, s).every(p => p in s.subs)) doodleStep(ctx, s);
  },
  view(s, pid) {
    const i = s.players.indexOf(pid), N = s.players.length;
    if (s.phase === 'reveal') {
      return {
        phase: 'reveal', rv: s.rv, chains: N,
        chain: s.chains[s.rv].map((e, k) => ({ ...e, liked: !!s.likes[`${s.rv}.${k}`]?.includes(pid) })),
      };
    }
    const c = (i + s.step) % N;
    return {
      phase: s.phase, step: s.step, steps: N, ends: s.deadline - GRACE, deadline: s.deadline,
      done: Object.keys(s.subs).length, me: i < 0 ? null : {
        submitted: pid in s.subs,
        prev: s.step > 0 ? s.chains[c][s.step - 1] : null,
        suggest: s.suggest[pid],
      },
    };
  },
};
function doodleStep(ctx, s) {
  const N = s.players.length;
  if (s.step >= 0) {
    s.players.forEach((p, i) => {
      const draw = s.phase === 'draw', v = s.subs[p];
      s.chains[(i + s.step) % N].push({
        pid: p, kind: draw ? 'draw' : 'text',
        v: draw ? v ?? [] : v || (s.step === 0 ? pick(ctx.rng, PROMPTS) : '(no idea 🤷)'),
      });
    });
  }
  s.step++;
  s.subs = {};
  if (s.step >= N) return void Object.assign(s, { phase: 'reveal', rv: 0, deadline: null });
  s.phase = s.step === 0 ? 'write' : s.step % 2 ? 'draw' : 'guess';
  s.deadline = ctx.now + DMS[s.phase] + GRACE;
}
function doodlePoints(s) {
  const pts = zero(s.players);
  for (const [key, l] of Object.entries(s.likes)) {
    const [c, k] = key.split('.').map(Number), a = s.chains[c][k].pid;
    pts[a] = Math.min(100, pts[a] + 10 * l.length);
  }
  for (const ch of s.chains) {
    const last = ch.at(-1);
    if (ch.length > 1 && last.kind === 'text' && fuzzy(last.v, ch[0].v)) pts[ch[0].pid] += 20;
  }
  return pts;
}
// strokes: [{c: colourIdx 0-8 (8 = eraser), w: sizeIdx 0-2, p: [x0,y0,x1,y1,...]}] on a 360×480 canvas
function drawing(d) {
  if (d == null) return [];
  const ok = Array.isArray(d) && d.length <= 3000 && d.every(k =>
    k && int(k.c, 0, 8, -1) >= 0 && int(k.w, 0, 2, -1) >= 0 && Array.isArray(k.p) && k.p.length % 2 === 0 &&
    k.p.every(n => Number.isInteger(n) && n >= -20 && n <= 500));
  if (!ok) reject('Bad drawing');
  const out = d.map(k => ({ c: k.c, w: k.w, p: k.p }));
  if (JSON.stringify(out).length > MAX_DRAWING) reject('Drawing too big');
  return out;
}

// ───────────────────────── Who Said It? ─────────────────────────
const WMS = { answer: 45000, guess: 20000, reveal: 5000 };
const whoSaid = {
  name: 'Who Said It?', icon: '🗣️', min: 3, max: 12, secs: 240, desc: 'Answer anonymously, spot who wrote what',
  settings: r => ({ rounds: int(r?.rounds, 1, 3, 2) }),
  init(ctx, players, st) {
    const s = { players, rounds: st.rounds, round: 0, total: zero(players), prompts: shuffle(ctx.rng, WHO_PROMPTS) };
    whoRound(ctx, s);
    return s;
  },
  input(ctx, s, pid, inp) {
    if (s.phase === 'answer' && !(pid in s.answers)) {
      let a = text(inp.answer, 80);
      if (!a) reject('Write something!');
      s.answers[pid] = ctx.clean ? clean(a) : a;
    } else if (s.phase === 'guess' && pid !== s.queue[s.idx] && inp.author !== pid && s.players.includes(inp.author)) {
      s.guesses[pid] = inp.author;
    }
    whoCheck(ctx, s);
  },
  timer(ctx, s) {
    if (s.phase === 'answer') return whoGuess(ctx, s, 0);
    if (s.phase === 'guess') return whoReveal(ctx, s);
    if (s.idx + 1 < s.queue.length) return whoGuess(ctx, s, s.idx + 1);
    if (s.round < s.rounds) return whoRound(ctx, s);
    const scale = 10 / Math.max(1, (s.players.length - 1) * s.rounds); // ~100 for someone who spots everyone
    return Object.fromEntries(Object.entries(s.total).map(([p, v]) => [p, Math.round(v * scale)]));
  },
  status: (ctx, s) => whoCheck(ctx, s),
  view(s, pid) {
    const author = s.queue[s.idx], shown = s.phase !== 'answer';
    return {
      phase: s.phase, round: s.round, rounds: s.rounds, deadline: s.deadline, prompt: s.prompt, players: s.players,
      wrote: pid in s.answers, answered: Object.keys(s.answers).length,
      idx: s.idx, count: s.queue.length, answer: shown ? s.answers[author] ?? null : null,
      mine: shown && author === pid, guessed: s.guesses[pid] ?? null, guessedCount: Object.keys(s.guesses).length,
      author: s.phase === 'reveal' ? author ?? null : null, guesses: s.phase === 'reveal' ? s.guesses : null, total: s.total,
    };
  },
};
function whoRound(ctx, s) {
  Object.assign(s, {
    round: s.round + 1, prompt: s.prompts[s.round % s.prompts.length], phase: 'answer', deadline: ctx.now + WMS.answer,
    answers: {}, queue: [], idx: 0, guesses: {},
  });
}
function whoGuess(ctx, s, idx) {
  if (idx === 0) s.queue = shuffle(ctx.rng, Object.keys(s.answers));
  Object.assign(s, { idx, guesses: {}, phase: s.queue.length ? 'guess' : 'reveal', deadline: ctx.now + (s.queue.length ? WMS.guess : 0) });
}
function whoReveal(ctx, s) {
  const author = s.queue[s.idx];
  for (const [g, t] of Object.entries(s.guesses)) {
    if (t === author) s.total[g] += 10;
    else s.total[author] += 5; // fooled someone
  }
  Object.assign(s, { phase: 'reveal', deadline: ctx.now + WMS.reveal });
}
function whoCheck(ctx, s) {
  const on = live(ctx, s);
  if (s.phase === 'answer' && on.every(p => p in s.answers)) whoGuess(ctx, s, 0);
  else if (s.phase === 'guess' && on.filter(p => p !== s.queue[s.idx]).every(p => p in s.guesses)) whoReveal(ctx, s);
}

// ───────────────────────── Pass the Bomb ─────────────────────────
const bomb = {
  name: 'Pass the Bomb', icon: '💣', min: 3, max: 12, secs: 150, desc: 'Name one and pass it. Don’t hold it when it blows',
  settings: r => ({ rounds: int(r?.rounds, 1, 5, 3) }),
  init(ctx, players, st) {
    const s = { players, rounds: st.rounds, round: 0, total: zero(players), cats: shuffle(ctx.rng, BOMB_CATS) };
    bombRound(ctx, s);
    return s;
  },
  input(ctx, s, pid, inp) {
    if (s.phase !== 'live' || pid !== s.holder) return;
    let w = text(inp.word, 30);
    if (Array.from(w).length < 2) reject('Too short');
    if (s.said.some(x => norm(x.w) === norm(w))) reject('Already said!');
    s.said.push({ pid, w: ctx.clean ? clean(w) : w });
    bombPass(ctx, s);
  },
  timer(ctx, s) {
    if (s.phase === 'countdown') return void Object.assign(s, { phase: 'live', deadline: ctx.now + 15000 + ctx.rng() * 25000 }); // hidden fuse
    if (s.phase === 'live') {
      const pts = Math.round(100 / s.rounds);
      for (const p of live(ctx, s)) if (p !== s.holder) s.total[p] += pts;
      return void Object.assign(s, { phase: 'boom', loser: s.holder, deadline: ctx.now + 5000 });
    }
    if (s.round >= s.rounds) return s.total;
    bombRound(ctx, s);
  },
  status(ctx, s) {
    if (s.phase === 'live' && !live(ctx, s).includes(s.holder)) bombPass(ctx, s);
  },
  view: s => ({
    phase: s.phase, round: s.round, rounds: s.rounds, category: s.category, holder: s.holder, loser: s.loser,
    said: s.said.slice(-12), count: s.said.length, total: s.total,
    deadline: s.phase === 'live' ? null : s.deadline, // the fuse stays secret
  }),
};
function bombRound(ctx, s) {
  const on = live(ctx, s);
  Object.assign(s, {
    round: s.round + 1, category: s.cats[s.round % s.cats.length], said: [], loser: null,
    holder: s.loser && on.includes(s.loser) ? s.loser : pick(ctx.rng, on), // last loser starts
    phase: 'countdown', deadline: ctx.now + 3000,
  });
}
function bombPass(ctx, s) {
  const on = live(ctx, s), i = s.players.indexOf(s.holder);
  for (let k = 1; k <= s.players.length; k++) {
    const p = s.players[(i + k) % s.players.length];
    if (on.includes(p)) return (s.holder = p);
  }
}

// ───────────────────────── Emoji Decode ─────────────────────────
const emojiDecode = {
  name: 'Emoji Decode', icon: '🤔', min: 1, max: 12, secs: 200, desc: 'Guess the movie or thing from emojis',
  settings: r => ({ rounds: int(r?.rounds, 3, 15, 8) }),
  init(ctx, players, st) {
    const s = { players, rounds: st.rounds, round: 0, total: zero(players), list: shuffle(ctx.rng, EMOJI_PUZZLES).slice(0, st.rounds) };
    emojiNext(ctx, s);
    return s;
  },
  input(ctx, s, pid, inp) {
    if (s.phase !== 'puzzle' || pid in s.solved) return;
    const g = norm(text(inp.guess, 60));
    if (!s.list[s.round - 1].a.some(a => lev(norm(a), g) <= (norm(a).length > 8 ? 2 : 1))) reject('Not quite!');
    const pos = Object.keys(s.solved).length;
    s.solved[pid] = pos;
    s.total[pid] += [15, 10, 7][pos] ?? 5;
    emojiCheck(ctx, s);
  },
  timer(ctx, s) {
    if (s.phase === 'puzzle' && s.hint < 2) return void Object.assign(s, { hint: s.hint + 1, deadline: ctx.now + (s.hint ? 7000 : 8000) });
    if (s.phase === 'puzzle') return void Object.assign(s, { phase: 'reveal', deadline: ctx.now + 4000 });
    if (s.round >= s.rounds) return Object.fromEntries(Object.entries(s.total).map(([p, v]) => [p, Math.round((v * 8) / s.rounds)]));
    emojiNext(ctx, s);
  },
  status: (ctx, s) => emojiCheck(ctx, s),
  view: (s, pid) => ({
    phase: s.phase, round: s.round, rounds: s.rounds, deadline: s.deadline, ends: s.ends, emoji: s.list[s.round - 1].e,
    hint: emojiHint(s.list[s.round - 1].a[0], s.phase === 'reveal' ? 3 : s.hint),
    solved: pid in s.solved, solvedBy: Object.keys(s.solved).sort((a, b) => s.solved[a] - s.solved[b]),
    answer: s.phase === 'reveal' ? s.list[s.round - 1].a[0] : null, total: s.total,
  }),
};
function emojiNext(ctx, s) { // 10 s with just the letter count, then first letters, then a few more; 25 s in all
  Object.assign(s, { round: s.round + 1, phase: 'puzzle', hint: 0, deadline: ctx.now + 10000, ends: ctx.now + 25000, solved: {} });
}
// "The Lion King" → level 0 "___ ____ ____", 1 "T__ L___ K___", 2 "T_e L_o_ K_n_", 3 the answer
const emojiHint = (a, level) => (level >= 3 ? a : a.replace(/\p{L}|\p{N}/gu, (ch, i) => {
  const start = i === 0 || /\s/.test(a[i - 1]);
  return (level >= 1 && start) || (level >= 2 && i % 2 === 0) ? ch : '_';
}));
function emojiCheck(ctx, s) {
  if (s.phase === 'puzzle' && live(ctx, s).every(p => p in s.solved)) Object.assign(s, { phase: 'reveal', deadline: ctx.now + 4000 });
}

export const GAMES = { tap_duel: tapDuel, imposter, doodle, who_said: whoSaid, bomb, emoji: emojiDecode };
