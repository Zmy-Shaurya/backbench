// Board, card and dice classics. Same contract as games.js: pure, mutate state, return points when finished.
import { Chess } from 'chess.js';
import { reject, pick, shuffle, int, zero } from './games.js';

// next seat (in `dir`) whose player is still active and passes `ok`
const nextSeat = (ctx, s, dir = 1, ok = () => true) => {
  const n = s.players.length;
  for (let k = 1; k <= n; k++) {
    const j = (((s.turn + dir * k) % n) + n) % n;
    if (ctx.active.includes(s.players[j]) && ok(s.players[j])) return j;
  }
  return s.turn;
};
const byRank = order => Object.fromEntries(order.map((p, i) => [p, Math.round((100 * i) / Math.max(1, order.length - 1))]));

// ───────────── two-player grid duels: Tic-Tac-Toe, Four in a Row ─────────────
function duel(meta, cells, place, wins, moveMs, slots, weight, sloppy) {
  const round = (ctx, s) =>
    Object.assign(s, { round: s.round + 1, turn: s.round % 2, board: Array(cells).fill(null), phase: 'play', line: null, deadline: ctx.now + moveMs });
  const move = (ctx, s, i) => {
    s.board[i] = s.turn;
    s.line = wins(s.board, i);
    if (s.line) s.score[s.players[s.turn]] += 1;
    else if (s.board.every(x => x !== null)) for (const p of s.players) s.score[p] += 0.5;
    else return void Object.assign(s, { turn: 1 - s.turn, deadline: ctx.now + moveMs });
    Object.assign(s, { phase: 'result', deadline: ctx.now + 3000 });
  };
  return {
    ...meta, min: 2, max: 2,
    settings: r => ({ rounds: int(r?.rounds, 1, 5, meta.rounds) }),
    init(ctx, players, st) {
      const s = { players, rounds: st.rounds, round: 0, score: zero(players) };
      round(ctx, s);
      return s;
    },
    input(ctx, s, pid, inp) {
      if (s.phase !== 'play' || s.players[s.turn] !== pid) return;
      const i = place(s.board, inp.at);
      if (i >= 0) move(ctx, s, i);
    },
    timer(ctx, s) {
      if (s.phase === 'play') { // too slow → random legal move
        const opts = [...Array(cells).keys()].map(a => place(s.board, a)).filter(i => i >= 0);
        return void move(ctx, s, pick(ctx.rng, opts));
      }
      if (s.round >= s.rounds || s.players.some(p => s.score[p] > s.rounds / 2)) {
        return Object.fromEntries(s.players.map(p => [p, Math.round((s.score[p] * 100) / s.round)]));
      }
      round(ctx, s);
    },
    status() {},
    bot: (ctx, s, pid) => (s.phase === 'play' && s.players[s.turn] === pid
      ? { input: { at: duelAi(s.board, s.turn, ctx.rng, place, wins, slots, weight, sloppy) }, delay: 700 + ctx.rng() * 900 } : null),
    view: s => ({
      phase: s.phase, round: s.round, rounds: s.rounds, board: s.board, players: s.players,
      turn: s.players[s.turn], line: s.line, score: s.score, deadline: s.deadline,
    }),
  };
}
// win → block → don't hand over a win → best-weighted square (with a little noise; `sloppy` = chance of a random move)
function duelAi(board, me, rng, place, wins, slots, weight, sloppy) {
  const b = [...board], opts = [...Array(slots).keys()].filter(a => place(b, a) >= 0);
  if (rng() < sloppy) return pick(rng, opts);
  const wouldWin = (a, who) => { const i = place(b, a); b[i] = who; const w = wins(b, i); b[i] = null; return !!w; };
  const win = opts.find(a => wouldWin(a, me)) ?? opts.find(a => wouldWin(a, 1 - me));
  if (win != null) return win;
  const safe = opts.filter(a => {
    const i = place(b, a);
    b[i] = me;
    const ok = !opts.some(o => place(b, o) >= 0 && wouldWin(o, 1 - me));
    b[i] = null;
    return ok;
  });
  const pool = safe.length ? safe : opts, scored = pool.map(a => [a, weight(a) + rng() * 1.2]);
  return scored.sort((x, y) => y[1] - x[1])[0][0];
}
const LINES3 = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const tictactoe = duel(
  { name: 'Tic-Tac-Toe', icon: '⭕', secs: 90, rounds: 3, desc: 'Three in a row. Best of 3' }, 9,
  (b, a) => (Number.isInteger(a) && a >= 0 && a < 9 && b[a] === null ? a : -1),
  (b, i) => LINES3.find(l => l.includes(i) && l.every(k => b[k] === b[i])) ?? null,
  20000, 9, a => [2, 1, 2, 1, 3, 1, 2, 1, 2][a], 0.15,
);
const fourInRow = duel(
  { name: 'Four in a Row', icon: '🔴', secs: 240, rounds: 1, desc: 'Drop discs, line up four' }, 42,
  (b, c) => {
    if (!(Number.isInteger(c) && c >= 0 && c < 7)) return -1;
    for (let r = 5; r >= 0; r--) if (b[r * 7 + c] === null) return r * 7 + c;
    return -1;
  },
  (b, i) => {
    const r0 = Math.floor(i / 7), c0 = i % 7;
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      const line = [i];
      for (const sg of [1, -1]) {
        for (let k = 1; ; k++) {
          const r = r0 + dr * k * sg, c = c0 + dc * k * sg;
          if (r < 0 || r > 5 || c < 0 || c > 6 || b[r * 7 + c] !== b[i]) break;
          line.push(r * 7 + c);
        }
      }
      if (line.length >= 4) return line;
    }
    return null;
  },
  30000, 7, c => [1, 2, 3, 4, 3, 2, 1][c], 0.05,
);

// ───────────── Chess (rules by chess.js) ─────────────
const chess = {
  name: 'Chess', icon: '♟️', min: 2, max: 2, secs: 600, desc: 'The classic, with a clock',
  settings: r => ({ minutes: int(r?.minutes, 1, 15, 5) }),
  init(ctx, players, st) {
    const t = st.minutes * 60e3;
    return { players: shuffle(ctx.rng, players), fen: new Chess().fen(), clock: { w: t, b: t }, since: ctx.now, phase: 'play', last: null, result: null, deadline: ctx.now + t };
  },
  input(ctx, s, pid, inp) {
    if (s.phase !== 'play' || !s.players.includes(pid)) return;
    if (inp.resign) return chessOver(ctx, s, s.players.find(p => p !== pid), 'resignation');
    const g = new Chess(s.fen), side = g.turn();
    if (s.players[side === 'w' ? 0 : 1] !== pid) return;
    let mv;
    // ponytail: always promotes to a queen; add a piece picker if underpromotion is ever wanted
    try { mv = g.move({ from: String(inp.from), to: String(inp.to), promotion: 'q' }); } catch { reject('Illegal move'); }
    s.clock[side] -= ctx.now - s.since;
    Object.assign(s, { since: ctx.now, fen: g.fen(), last: { from: mv.from, to: mv.to } });
    if (g.isCheckmate()) return chessOver(ctx, s, pid, 'checkmate');
    if (g.isDraw()) return chessOver(ctx, s, null, g.isStalemate() ? 'stalemate' : 'draw');
    s.deadline = ctx.now + s.clock[g.turn()];
  },
  timer(ctx, s) {
    if (s.phase === 'play') {
      const side = new Chess(s.fen).turn();
      s.clock[side] = 0;
      return chessOver(ctx, s, s.players[side === 'w' ? 1 : 0], 'time');
    }
    return Object.fromEntries(s.players.map(p => [p, !s.result.winner ? 50 : s.result.winner === p ? 100 : 0]));
  },
  status() {},
  view(s, pid) {
    const g = new Chess(s.fen), side = g.turn(), turn = s.players[side === 'w' ? 0 : 1], moves = {};
    if (s.phase === 'play' && turn === pid) for (const m of g.moves({ verbose: true })) (moves[m.from] ||= []).push(m.to);
    return {
      phase: s.phase, fen: s.fen, white: s.players[0], black: s.players[1], players: s.players, turn, side,
      clock: s.clock, since: s.since, last: s.last, check: g.inCheck(), moves, result: s.result, deadline: s.deadline,
    };
  },
};
// Casual engine: 2-ply search (my move, your best reply) on material + centre control. Cheap enough for a DO request.
const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
function evalFen(fen, side) {
  let score = 0, r = 0, f = 0;
  for (const ch of fen.split(' ')[0]) {
    if (ch === '/') { r++; f = 0; continue; }
    if (ch <= '8') { f += +ch; continue; }
    const t = ch.toLowerCase(), white = ch !== t, rank = 7 - r, centre = 3.5 - Math.max(Math.abs(f - 3.5), Math.abs(rank - 3.5));
    let v = VAL[t];
    if (t === 'n' || t === 'b') v += centre * 8;
    else if (t === 'p') v += (white ? rank - 1 : 6 - rank) * 6 + (f > 1 && f < 6 ? centre * 4 : 0);
    else if (t !== 'k') v += centre * 2;
    score += white === (side === 'w') ? v : -v;
    f++;
  }
  return score;
}
export function chessMove(fen, rng) {
  const side = new Chess(fen).turn();
  let best = -Infinity, choice = null;
  for (const m of new Chess(fen).moves({ verbose: true })) {
    let score;
    if (m.san.endsWith('#')) score = 1e6;
    else {
      const replies = new Chess(m.after).moves({ verbose: true });
      score = !replies.length ? 0 // stalemate
        : Math.min(...replies.map(x => (x.san.endsWith('#') ? -1e6 : evalFen(x.after, side))));
    }
    score += rng() * 15;
    if (score > best) { best = score; choice = m; }
  }
  return { from: choice.from, to: choice.to };
}
chess.bot = (ctx, s, pid) => {
  if (s.phase !== 'play') return null;
  const side = new Chess(s.fen).turn();
  return s.players[side === 'w' ? 0 : 1] === pid ? { input: chessMove(s.fen, ctx.rng), delay: 600 + ctx.rng() * 900 } : null;
};
function chessOver(ctx, s, winner, why) {
  Object.assign(s, { phase: 'over', result: { winner, why }, deadline: ctx.now + 6000 });
}

// ───────────── Dots & Boxes ─────────────
const edges = (B, r, c) => { const H = (B + 1) * B; return [r * B + c, (r + 1) * B + c, H + r * (B + 1) + c, H + r * (B + 1) + c + 1]; };
const dots = {
  name: 'Dots & Boxes', icon: '🔲', min: 2, max: 4, secs: 300, desc: 'Close a box, go again',
  settings: r => ({ size: int(r?.size, 3, 6, 4) }),
  init(ctx, players, st) {
    const B = st.size;
    return { players, B, lines: Array(2 * B * (B + 1)).fill(null), boxes: Array(B * B).fill(null), turn: 0, phase: 'play', deadline: ctx.now + 30000 };
  },
  input(ctx, s, pid, inp) {
    const l = int(inp.line, 0, s.lines.length - 1, -1);
    if (s.phase === 'play' && s.players[s.turn] === pid && l >= 0 && s.lines[l] === null) dotsMove(ctx, s, l);
  },
  timer(ctx, s) {
    if (s.phase === 'play') return void dotsMove(ctx, s, pick(ctx.rng, s.lines.map((x, i) => (x === null ? i : -1)).filter(i => i >= 0)));
    const got = s.players.map((_, i) => s.boxes.filter(b => b === i).length), max = Math.max(1, ...got);
    return Object.fromEntries(s.players.map((p, i) => [p, Math.round((got[i] * 100) / max)]));
  },
  status(ctx, s) {
    if (s.phase === 'play' && !ctx.active.includes(s.players[s.turn])) s.turn = nextSeat(ctx, s);
  },
  view: s => ({ phase: s.phase, B: s.B, lines: s.lines, boxes: s.boxes, players: s.players, turn: s.players[s.turn], last: s.last ?? null, deadline: s.deadline }),
};
dots.bot = (ctx, s, pid) => {
  if (s.phase !== 'play' || s.players[s.turn] !== pid) return null;
  const B = s.B, drawn = e => s.lines[e] !== null;
  const adj = Array.from({ length: s.lines.length }, () => []);
  for (let r = 0; r < B; r++) for (let c = 0; c < B; c++) { const e = edges(B, r, c); for (const l of e) adj[l].push(e); }
  const free = s.lines.map((x, i) => (x === null ? i : -1)).filter(i => i >= 0);
  const closes = free.filter(l => adj[l].some(e => e.filter(drawn).length === 3)); // take a free box
  const safe = free.filter(l => adj[l].every(e => e.filter(drawn).length < 2)); // don't set up a box for them
  return { input: { line: pick(ctx.rng, closes.length ? closes : safe.length ? safe : free) }, delay: 600 + ctx.rng() * 800 };
};
function dotsMove(ctx, s, l) {
  s.lines[l] = s.turn;
  s.last = l;
  let got = 0;
  for (let r = 0; r < s.B; r++) {
    for (let c = 0; c < s.B; c++) {
      const k = r * s.B + c;
      if (s.boxes[k] === null && edges(s.B, r, c).every(e => s.lines[e] !== null)) { s.boxes[k] = s.turn; got++; }
    }
  }
  if (s.lines.every(x => x !== null)) return void Object.assign(s, { phase: 'result', deadline: ctx.now + 4000 });
  if (!got) s.turn = nextSeat(ctx, s); // closing a box earns another go
  s.deadline = ctx.now + 30000;
}

// ───────────── Minesweeper (same minefield for everyone) ─────────────
const nbrs = (W, i) => {
  const r = Math.floor(i / W), c = i % W, out = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if ((dr || dc) && r + dr >= 0 && r + dr < W && c + dc >= 0 && c + dc < W) out.push((r + dr) * W + c + dc);
  }
  return out;
};
const mines = {
  name: 'Minesweeper', icon: '💣', min: 1, max: 12, secs: 240, desc: 'Same minefield for everyone. Clear it first',
  settings: r => ({ size: int(r?.size, 8, 16, 9) }),
  init(ctx, players, st) {
    const W = st.size, N = W * W, M = Math.round(N * 0.15), mine = Array(N).fill(false);
    for (const i of shuffle(ctx.rng, [...Array(N).keys()]).slice(0, M)) mine[i] = true;
    const num = mine.map((m, i) => (m ? -1 : nbrs(W, i).filter(j => mine[j]).length));
    const zeros = num.flatMap((n, i) => (n === 0 ? [i] : []));
    const start = zeros.length ? pick(ctx.rng, zeros) : num.findIndex(n => n >= 0); // free opening, same for all
    const s = { players, W, num, safe: N - M, open: {}, flags: {}, done: {}, hit: {}, order: [], phase: 'play', deadline: ctx.now + 240000 };
    for (const p of players) { s.open[p] = Array(N).fill(0); s.flags[p] = []; flood(s, p, start); }
    return s;
  },
  input(ctx, s, pid, inp) {
    if (s.phase !== 'play' || !s.open[pid] || s.done[pid]) return;
    const N = s.W * s.W;
    if (inp.flag != null) {
      const i = int(inp.flag, 0, N - 1, -1), f = s.flags[pid];
      if (i >= 0 && !s.open[pid][i]) f.includes(i) ? f.splice(f.indexOf(i), 1) : f.push(i);
      return;
    }
    let cells = [int(inp.open, 0, N - 1, -1)];
    const c = int(inp.chord, 0, N - 1, -1);
    if (c >= 0) { // click a number whose mines are all flagged: open every other neighbour (classic "chord")
      const around = nbrs(s.W, c);
      if (!s.open[pid][c] || s.num[c] < 1 || around.filter(j => s.flags[pid].includes(j)).length !== s.num[c]) return;
      cells = around.filter(j => !s.open[pid][j] && !s.flags[pid].includes(j));
    }
    for (const i of cells) {
      if (i < 0 || s.open[pid][i] || s.flags[pid].includes(i) || s.done[pid]) continue;
      if (s.num[i] === -1) { s.done[pid] = 'boom'; s.hit[pid] = i; }
      else {
        flood(s, pid, i);
        if (opened(s, pid) === s.safe) { s.done[pid] = 'clear'; s.order.push(pid); }
      }
    }
    if (s.players.filter(p => ctx.active.includes(p)).every(p => s.done[p])) Object.assign(s, { phase: 'result', deadline: ctx.now + 6000 });
  },
  timer(ctx, s) {
    if (s.phase === 'play') return void Object.assign(s, { phase: 'result', deadline: ctx.now + 6000 });
    return Object.fromEntries(s.players.map(p => [p, s.done[p] === 'clear' ? Math.max(50, 100 - 10 * s.order.indexOf(p)) : Math.round((60 * opened(s, p)) / s.safe)]));
  },
  status(ctx, s) {
    if (s.phase === 'play' && s.players.filter(p => ctx.active.includes(p)).every(p => s.done[p])) Object.assign(s, { phase: 'result', deadline: ctx.now + 6000 });
  },
  view(s, pid) {
    const o = s.open[pid], end = s.phase === 'result';
    return {
      phase: s.phase, W: s.W, mines: s.W * s.W - s.safe, deadline: s.deadline, playing: !!o, done: s.done[pid] ?? null, hit: s.hit[pid] ?? null,
      // mines stay hidden until the round ends: it's the same board for everyone
      cells: o ? o.map((x, i) => (x ? s.num[i] : end && s.num[i] === -1 ? 'm' : null)) : null,
      flags: s.flags[pid] ?? [],
      others: s.players.filter(p => p !== pid).map(p => ({ pid: p, pct: Math.round((100 * opened(s, p)) / s.safe), done: s.done[p] ?? null })),
    };
  },
};
const opened = (s, p) => s.open[p].reduce((a, b) => a + b, 0);
function flood(s, p, i) {
  const o = s.open[p], stack = [i];
  while (stack.length) {
    const j = stack.pop();
    if (o[j]) continue;
    o[j] = 1;
    if (s.num[j] === 0) stack.push(...nbrs(s.W, j).filter(k => !o[k]));
  }
}

export const CLASSICS = { chess, four_row: fourInRow, tictactoe, dots, mines };
