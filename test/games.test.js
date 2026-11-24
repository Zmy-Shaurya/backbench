import test from 'node:test';
import assert from 'node:assert/strict';
import { GAMES as PARTY, fuzzy } from '../src/games.js';
import { CLASSICS, chessMove } from '../src/classics.js';
import { ARCADE } from '../src/arcade.js';
import { LIVE } from '../src/live.js';
import { CARDS } from '../src/cards.js';
import { LIVE2 } from '../src/live2.js';

const GAMES = { ...PARTY, ...CLASSICS, ...CARDS, ...ARCADE, ...LIVE, ...LIVE2 };
import { PAIRS } from '../src/content.js';

const seeded = (n = 1) => () => ((n = (n * 16807) % 2147483647) - 1) / 2147483646;
const mk = (players, now = 0) => ({ now, rng: seeded(), active: players, host: players[0], clean: true });
const ps = n => Array.from({ length: n }, (_, i) => `p${i}`);

test('word pack has ≥150 pairs', () => assert.ok(PAIRS.length >= 150 && PAIRS.every(p => p.word && p.decoy)));

test('tap duel: early tap = false start, fastest wins, all-false voids', () => {
  const G = GAMES.tap_duel, players = ps(3), ctx = mk(players);
  const s = G.init(ctx, players, G.settings({ rounds: 1 }));
  G.timer({ ...ctx, now: 3000 }, s); // → armed
  assert.equal(G.view(s, 'p0').goAt, null);
  G.input({ ...ctx, now: 3100 }, s, 'p0', {}); // tapped during armed
  G.timer({ ...ctx, now: s.deadline }, s); // → go
  const go = s.goAt;
  G.input({ ...ctx, now: go + 300 }, s, 'p1', { ms: 250 });
  G.input({ ...ctx, now: go + 50 }, s, 'p2', { ms: 50 }); // < 100 ms = anticipation
  assert.equal(s.phase, 'result');
  assert.deepEqual([s.last.p0.pts, s.last.p1.pts, s.last.p2.pts], [-5, 20, -5]);
  const pts = G.timer({ ...ctx, now: s.deadline }, s);
  assert.equal(pts.p1, 100); // 1 round of 20, normalised to a 5-round scale

  const v = G.init(ctx, players, G.settings({ rounds: 1 }));
  G.timer({ ...ctx, now: 3000 }, v);
  for (const p of players) G.input(ctx, v, p, { early: true });
  assert.ok(v.voided);
  assert.equal(G.timer({ ...ctx, now: v.deadline }, v), undefined); // replays instead of finishing
  assert.equal(v.round, 1);
});

test('imposter: hidden info stays hidden, catching + guessing scores', () => {
  const G = GAMES.imposter, players = ps(5), ctx = mk(players);
  const s = G.init(ctx, players, G.settings({ rounds: 1 }));
  const [imp] = s.imps, crew = players.filter(p => p !== imp);
  for (const p of crew) {
    const raw = JSON.stringify(G.view(s, p));
    assert.ok(!raw.includes(`"imps":[`) && raw.includes(s.pair.word));
  }
  assert.ok(!JSON.stringify(G.view(s, imp)).includes(s.pair.word));

  G.timer(ctx, s); // → clues
  assert.throws(() => G.input(ctx, s, s.order[0], { clue: s.imps.includes(s.order[0]) ? 'x y' : s.pair.word + 'ish' }));
  for (const p of [...s.order]) G.input(ctx, s, p, { clue: `clue${p}` });
  assert.equal(s.phase, 'discuss');
  G.input(ctx, s, ctx.host, { skip: true });
  for (const p of crew) G.input(ctx, s, p, { vote: imp });
  G.input(ctx, s, imp, { vote: crew[0] });
  assert.equal(s.phase, 'reveal_result');
  assert.equal(s.caught, imp);
  G.timer(ctx, s); // → imposter_guess
  assert.ok(!JSON.stringify(G.view(s, imp)).includes(s.pair.word)); // word still hidden while guessing
  G.input(ctx, s, imp, { guess: s.pair.word.toUpperCase() });
  assert.equal(s.roundPts[imp], 60);
  assert.equal(s.roundPts[crew[0]], 30);
  assert.ok(G.timer(ctx, s)); // finished
});

test('imposter: away clue-giver is skipped', () => {
  const G = GAMES.imposter, players = ps(4), ctx = mk(players);
  const s = G.init(ctx, players, G.settings({}));
  G.timer(ctx, s);
  const first = s.order[0];
  G.status({ ...ctx, active: players.filter(p => p !== first) }, s);
  assert.equal(s.turn, 1);
});

test('doodle: nobody sees their own chain before reveal; likes + bonus score', () => {
  const G = GAMES.doodle, players = ps(4), ctx = mk(players);
  const s = G.init(ctx, players, {});
  const N = players.length;
  for (let step = 0; step < N; step++) {
    for (const p of players) {
      const prev = G.view(s, p).me.prev;
      if (prev) assert.notEqual(s.chains.findIndex(ch => ch[0]?.pid === p), s.chains.findIndex(ch => ch.includes(prev)));
      G.input(ctx, s, p, s.phase === 'draw' ? { drawing: [{ c: 0, w: 1, p: [1, 2, 3, 4] }] } : { text: step ? 'cat' : 'cat' });
    }
  }
  assert.equal(s.phase, 'reveal');
  const author = s.chains[0][1].pid, liker = players.find(p => p !== author);
  G.input(ctx, s, liker, { like: '0.1' });
  let pts;
  for (let i = 0; i < N; i++) pts = G.input(ctx, s, ctx.host, { next: true }) ?? pts;
  assert.ok(pts[author] >= 10);
  assert.throws(() => GAMES.doodle.input(ctx, { ...s, phase: 'draw', subs: {} }, 'p0', { drawing: [{ c: 99, w: 0, p: [] }] }));
});

test('fuzzy match tolerates case and one typo', () => {
  assert.ok(fuzzy('Samosa', 'samosaa'));
  assert.ok(!fuzzy('Samosa', 'Kachori'));
});

test('who said it: author hidden until reveal, scoring', () => {
  const G = GAMES.who_said, players = ps(3), ctx = mk(players);
  const s = G.init(ctx, players, G.settings({ rounds: 1 }));
  for (const p of players) G.input(ctx, s, p, { answer: `answer by ${p}` });
  assert.equal(s.phase, 'guess');
  const author = s.queue[0], [a, b] = players.filter(p => p !== author);
  assert.equal(G.view(s, a).author, null);
  G.input(ctx, s, a, { author });
  G.input(ctx, s, b, { author: a });
  assert.equal(s.phase, 'reveal');
  assert.equal(G.view(s, a).author, author);
  assert.equal(s.total[a], 10);
  assert.equal(s.total[author], 5);
});

test('pass the bomb: fuse hidden, duplicates rejected, holder loses', () => {
  const G = GAMES.bomb, players = ps(3), ctx = mk(players);
  const s = G.init(ctx, players, G.settings({ rounds: 1 }));
  G.timer(ctx, s); // → live
  assert.equal(G.view(s, 'p0').deadline, null);
  const first = s.holder;
  G.input(ctx, s, first, { word: 'Mango' });
  assert.notEqual(s.holder, first);
  assert.throws(() => G.input(ctx, s, s.holder, { word: 'mango!' }));
  const loser = s.holder;
  G.timer(ctx, s); // boom
  assert.equal(s.loser, loser);
  const pts = G.timer(ctx, s);
  assert.equal(pts[loser], 0);
  assert.ok(players.filter(p => p !== loser).every(p => pts[p] === 100));
});

test('emoji decode: fuzzy answers, first solver scores most', () => {
  const G = GAMES.emoji, players = ps(2), ctx = mk(players);
  const s = G.init(ctx, players, G.settings({ rounds: 3 }));
  const ans = s.list[0].a[0];
  assert.ok(!JSON.stringify(G.view(s, 'p0')).includes(ans));
  assert.throws(() => G.input(ctx, s, 'p0', { guess: 'definitely wrong' }));
  G.input(ctx, s, 'p0', { guess: ans.toLowerCase() + 'x' });
  G.input(ctx, s, 'p1', { guess: ans });
  assert.equal(s.phase, 'reveal');
  assert.deepEqual([s.total.p0, s.total.p1], [15, 10]);
});

test('every game finishes on timers alone with a numeric points map', () => {
  for (const [id, G] of Object.entries(GAMES)) {
    const players = ps(Math.min(G.max, Math.max(G.min, 4))), ctx = mk(players);
    const s = G.init(ctx, players, G.settings({}));
    let pts, t = 0;
    for (let i = 0; i < 5000 && !pts; i++) {
      t = Math.max(t, s.deadline ?? t) + 1;
      pts = s.deadline == null ? G.input({ ...ctx, now: t }, s, ctx.host, { next: true }) : G.timer({ ...ctx, now: t }, s);
    }
    assert.ok(pts && Object.values(pts).every(Number.isFinite) && Object.keys(pts).every(p => players.includes(p)), `${id} finished`);
  }
});

test('tic-tac-toe: win, then best-of-3 stops at 2-0', () => {
  const G = GAMES.tictactoe, ctx = mk(ps(2)), s = G.init(ctx, ps(2), G.settings({}));
  for (const [p, at] of [['p0', 0], ['p1', 3], ['p0', 1], ['p1', 4], ['p0', 2]]) G.input(ctx, s, p, { at });
  assert.deepEqual(s.line, [0, 1, 2]);
  G.timer(ctx, s); // round 2, p1 starts
  assert.equal(G.view(s).turn, 'p1');
  G.input(ctx, s, 'p0', { at: 0 }); // not your turn → ignored
  assert.equal(s.board[0], null);
  for (const [p, at] of [['p1', 4], ['p0', 0], ['p1', 3], ['p0', 1], ['p1', 6], ['p0', 2]]) G.input(ctx, s, p, { at });
  assert.equal(s.score.p0, 2);
  assert.deepEqual(G.timer(ctx, s), { p0: 100, p1: 0 });
});

test('four in a row: discs stack, vertical four wins', () => {
  const G = GAMES.four_row, ctx = mk(ps(2)), s = G.init(ctx, ps(2), G.settings({}));
  for (let k = 0; k < 3; k++) { G.input(ctx, s, 'p0', { at: 3 }); G.input(ctx, s, 'p1', { at: 4 }); }
  assert.equal(s.board[5 * 7 + 3], 0);
  assert.equal(s.board[3 * 7 + 3], 0);
  G.input(ctx, s, 'p0', { at: 3 });
  assert.equal(s.line.length, 4);
  assert.equal(s.phase, 'result');
});

test('chess: legal moves only to the side to move, fool’s mate ends it', () => {
  const G = GAMES.chess, ctx = mk(ps(2)), s = G.init(ctx, ps(2), G.settings({}));
  const [w, b] = s.players;
  assert.ok(G.view(s, w).moves.e2.includes('e4'));
  assert.deepEqual(G.view(s, b).moves, {});
  assert.throws(() => G.input(ctx, s, w, { from: 'e2', to: 'e5' }));
  G.input(ctx, s, b, { from: 'e7', to: 'e5' }); // not black's turn → ignored
  for (const [p, from, to] of [[w, 'f2', 'f3'], [b, 'e7', 'e5'], [w, 'g2', 'g4'], [b, 'd8', 'h4']]) G.input(ctx, s, p, { from, to });
  assert.deepEqual(s.result, { winner: b, why: 'checkmate' });
  assert.deepEqual(G.timer(ctx, s), { [w]: 0, [b]: 100 });
});

test('dots & boxes: closing a box keeps the turn', () => {
  const G = GAMES.dots, ctx = mk(ps(2)), s = G.init(ctx, ps(2), G.settings({ size: 3 }));
  const [top, bottom, left, right] = [0, 3, 12, 13]; // edges of box (0,0) on a 3×3 board
  G.input(ctx, s, 'p0', { line: top });
  G.input(ctx, s, 'p1', { line: bottom });
  G.input(ctx, s, 'p0', { line: left });
  G.input(ctx, s, 'p1', { line: right });
  assert.equal(s.boxes[0], 1);
  assert.equal(G.view(s).turn, 'p1');
});

test('mines: mines hidden until the round ends, zeros flood open', () => {
  const G = GAMES.mines, ctx = mk(ps(2)), s = G.init(ctx, ps(2), G.settings({}));
  const v = G.view(s, 'p0');
  assert.ok(v.cells.includes(0) && !v.cells.includes('m'));
  const bomb = s.num.indexOf(-1);
  G.input(ctx, s, 'p0', { open: bomb });
  assert.equal(G.view(s, 'p0').done, 'boom');
  assert.ok(!G.view(s, 'p0').cells.includes('m'));
  G.timer(ctx, s);
  assert.ok(G.view(s, 'p0').cells.includes('m'));
});

test('bots alone can finish every game they support', () => {
  for (const [id, G] of Object.entries(GAMES).filter(([, g]) => g.bot)) {
    const players = ps(Math.min(G.max, Math.max(G.min, 3))), ctx = mk(players);
    const s = G.init(ctx, players, G.settings({}));
    let pts, t = 0;
    for (let i = 0; i < 20000 && !pts; i++) {
      const c = { ...ctx, now: t };
      const plans = players.map(p => [p, G.bot(c, s, p)]).filter(([, x]) => x);
      if (plans.length) {
        const [p, plan] = plans[0];
        t += Math.max(1, plan.delay | 0);
        try { pts = G.input({ ...ctx, now: t }, s, p, plan.input); } catch (e) { if (!e.reject) throw e; }
      } else {
        t = Math.max(t + 1, s.deadline ?? t + 1);
        pts = G.timer({ ...ctx, now: t }, s);
      }
    }
    assert.ok(pts && Object.values(pts).every(Number.isFinite), `${id} finished with bots`);
  }
});

test('chess engine takes mate in one and avoids hanging the queen', () => {
  assert.deepEqual(chessMove('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', Math.random), { from: 'h5', to: 'f7' });
  for (let i = 0; i < 5; i++) {
    const m = chessMove('rnbqkbnr/ppp2ppp/8/3pp3/4P3/5Q2/PPPP1PPP/RNB1KBNR w KQkq - 0 3', Math.random);
    assert.ok(!(m.from === 'f3' && ['f7', 'd5', 'b7'].includes(m.to)), JSON.stringify(m)); // f7/b7 lose the queen; exd5 is fine
  }
});

test('penalties: keeper guessing right saves, decided early when unreachable', () => {
  const G = GAMES.penalty, ctx = mk(ps(2)), s = G.init(ctx, ps(2), {});
  G.input(ctx, s, 'p0', { zone: 4 });
  assert.equal(G.view(s, 'p1').log.length, 0); // shooter's pick stays hidden
  G.input(ctx, s, 'p1', { zone: 4 });
  assert.equal(s.log[0].result, 'saved');
  s.goals = { p0: 0, p1: 3 }; s.kick = 7; // p1 3–0 up, p0 has 1 kick left
  G.timer(ctx, s);
  assert.equal(s.phase, 'over');
});

test('score attack: scores above the human rate cap are ignored', () => {
  const G = GAMES.keepy, ctx = mk(ps(2)), s = G.init(ctx, ps(2), {});
  G.timer({ ...ctx, now: 3000 }, s); // → play, start = 3000
  G.input({ ...ctx, now: 5000 }, s, 'p0', { score: 500 }); // 2 s in → cap ≈ 9
  G.input({ ...ctx, now: 5000 }, s, 'p1', { score: 6 });
  assert.deepEqual(s.best, { p0: 0, p1: 6 });
});

test('crew weeks roll over on Monday 00:00 IST', async () => {
  const { weekOf } = await import('../src/games.js');
  const sunNight = Date.parse('2026-11-22T18:29:00Z'), monMorning = Date.parse('2026-11-22T18:31:00Z'); // 23:59 / 00:01 IST
  assert.equal(weekOf(monMorning) - weekOf(sunNight), 1);
});

// live games: run the tick loop the way the Room does
const run = (G, s, ctx, ms) => {
  let pts;
  for (let t = ctx.now; t < ctx.now + ms && !pts; t += 1000 / G.rt) {
    const c = { ...ctx, now: t };
    pts = s.deadline && t >= s.deadline ? G.timer(c, s) : G.tick(c, s, 1 / G.rt);
  }
  return pts;
};

test('live: computer players finish sumo, snake and air hockey on their own', () => {
  for (const id of ['sumo', 'snake', 'hockey']) {
    const G = LIVE[id], players = id === 'hockey' ? ['bot-a', 'bot-b'] : ['bot-a', 'bot-b', 'bot-c'];
    const ctx = { ...mk(players), bots: players };
    const s = G.init(ctx, players, G.settings({}));
    const pts = run(G, s, ctx, 10 * 60e3);
    assert.ok(pts && Object.values(pts).some(v => v > 0), `${id} produced a winner`);
  }
});

test('live: inputs only steer; junk input is ignored', () => {
  const G = LIVE.sumo, players = ps(2), ctx = mk(players), s = G.init(ctx, players, G.settings({}));
  G.input(ctx, s, 'p0', { x: 9, y: 'nope', dash: 'yes' });
  assert.deepEqual(s.in.p0, { x: 1, y: 0, act: false });
  G.input(ctx, s, 'stranger', { x: 1 });
  assert.equal(s.in.stranger, undefined);
});

test('snake: head-on crash kills both, growth, and two quick turns both count', () => {
  const G = LIVE.snake, N = 32, players = ps(2), ctx = mk(players), s = G.init(ctx, players, G.settings({}));
  G.timer({ ...ctx, now: s.deadline }, s); // → play
  s.sn[0] = { body: [5 * N + 10, 5 * N + 9], d: 1, q: [], grow: 0, dead: 0 };
  s.sn[1] = { body: [5 * N + 12, 5 * N + 13], d: 3, q: [], grow: 0, dead: 0 };
  s.food = [20 * N + 20];
  G.tick({ ...ctx, now: s.t0 + 100 }, s, 0.125); // both heads land on cell 11
  assert.ok(s.sn[0].dead && s.sn[1].dead);
  assert.equal(s.phase, 'gap');

  const t = G.init(ctx, players, G.settings({}));
  G.timer({ ...ctx, now: t.deadline }, t);
  t.sn[0] = { body: [10 * N + 10, 10 * N + 9, 10 * N + 8], d: 1, q: [], grow: 0, dead: 0 }; // heading right
  G.input(ctx, t, 'p0', { d: 2 }); G.input(ctx, t, 'p0', { d: 3 }); // down then left, inside one tick: a quick U-turn
  G.input(ctx, t, 'p0', { d: 1 }); // reversing the queued "left" is ignored
  assert.deepEqual(t.sn[0].q, [2, 3]);
  t.food = [11 * N + 10];
  G.tick({ ...ctx, now: t.t0 + 100 }, t, 0.125);
  G.tick({ ...ctx, now: t.t0 + 200 }, t, 0.125);
  assert.equal(t.sn[0].body[0], 11 * N + 9); // went down (ate), then left
  assert.equal(t.sn[0].body.length, 5); // +2 growth, paid out one cell per step
});

test('land grab: closing a loop claims the inside; crossing a trail knocks its owner out', () => {
  const G = LIVE.land, LN = 36, players = ps(2), ctx = mk(players), s = G.init(ctx, players, {});
  G.timer({ ...ctx, now: s.deadline }, s); // → play
  s.own.fill(0);
  for (let y = 9; y <= 11; y++) for (let x = 9; x <= 11; x++) s.own[y * LN + x] = 1;
  Object.assign(s.p[0], { x: 11, y: 9, d: 1, q: [], trail: [] });
  Object.assign(s.p[1], { x: 30, y: 30, d: 0, q: [], trail: [] });
  const go = d => { G.input(ctx, s, 'p0', { d }); G.tick({ ...ctx, now: 5000 }, s); };
  go(1); go(1); go(1); go(2); go(2); go(2); go(2); go(3); go(3); go(3); go(3); go(0); go(0); // right 3, down 4, left 4, up 2 into home
  const mine = s.own.filter(c => c === 1).length;
  assert.ok(mine >= 9 + 12, `claimed the loop (${mine})`);
  assert.equal(s.own[12 * LN + 13], 1); // a cell strictly inside the loop
  assert.equal(s.p[0].trail.length, 0);
  Object.assign(s.p[1], { x: 20, y: 5, d: 2, q: [], trail: [] });
  Object.assign(s.p[0], { x: 20, y: 7, d: 1, q: [], trail: [6 * LN + 20, 7 * LN + 20] }); // p0's trail lies across p1's path
  G.tick({ ...ctx, now: 6000 }, s);
  assert.ok(s.p[0].out, 'p1 cut p0 off');
  assert.equal(s.own.filter(c => c === 1).length, 0);
});

test('type race: progress is rate-capped, finishing ranks you', () => {
  const G = LIVE.type_race, players = ps(2), ctx = mk(players), s = G.init(ctx, players, {});
  G.timer({ ...ctx, now: s.deadline }, s); // → play
  G.input({ ...ctx, now: s.t0 + 1000 }, s, 'p0', { p: s.text.length }); // the whole passage in 1 s: no
  assert.ok(s.prog.p0 < 40);
  for (let t = 1000, p = 0; p < s.text.length; t += 1000) { p = Math.min(s.text.length, p + 15); G.input({ ...ctx, now: s.t0 + t }, s, 'p1', { p }); }
  assert.ok('p1' in s.fin);
  assert.equal(s.phase, 'play');
});

test('air hockey: puck in the net scores, first to 7 ends it', () => {
  const G = LIVE.hockey, players = ps(2), ctx = mk(players), s = G.init(ctx, players, {});
  G.timer({ ...ctx, now: s.deadline }, s); // → play
  s.goals.p0 = 6;
  Object.assign(s.k, { x: 300, y: 40, vx: 0, vy: -2000 }); // flying into the top goal, which p0 attacks
  for (let t = 3000; s.phase === 'play' && t < 4000; t += 40) G.tick({ ...ctx, now: t }, s, 0.04);
  assert.equal(s.goals.p0, 7);
  assert.equal(s.phase, 'over');
  assert.deepEqual(G.timer({ ...ctx, now: s.deadline }, s), { p0: 100, p1: 0 });

  // face-off after a goal: an idle mallet parked on the spot must not knock it into its own net
  const f = G.init(ctx, players, {});
  G.timer({ ...ctx, now: f.deadline }, f);
  Object.assign(f.k, { x: 300, y: 980, vx: 0, vy: 2000 }); // p1 scores on p0
  for (let t = 3000; t < 3200; t += 40) G.tick({ ...ctx, now: t }, f, 0.04);
  assert.equal(f.goals.p1, 1);
  G.input(ctx, f, 'p0', { x: f.k.x, y: f.k.y - 40 }); // p0 parks right on top of the reset puck
  for (let t = 3200; t < 9000; t += 40) G.tick({ ...ctx, now: t }, f, 0.04);
  assert.equal(f.goals.p1, 1, 'no own goal from a parked mallet');
});

test('bluff: hands hidden, a caught lie takes the pile, a wrong call takes it instead', () => {
  const G = GAMES.bluff, players = ps(3), ctx = mk(players), s = G.init(ctx, players, {});
  assert.equal(G.view(s, 'p1').hand.length, s.hands.p1.length);
  assert.ok(!JSON.stringify(G.view(s, 'p1')).includes(JSON.stringify(s.hands.p0)));
  s.hands.p0 = ['5S', '9H', 'KD']; // rank to claim is A: playing a 5 is a lie
  G.input(ctx, s, 'p0', { play: ['5S'] });
  assert.equal(G.view(s, 'p2').last.n, 1);
  assert.equal(G.view(s, 'p2').reveal, null); // cards stay face down
  G.input(ctx, s, 'p0', { call: true }); // can't call yourself
  assert.equal(s.phase, 'call');
  G.input(ctx, s, 'p1', { call: true });
  assert.ok(s.reveal.lie && s.reveal.taker === 'p0' && s.hands.p0.includes('5S'));
  G.timer({ ...ctx, now: s.deadline }, s); // next: p1 claims 2s
  s.hands.p1 = ['2C', '2D', '7S'];
  G.input(ctx, s, 'p1', { play: ['2C', '2D'] });
  G.input(ctx, s, 'p2', { call: true });
  assert.ok(!s.reveal.lie && s.reveal.taker === 'p2');
});

test('color clash: +2 skips and feeds the next player, forgetting "last card" can be caught', () => {
  const G = GAMES.clash, players = ps(3), ctx = mk(players), s = G.init(ctx, players, G.settings({}));
  Object.assign(s, { top: 'R5', color: 'R', turn: 0 });
  s.hands.p0 = ['RD', 'G1', 'B2'];
  const before = s.hands.p1.length;
  G.input(ctx, s, 'p0', { play: 'RD' });
  assert.equal(s.hands.p1.length, before + 2);
  assert.equal(s.players[s.turn], 'p2'); // p1 was skipped
  s.hands.p2 = ['R7', 'Y3'];
  G.input(ctx, s, 'p2', { play: 'R7' }); // down to one card, no "last card"
  assert.equal(s.unsaid, 'p2');
  G.input(ctx, s, 'p1', { catch: 'p2' });
  assert.equal(s.hands.p2.length, 3);
  G.input(ctx, s, 'p0', { play: 'Y3' }); // not in p0's hand
  assert.equal(s.top, 'R7');
});

test('king of the hill: alone scores full, crowded scores half for the one nearest the middle', () => {
  const G = GAMES.hill, players = ps(2), ctx = mk(players), s = G.init(ctx, players, {});
  G.timer({ ...ctx, now: s.deadline }, s);
  Object.assign(s.b[0], { x: 500, y: 500 }); Object.assign(s.b[1], { x: 900, y: 900 });
  G.tick({ ...ctx, now: s.t0 + 50 }, s, 1);
  assert.ok(Math.abs(s.sc[0] - 1) < 0.01 && s.sc[1] === 0);
  Object.assign(s.b[1], { x: 600, y: 500, vx: 0, vy: 0 }); Object.assign(s.b[0], { x: 520, y: 500, vx: 0, vy: 0 });
  G.tick({ ...ctx, now: s.t0 + 100 }, s, 1);
  assert.ok(s.sc[0] > 1.4 && s.sc[0] < 1.6 && s.sc[1] === 0, JSON.stringify(s.sc));
});

test('bumper tag: touching passes IT and freezes the new IT; least time IT wins', () => {
  const G = GAMES.tag, players = ps(3), ctx = mk(players), s = G.init(ctx, players, {});
  G.timer({ ...ctx, now: s.deadline }, s);
  s.it = 0;
  Object.assign(s.b[0], { x: 500, y: 500 }); Object.assign(s.b[1], { x: 560, y: 500 }); Object.assign(s.b[2], { x: 100, y: 100 });
  G.tick({ ...ctx, now: s.t0 + 50 }, s, 0.05);
  assert.equal(s.it, 1);
  assert.ok(s.b[1].stun > s.t0);
  s.sc = [5, 20, 0];
  const pts = G.timer({ ...ctx, now: s.deadline }, s); G.timer({ ...ctx, now: s.deadline }, s);
  const fin = G.timer({ ...ctx, now: s.deadline }, s) ?? pts;
  assert.ok(fin.p2 > fin.p0 && fin.p0 > fin.p1);
});

test('coin rush: a landed dash makes the victim spill coins', () => {
  const G = GAMES.coins, players = ps(2), ctx = mk(players), s = G.init(ctx, players, {});
  G.timer({ ...ctx, now: s.deadline }, s);
  s.c = [];
  s.sc = [0, 5];
  Object.assign(s.b[0], { x: 500, y: 500, dash: s.t0 + 1000 }); Object.assign(s.b[1], { x: 560, y: 500 });
  G.tick({ ...ctx, now: s.t0 + 50 }, s, 0.05);
  assert.equal(s.sc[1], 2);
  assert.ok(s.c.length >= 3);
});

test('light trails: a rider who hits a trail is out; the last one riding takes the round', () => {
  const G = GAMES.trails, TN = 40, players = ps(2), ctx = mk(players), s = G.init(ctx, players, G.settings({}));
  G.timer({ ...ctx, now: s.deadline }, s);
  s.g.fill(0);
  Object.assign(s.r[0], { x: 10, y: 10, d: 1, q: [] }); Object.assign(s.r[1], { x: 20, y: 20, d: 1, q: [] });
  s.g[10 * TN + 11] = 2; // a wall right in front of p0
  G.tick({ ...ctx, now: s.t0 + 100 }, s, 0.1);
  assert.ok(s.r[0].dead && !s.r[1].dead);
  assert.equal(s.wins.p1, 1);
});

test('red light: moving after the grace period on red sends you back', () => {
  const G = GAMES.redlight, players = ps(1), ctx = mk(players), s = G.init(ctx, players, {});
  G.timer({ ...ctx, now: s.deadline }, s);
  Object.assign(s, { light: 'red', redAt: s.t0, lightAt: s.t0 + 10e3 });
  s.pos[0] = 0.6;
  G.input(ctx, s, 'p0', { run: true });
  G.tick({ ...ctx, now: s.t0 + 200 }, s, 0.1); // inside the grace window: no penalty, no progress
  assert.equal(s.pos[0], 0.6);
  G.tick({ ...ctx, now: s.t0 + 600 }, s, 0.1);
  assert.ok(Math.abs(s.pos[0] - 0.2) < 1e-9);
});

test('tug of war: taps are capped at a human rate and the stronger pull wins', () => {
  const G = GAMES.tug, players = ps(2), ctx = mk(players), s = G.init(ctx, players, {});
  G.timer({ ...ctx, now: s.deadline }, s);
  let t = s.deadline;
  for (let k = 0; k < 400 && s.phase === 'play'; k++) { t += 100; G.input({ ...ctx, now: t }, s, 'p1', { t: 6 }); G.tick({ ...ctx, now: t }, s, 0.1); }
  assert.equal(s.winner, 1);
  assert.ok(s.tok[1] <= 4);
});
