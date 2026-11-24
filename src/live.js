// Real-time games. While one is running the Room calls tick() `rt` times a second and broadcasts frame() to every
// socket. Inputs only set steering: no snapshot, no storage write. Phases still change through timer()/s.deadline,
// and a game sets s.dirty when something snapshot-worthy happens (a goal, a knock-out, a finish).
// Computer players are steered inside tick(): ctx.bots lists them.
import { int, zero, pick } from './games.js';
import { PASSAGES } from './content.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, lo, hi, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : d);
const R = Math.round;
const hash = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const skill = pid => 0.75 + (hash(pid) % 20) / 100; // computer players: 0.75–0.94 of full speed
const isBot = (ctx, p) => (ctx.bots ?? []).includes(p);
const noPlan = () => null; // bots steer inside tick(), never through timed moves
const roundsSetting = r => ({ rounds: int(r?.rounds, 1, 9, 3) });

// joystick input shared by the disc games: {x, y} in [-1, 1], plus a one-shot action (dash / kick)
function stick(s, pid, inp, action) {
  const m = (s.in[pid] ||= { x: 0, y: 0, act: false });
  const x = num(inp.x, -1, 1), y = num(inp.y, -1, 1), l = Math.hypot(x, y);
  [m.x, m.y] = l > 1 ? [x / l, y / l] : [x, y];
  if (inp[action] === true) m.act = true;
}
// discs that accelerate with their stick, glide, and bounce off each other
function moveDiscs(list, ins, h, accel, drag) {
  for (const [b, m] of list.map((b, i) => [b, ins[i] ?? { x: 0, y: 0 }])) {
    if (b.out) continue;
    b.vx += m.x * accel * h; b.vy += m.y * accel * h;
    b.vx *= 1 - drag * h; b.vy *= 1 - drag * h;
    b.x += b.vx * h; b.y += b.vy * h;
  }
}
function bump(list, rad, bounce) {
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], c = list[j];
    if (a.out || c.out) continue;
    const dx = a.x - c.x, dy = a.y - c.y, d = Math.hypot(dx, dy);
    if (d >= 2 * rad || d === 0) continue;
    const nx = dx / d, ny = dy / d, push = (2 * rad - d) / 2;
    a.x += nx * push; a.y += ny * push; c.x -= nx * push; c.y -= ny * push;
    const rel = (a.vx - c.vx) * nx + (a.vy - c.vy) * ny;
    if (rel < 0) { const j2 = -bounce * rel; a.vx += j2 * nx; a.vy += j2 * ny; c.vx -= j2 * nx; c.vy -= j2 * ny; }
  }
}
const dashing = (ctx, b, m, power) => {
  if (!m?.act) return;
  m.act = false;
  if (ctx.now < b.cd) return;
  const l = Math.hypot(m.x, m.y) || 1;
  b.vx += (m.x / l) * power; b.vy += (m.y / l) * power;
  b.cd = ctx.now + 1800; b.dash = ctx.now + 250;
};

// ───────────── shared round flow: ready (3 s) → play → gap (3 s) → … → over (4 s) → points ─────────────
function rounds(meta, g) {
  const startRound = (ctx, s) => {
    s.round++;
    s.in = {};
    g.setup(ctx, s);
    Object.assign(s, { phase: 'ready', deadline: ctx.now + 3000, winner: null, t0: null });
  };
  const endRound = (ctx, s, winner) => { // best of `rounds`
    if (winner) s.wins[winner]++;
    const done = Math.max(...Object.values(s.wins)) > s.rounds / 2 || s.round >= s.rounds;
    Object.assign(s, { winner, phase: done ? 'over' : 'gap', deadline: ctx.now + (done ? 4000 : 3000), dirty: true });
  };
  return {
    ...meta,
    rt: g.rt,
    settings: roundsSetting,
    init(ctx, players, st) {
      const s = { players, rounds: st.rounds, round: 0, wins: zero(players), in: {} };
      startRound(ctx, s);
      return s;
    },
    input(ctx, s, pid, inp) {
      if (s.players.includes(pid)) g.steer(s, pid, inp, ctx);
    },
    timer(ctx, s) {
      if (s.phase === 'ready') return void Object.assign(s, { phase: 'play', t0: ctx.now, deadline: ctx.now + g.secs * 1000 });
      if (s.phase === 'play') return endRound(ctx, s, g.leader(s));
      if (s.phase === 'gap') return startRound(ctx, s);
      const top = Math.max(1, ...Object.values(s.wins));
      return Object.fromEntries(s.players.map(p => [p, R((100 * s.wins[p]) / top)]));
    },
    tick(ctx, s, dt) {
      if (s.phase !== 'play') return;
      s.now = ctx.now;
      for (const p of s.players) if (isBot(ctx, p)) g.bot(ctx, s, p);
      g.step(ctx, s, dt);
      const alive = g.alive(s);
      if (alive.length <= (s.players.length > 1 ? 1 : 0)) endRound(ctx, s, alive[0] ?? null);
    },
    status() {},
    frame: g.frame,
    view: s => ({ phase: s.phase, players: s.players, round: s.round, rounds: s.rounds, wins: s.wins, winner: s.winner, deadline: s.deadline, ends: s.phase === 'play' ? s.deadline : null }),
    bot: noPlan,
  };
}

// ───────────── Sumo Bumpers: shove everyone else out of a shrinking ring ─────────────
const ARENA = 440, BODY = 40, C = 500;
const sumo = rounds({ name: 'Sumo Bumpers', icon: '🫧', min: 2, max: 8, secs: 120, desc: 'Live! Bump everyone out of the shrinking ring' }, {
  rt: 20, secs: 45,
  setup(ctx, s) {
    const n = s.players.length, a0 = ctx.rng() * 7;
    s.b = s.players.map((p, i) => {
      const a = a0 + (i * 2 * Math.PI) / n;
      return { x: C + Math.cos(a) * 260, y: C + Math.sin(a) * 260, vx: 0, vy: 0, out: 0, cd: 0, dash: 0 };
    });
    s.ring = ARENA;
  },
  steer: (s, pid, inp) => stick(s, pid, inp, 'dash'),
  step(ctx, s, dt) {
    s.ring = Math.max(200, ARENA - Math.max(0, (ctx.now - s.t0) / 1000 - 12) * 9); // shrinks after 12 s so nobody can camp
    const ins = s.players.map(p => s.in[p]);
    s.b.forEach((b, i) => !b.out && dashing(ctx, b, ins[i], 650));
    for (let k = 0; k < 2; k++) { moveDiscs(s.b, ins, dt / 2, 1500, 1.7); bump(s.b, BODY, 1.25); }
    s.b.forEach(b => { if (!b.out && Math.hypot(b.x - C, b.y - C) > s.ring) { b.out = ctx.now; s.dirty = true; } });
  },
  alive: s => s.players.filter((p, i) => !s.b[i].out),
  leader: s => { // time up: whoever is closest to the middle
    const alive = s.players.map((p, i) => [p, s.b[i]]).filter(([, b]) => !b.out);
    return alive.sort((x, y) => Math.hypot(x[1].x - C, x[1].y - C) - Math.hypot(y[1].x - C, y[1].y - C))[0]?.[0] ?? null;
  },
  bot(ctx, s, pid) {
    const i = s.players.indexOf(pid), me = s.b[i];
    if (me.out) return;
    const tgt = s.b.filter((b, j) => j !== i && !b.out).sort((x, y) => Math.hypot(x.x - me.x, x.y - me.y) - Math.hypot(y.x - me.x, y.y - me.y))[0];
    if (!tgt) return;
    let x = tgt.x - me.x, y = tgt.y - me.y;
    const d = Math.hypot(x, y) || 1, fromC = Math.hypot(me.x - C, me.y - C);
    x /= d; y /= d;
    if (fromC > s.ring - 130) { x += ((C - me.x) / fromC) * 1.6; y += ((C - me.y) / fromC) * 1.6; } // back off the edge
    const k = skill(pid) / (Math.hypot(x, y) || 1), m = (s.in[pid] ||= { x: 0, y: 0, act: false });
    m.x = x * k; m.y = y * k;
    if (d < 170 && Math.hypot(tgt.x - C, tgt.y - C) > fromC && ctx.rng() < 0.08) m.act = true;
  },
  // [x, y, out, dashing, dash ready]
  frame: s => ({ ring: R(s.ring), b: s.b.map(b => [R(b.x), R(b.y), b.out ? 1 : 0, b.dash > s.now ? 1 : 0, b.cd > s.now ? 0 : 1]) }),
});

// ───────────── grid games: up / right / down / left, one cell per tick ─────────────
const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
// a short turn queue, so two quick swipes inside one tick both count (and a U-turn is never accepted)
function queueTurn(q, cur, d) {
  const last = q.length ? q.at(-1) : cur;
  if (d < 0 || d === last || d === (last + 2) % 4 || q.length >= 2) return;
  q.push(d);
}

// ───────────── Snake Battle: classic snakes on one grid, last one slithering wins ─────────────
const N = 32;
const snake = rounds({ name: 'Snake Battle', icon: '🐍', min: 2, max: 8, secs: 150, desc: 'Live! Eat, grow, and cut everyone off' }, {
  rt: 8, secs: 60,
  setup(ctx, s) {
    const n = s.players.length, a0 = ctx.rng() * 7;
    s.sn = s.players.map((p, i) => {
      const a = a0 + (i * 2 * Math.PI) / n, hx = R(N / 2 + Math.cos(a) * 10), hy = R(N / 2 + Math.sin(a) * 10);
      const dx = N / 2 - hx, dy = N / 2 - hy, d = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0;
      const [ox, oy] = DIRS[d];
      return { body: [0, 1, 2, 3].map(k => (hy - oy * k) * N + (hx - ox * k)), d, q: [], grow: 0, dead: 0 };
    });
    s.food = [];
    feed(ctx, s);
  },
  steer(s, pid, inp) {
    const sn = s.sn[s.players.indexOf(pid)];
    if (sn && !sn.dead) queueTurn(sn.q, sn.d, int(inp.d, 0, 3, -1));
  },
  step(ctx, s) {
    const live = s.sn.filter(x => !x.dead);
    for (const x of live) {
      if (x.q.length) x.d = x.q.shift();
      const hx = (x.body[0] % N) + DIRS[x.d][0], hy = Math.floor(x.body[0] / N) + DIRS[x.d][1];
      x.head = hx < 0 || hy < 0 || hx >= N || hy >= N ? -1 : hy * N + hx;
      const f = s.food.indexOf(x.head);
      if (f >= 0) { s.food.splice(f, 1); x.grow += 2; }
      x.body.unshift(x.head);
      if (x.grow > 0) x.grow--; else x.body.pop(); // tails move first, so you can chase your own
    }
    const busy = new Map(); // head-on, head-into-body and swaps all show up as a cell used twice
    for (const x of live) for (const c of x.body) busy.set(c, (busy.get(c) ?? 0) + 1);
    for (const x of live.filter(y => y.head < 0 || busy.get(y.head) > 1)) {
      x.dead = ctx.now; s.dirty = true;
      x.body.slice(1).forEach((c, k) => k % 2 || s.food.includes(c) || s.food.push(c)); // the wreck becomes snacks
      x.body = [];
    }
    feed(ctx, s);
  },
  alive: s => s.players.filter((p, i) => !s.sn[i].dead),
  leader: s => s.players.map((p, i) => [p, s.sn[i]]).filter(([, x]) => !x.dead).sort((a, b) => b[1].body.length - a[1].body.length)[0]?.[0] ?? null,
  bot(ctx, s, pid) {
    const me = s.sn[s.players.indexOf(pid)];
    if (me.dead || me.q.length) return;
    const busy = new Set(s.sn.flatMap(x => x.body)), hx = me.body[0] % N, hy = Math.floor(me.body[0] / N);
    const free = (x, y) => x >= 0 && y >= 0 && x < N && y < N && !busy.has(y * N + x);
    const opts = [0, 1, 2, 3].filter(d => d !== (me.d + 2) % 4).map(d => {
      const x = hx + DIRS[d][0], y = hy + DIRS[d][1];
      if (!free(x, y)) return [d, -1e9];
      const room = DIRS.filter(([a, b]) => free(x + a, y + b)).length;
      const food = Math.min(99, ...s.food.map(f => Math.abs((f % N) - x) + Math.abs(Math.floor(f / N) - y)));
      return [d, room * 3 - food * skill(pid) + ctx.rng()];
    });
    const d = opts.sort((a, b) => b[1] - a[1])[0][0];
    if (d !== me.d) me.q.push(d);
  },
  frame: s => ({ sn: s.sn.map(x => x.body), food: s.food }),
});
function feed(ctx, s) {
  const busy = new Set(s.sn.flatMap(x => x.body));
  for (let tries = 0; s.food.length < s.players.length + 3 && tries < 200; tries++) {
    const c = Math.floor(ctx.rng() * N * N);
    if (!busy.has(c) && !s.food.includes(c)) s.food.push(c);
  }
}

// ───────────── Land Grab: leave your land, draw a loop, come home to claim everything inside ─────────────
// Cross someone's trail and they're out; touch your own and you are. Out = your land is gone, back in 2 s.
const LN = 36;
const land = {
  name: 'Land Grab', icon: '🗺️', min: 2, max: 8, secs: 100, desc: 'Live! Loop out and back to claim land. Cut their trails', rt: 8,
  settings: () => ({}),
  init(ctx, players) {
    const s = { players, own: Array(LN * LN).fill(0), p: players.map(() => ({ x: 0, y: 0, d: 0, q: [], trail: [], out: 0, back: 0, plan: 0 })), phase: 'ready', deadline: ctx.now + 3000 };
    s.p.forEach((pl, i) => spawn(ctx, s, i));
    return s;
  },
  input(ctx, s, pid, inp) {
    const pl = s.p[s.players.indexOf(pid)];
    if (pl && !pl.out) queueTurn(pl.q, pl.d, int(inp.d, 0, 3, -1));
  },
  timer(ctx, s) {
    if (s.phase === 'ready') return void Object.assign(s, { phase: 'play', deadline: ctx.now + 75e3 });
    if (s.phase === 'play') return void Object.assign(s, { phase: 'over', deadline: ctx.now + 4000 });
    const got = s.players.map((_, i) => s.own.filter(c => c === i + 1).length), top = Math.max(1, ...got);
    return Object.fromEntries(s.players.map((p, i) => [p, R((100 * got[i]) / top)]));
  },
  tick(ctx, s) {
    if (s.phase !== 'play') return;
    s.players.forEach((p, i) => { const pl = s.p[i]; if (pl.out && ctx.now >= pl.back) spawn(ctx, s, i); else if (!pl.out && isBot(ctx, p)) landBot(ctx, s, i); });
    const live = s.p.map((pl, i) => [pl, i]).filter(([pl]) => !pl.out), heads = new Map(), kill = new Set();
    for (const [pl] of live) {
      if (pl.q.length) pl.d = pl.q.shift();
      pl.x += DIRS[pl.d][0]; pl.y += DIRS[pl.d][1];
      heads.set(pl.y * LN + pl.x, [...(heads.get(pl.y * LN + pl.x) ?? []), pl]);
    }
    for (const [pl, i] of live) {
      const c = pl.y * LN + pl.x;
      if (pl.x < 0 || pl.y < 0 || pl.x >= LN || pl.y >= LN) { kill.add(i); continue; }
      if (heads.get(c).length > 1) { kill.add(i); continue; } // head-on
      s.p.forEach((o, j) => { if (!o.out && o.trail.includes(c)) kill.add(j); }); // cut a trail: its owner is out (your own too)
    }
    for (const [pl, i] of live) {
      if (kill.has(i)) continue;
      const c = pl.y * LN + pl.x;
      if (s.own[c] === i + 1) { if (pl.trail.length) claim(s, i); }
      else pl.trail.push(c);
    }
    for (const i of kill) { const pl = s.p[i]; pl.out = ctx.now; pl.back = ctx.now + 2000; pl.trail = []; s.own = s.own.map(o => (o === i + 1 ? 0 : o)); s.dirty = true; }
  },
  status() {},
  frame: s => ({ g: s.own.map(o => o.toString(36)).join(''), p: s.p.map(pl => (pl.out ? [] : [pl.x, pl.y, pl.d, ...pl.trail])) }),
  view: s => ({ phase: s.phase, players: s.players, deadline: s.deadline, ends: s.phase === 'play' ? s.deadline : null }),
  bot: noPlan,
};
function spawn(ctx, s, i) { // a 3×3 home somewhere empty, as far from the action as we can find quickly
  let best = null;
  for (let k = 0; k < 40; k++) {
    const x = 2 + Math.floor(ctx.rng() * (LN - 4)), y = 2 + Math.floor(ctx.rng() * (LN - 4));
    let clear = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) clear += s.own[(y + dy) * LN + x + dx] === 0;
    if (!best || clear > best[2]) best = [x, y, clear];
  }
  const [x, y] = best;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s.own[(y + dy) * LN + x + dx] = i + 1;
  Object.assign(s.p[i], { x, y, d: Math.floor(ctx.rng() * 4), q: [], trail: [], out: 0, plan: 0 });
  s.dirty = true;
}
function claim(s, i) { // trail becomes land, then everything the outside can't reach becomes land too
  const me = i + 1, p = s.p[i];
  for (const c of p.trail) s.own[c] = me;
  p.trail = [];
  const seen = new Uint8Array(LN * LN), stack = [];
  for (let k = 0; k < LN; k++) stack.push(k, (LN - 1) * LN + k, k * LN, k * LN + LN - 1);
  while (stack.length) {
    const c = stack.pop();
    if (seen[c] || s.own[c] === me) continue;
    seen[c] = 1;
    const x = c % LN, y = Math.floor(c / LN);
    if (x > 0) stack.push(c - 1);
    if (x < LN - 1) stack.push(c + 1);
    if (y > 0) stack.push(c - LN);
    if (y < LN - 1) stack.push(c + LN);
  }
  for (let c = 0; c < LN * LN; c++) if (!seen[c] && s.own[c] !== me) s.own[c] = me;
  s.dirty = true;
}
function landBot(ctx, s, i) {
  const pl = s.p[i], me = i + 1;
  if (pl.q.length) return;
  const ok = d => { const x = pl.x + DIRS[d][0], y = pl.y + DIRS[d][1]; return x >= 0 && y >= 0 && x < LN && y < LN && !pl.trail.includes(y * LN + x); };
  const turns = [0, 1, 2, 3].filter(d => d !== (pl.d + 2) % 4 && ok(d));
  if (!turns.length) return;
  let want = pl.d;
  if (pl.trail.length >= 5 + (hash(s.players[i]) % 6)) { // far enough out: head for the nearest bit of home
    let best = 1e9;
    for (let c = 0; c < LN * LN; c++) if (s.own[c] === me) { const d = Math.abs((c % LN) - pl.x) + Math.abs(Math.floor(c / LN) - pl.y); if (d < best) { best = d; want = Math.abs((c % LN) - pl.x) > Math.abs(Math.floor(c / LN) - pl.y) ? ((c % LN) > pl.x ? 1 : 3) : Math.floor(c / LN) > pl.y ? 2 : 0; } }
  } else if (pl.trail.length && pl.trail.length % 4 === 0 && ctx.rng() < 0.7) want = (pl.d + (ctx.rng() < 0.5 ? 1 : 3)) % 4; // bend the loop
  else if (!pl.trail.length && ctx.rng() < 0.15) want = Math.floor(ctx.rng() * 4);
  const d = turns.includes(want) ? want : turns[Math.floor(ctx.rng() * turns.length)];
  if (d !== pl.d) pl.q.push(d);
}

// ───────────── Paint Grab: roll over the floor to paint it your colour ─────────────
const PG = 30, PCELL = 1000 / PG, PBODY = 30;
const paint = {
  name: 'Paint Grab', icon: '🎨', min: 2, max: 8, secs: 80, desc: 'Live! Paint the most floor in 60 s. Bump to steal', rt: 15,
  settings: () => ({}),
  init(ctx, players) {
    const n = players.length, a0 = ctx.rng() * 7;
    const b = players.map((p, i) => { const a = a0 + (i * 2 * Math.PI) / n; return { x: 500 + Math.cos(a) * 320, y: 500 + Math.sin(a) * 320, vx: 0, vy: 0, cd: 0, dash: 0 }; });
    return { players, b, grid: Array(PG * PG).fill(0), in: {}, phase: 'ready', deadline: ctx.now + 3000, tgt: {} };
  },
  input(ctx, s, pid, inp) { if (s.players.includes(pid)) stick(s, pid, inp, 'dash'); },
  timer(ctx, s) {
    if (s.phase === 'ready') return void Object.assign(s, { phase: 'play', deadline: ctx.now + 60e3 });
    if (s.phase === 'play') return void Object.assign(s, { phase: 'over', deadline: ctx.now + 4000 });
    const got = s.players.map((_, i) => s.grid.filter(c => c === i + 1).length), top = Math.max(1, ...got);
    return Object.fromEntries(s.players.map((p, i) => [p, R((100 * got[i]) / top)]));
  },
  tick(ctx, s, dt) {
    if (s.phase !== 'play') return;
    s.now = ctx.now;
    s.players.forEach((p, i) => isBot(ctx, p) && paintBot(ctx, s, p, i));
    const ins = s.players.map(p => s.in[p]);
    s.b.forEach((b, i) => dashing(ctx, b, ins[i], 600));
    for (let k = 0; k < 2; k++) {
      moveDiscs(s.b, ins, dt / 2, 1700, 2.2);
      bump(s.b, PBODY, 1.3);
      for (const b of s.b) { // walls
        if (b.x < PBODY || b.x > 1000 - PBODY) { b.x = clamp(b.x, PBODY, 1000 - PBODY); b.vx *= -0.6; }
        if (b.y < PBODY || b.y > 1000 - PBODY) { b.y = clamp(b.y, PBODY, 1000 - PBODY); b.vy *= -0.6; }
      }
    }
    s.b.forEach((b, i) => {
      const c0 = Math.floor(b.x / PCELL), r0 = Math.floor(b.y / PCELL);
      for (let r = r0 - 1; r <= r0 + 1; r++) for (let c = c0 - 1; c <= c0 + 1; c++) {
        if (r >= 0 && c >= 0 && r < PG && c < PG && Math.hypot((c + 0.5) * PCELL - b.x, (r + 0.5) * PCELL - b.y) < PBODY + 6) s.grid[r * PG + c] = i + 1;
      }
    });
  },
  status() {},
  frame: s => ({ g: s.grid.join(''), b: s.b.map(b => [R(b.x), R(b.y), b.dash > s.now ? 1 : 0, b.cd > s.now ? 0 : 1]) }),
  view: s => ({ phase: s.phase, players: s.players, deadline: s.deadline, ends: s.phase === 'play' ? s.deadline : null }),
  bot: noPlan,
};
function paintBot(ctx, s, pid, i) {
  const me = s.b[i], m = (s.in[pid] ||= { x: 0, y: 0, act: false });
  let t = s.tgt[pid];
  if (!t || s.grid[t] === i + 1 || ctx.rng() < 0.02) { // pick the best of a few nearby cells that aren't ours yet
    let best = -1e9;
    for (let k = 0; k < 24; k++) {
      const c = Math.floor(ctx.rng() * PG * PG), d = Math.hypot((c % PG + 0.5) * PCELL - me.x, (Math.floor(c / PG) + 0.5) * PCELL - me.y);
      const v = (s.grid[c] === i + 1 ? -500 : s.grid[c] ? 60 : 0) - d;
      if (v > best) { best = v; t = c; }
    }
    s.tgt[pid] = t;
  }
  const dx = (t % PG + 0.5) * PCELL - me.x, dy = (Math.floor(t / PG) + 0.5) * PCELL - me.y, d = Math.hypot(dx, dy) || 1;
  m.x = (dx / d) * skill(pid); m.y = (dy / d) * skill(pid);
}

// ───────────── Kickabout: live football, two teams, joystick + kick ─────────────
const FW = 1600, FH = 1000, MOUTH = 140, PR = 30, BR = 18;
const kickabout = {
  name: 'Kickabout', icon: '⚽', min: 2, max: 8, secs: 200, desc: 'Live football! Two teams, joystick and a kick', rt: 20,
  settings: r => ({ minutes: int(r?.minutes, 1, 5, 2) }),
  init(ctx, players, st) {
    const s = { players, team: players.map((p, i) => i % 2), goals: [0, 0], mins: st.minutes, in: {}, phase: 'ready', deadline: ctx.now + 3000, cd: {} };
    kickoff(s, 0);
    return s;
  },
  input(ctx, s, pid, inp) { if (s.players.includes(pid)) stick(s, pid, inp, 'kick'); },
  timer(ctx, s) {
    if (s.phase === 'ready') return void Object.assign(s, { phase: 'play', deadline: ctx.now + s.mins * 60e3 });
    if (s.phase === 'play') return void Object.assign(s, { phase: 'over', deadline: ctx.now + 4000 });
    const [a, b] = s.goals;
    return Object.fromEntries(s.players.map((p, i) => { const t = s.team[i], mine = t ? b : a, theirs = t ? a : b; return [p, mine > theirs ? 100 : mine === theirs ? 50 : 20 + 5 * mine]; }));
  },
  tick(ctx, s, dt) {
    if (s.phase !== 'play') return;
    s.now = ctx.now;
    s.players.forEach((p, i) => isBot(ctx, p) && footBot(ctx, s, p, i));
    const ins = s.players.map(p => s.in[p]), ball = s.ball, frozen = ctx.now < s.pause;
    s.p.forEach((pl, i) => { // kick: only when the ball is at your feet
      const m = ins[i];
      if (!m?.act) return;
      m.act = false;
      const dx = ball.x - pl.x, dy = ball.y - pl.y, d = Math.hypot(dx, dy);
      if (frozen || d > PR + BR + 18 || ctx.now < (s.cd[i] ?? 0)) return;
      const kx = dx / d + m.x * 1.5, ky = dy / d + m.y * 1.5, kl = Math.hypot(kx, ky) || 1; // the ball goes where your stick points
      ball.vx = (kx / kl) * 980 + pl.vx * 0.3; ball.vy = (ky / kl) * 980 + pl.vy * 0.3;
      s.cd[i] = ctx.now + 300; s.kick = ctx.now;
    });
    for (let k = 0; k < 3; k++) {
      const h = dt / 3;
      if (!frozen) moveDiscs(s.p, ins, h, 1400, 2.8);
      bump(s.p, PR, 0.6);
      for (const pl of s.p) { pl.x = clamp(pl.x, PR, FW - PR); pl.y = clamp(pl.y, PR, FH - PR); }
      if (frozen) continue;
      ball.vx *= 1 - 0.8 * h; ball.vy *= 1 - 0.8 * h;
      ball.x += ball.vx * h; ball.y += ball.vy * h;
      for (const pl of s.p) { // dribble: players shove the ball along
        const dx = ball.x - pl.x, dy = ball.y - pl.y, d = Math.hypot(dx, dy);
        if (d >= PR + BR || d === 0) continue;
        const nx = dx / d, ny = dy / d;
        ball.x = pl.x + nx * (PR + BR); ball.y = pl.y + ny * (PR + BR);
        const rel = (ball.vx - pl.vx) * nx + (ball.vy - pl.vy) * ny;
        if (rel < 0) { ball.vx -= 1.5 * rel * nx; ball.vy -= 1.5 * rel * ny; }
      }
      if (ball.y < BR) { ball.y = BR; ball.vy = Math.abs(ball.vy) * 0.8; }
      if (ball.y > FH - BR) { ball.y = FH - BR; ball.vy = -Math.abs(ball.vy) * 0.8; }
      const mouth = Math.abs(ball.y - FH / 2) < MOUTH;
      if (ball.x < BR && !mouth) { ball.x = BR; ball.vx = Math.abs(ball.vx) * 0.8; }
      if (ball.x > FW - BR && !mouth) { ball.x = FW - BR; ball.vx = -Math.abs(ball.vx) * 0.8; }
      if (ball.x < -BR || ball.x > FW + BR) { // goal: the left net belongs to team 0
        const scorer = ball.x < 0 ? 1 : 0;
        s.goals[scorer]++;
        Object.assign(s, { dirty: true, scored: scorer });
        kickoff(s, 1 - scorer);
        s.pause = ctx.now + 1800;
        break;
      }
    }
  },
  status() {},
  frame: s => ({ k: [R(s.ball.x), R(s.ball.y)], p: s.p.map(p => [R(p.x), R(p.y)]), z: s.pause > s.now ? 1 : 0 }),
  view: s => ({ phase: s.phase, players: s.players, team: s.team, goals: s.goals, scored: s.scored ?? null, deadline: s.deadline, ends: s.phase === 'play' ? s.deadline : null }),
  bot: noPlan,
};
function kickoff(s) {
  const spots = [[0.3, 0.5], [0.2, 0.25], [0.2, 0.75], [0.1, 0.5]]; // per team, mirrored for team 1
  const seen = [0, 0];
  s.p = s.players.map((p, i) => {
    const t = s.team[i], [fx, fy] = spots[seen[t]++ % 4];
    return { x: t ? FW * (1 - fx) : FW * fx, y: FH * fy, vx: 0, vy: 0 };
  });
  s.ball = { x: FW / 2, y: FH / 2 + (Math.random() - 0.5) * 6, vx: 0, vy: 0 }; // a hair off-centre: no perfect stalemates
}
function footBot(ctx, s, pid, i) {
  const me = s.p[i], b = s.ball, t = s.team[i], m = (s.in[pid] ||= { x: 0, y: 0, act: false });
  const gx = t ? 0 : FW, ownX = t ? FW : 0, dist = q => Math.hypot(q.x - b.x, q.y - b.y);
  const mates = s.p.filter((q, j) => j !== i && s.team[j] === t), closer = mates.some(q => dist(q) + 60 < dist(me));
  let tx, ty;
  if (closer) { tx = ownX + (b.x - ownX) * 0.45; ty = FH / 2 + (b.y - FH / 2) * 0.6; } // cover the goal
  else {
    const dx = gx - b.x, dy = FH / 2 - b.y, d = Math.hypot(dx, dy) || 1;
    const side = ((hash(pid) % 2) * 2 - 1) * 26; // approach a little off-centre so two bots don't lock horns
    tx = b.x - (dx / d) * (PR + BR + 4) - (dy / d) * side; ty = b.y - (dy / d) * (PR + BR + 4) + (dx / d) * side; // behind the ball
    const toBall = Math.hypot(b.x - me.x, b.y - me.y) || 1;
    if (toBall < PR + BR + 14 && ctx.rng() < 0.25) { m.x = dx / d; m.y = dy / d; m.act = true; return; } // shoot at their goal
  }
  const dx = tx - me.x, dy = ty - me.y, d = Math.hypot(dx, dy);
  const k = d < 20 ? 0 : skill(pid) * Math.min(1, d / 120);
  m.x = (dx / (d || 1)) * k; m.y = (dy / (d || 1)) * k;
}

// ───────────── Type Race: type the passage, your car is your progress ─────────────
const wpmOf = (chars, ms) => (ms > 0 ? R((chars / 5) / (ms / 60000)) : 0);
const typeRace = {
  name: 'Type Race', icon: '🏎️', min: 1, max: 12, secs: 120, desc: 'Live! Type the passage. Fastest fingers win', rt: 5,
  settings: () => ({}),
  init(ctx, players) {
    return { players, text: pick(ctx.rng, PASSAGES), prog: zero(players), fin: {}, last: {}, phase: 'ready', deadline: ctx.now + 5000 };
  },
  input(ctx, s, pid, inp) {
    if (s.phase !== 'play' || !(pid in s.prog) || pid in s.fin) return;
    const p = int(inp.p, 0, s.text.length, -1);
    if (p <= s.prog[pid]) return;
    const cap = s.prog[pid] + ((ctx.now - (s.last[pid] ?? s.t0)) / 1000) * 22 + 6; // nobody types faster than ~260 wpm
    s.prog[pid] = Math.min(p, Math.floor(cap));
    s.last[pid] = ctx.now;
    raceCheck(ctx, s, pid);
  },
  timer(ctx, s) {
    if (s.phase === 'ready') return void Object.assign(s, { phase: 'play', t0: ctx.now, deadline: ctx.now + 150e3 });
    if (s.phase === 'play') return void Object.assign(s, { phase: 'over', deadline: ctx.now + 6000 });
    const order = Object.keys(s.fin).sort((a, b) => s.fin[a] - s.fin[b]);
    return Object.fromEntries(s.players.map(p => [p, p in s.fin ? Math.max(55, 100 - 15 * order.indexOf(p)) : R((50 * s.prog[p]) / s.text.length)]));
  },
  tick(ctx, s, dt) {
    if (s.phase !== 'play') return;
    s.now = ctx.now;
    for (const p of s.players) {
      if (!isBot(ctx, p) || p in s.fin) continue;
      s.prog[p] = Math.min(s.text.length, s.prog[p] + ((32 + (hash(p) % 45)) * 5 / 60) * dt * (0.7 + ctx.rng() * 0.6)); // 32–76 wpm
      raceCheck(ctx, s, p);
    }
  },
  status(ctx, s) { if (s.phase === 'play' && s.players.filter(p => ctx.active.includes(p)).every(p => p in s.fin)) Object.assign(s, { phase: 'over', deadline: ctx.now + 6000, dirty: true }); },
  frame: s => ({ p: s.players.map(p => R(s.prog[p])), w: s.players.map(p => (p in s.fin ? wpmOf(s.text.length, s.fin[p]) : wpmOf(s.prog[p], (s.now ?? 0) - s.t0))) }),
  view: s => ({ phase: s.phase, players: s.players, text: s.text, fin: s.fin, deadline: s.deadline, ends: s.phase === 'play' ? s.deadline : null, len: s.text.length }),
  bot: noPlan,
};
function raceCheck(ctx, s, p) {
  if (s.prog[p] < s.text.length || p in s.fin) return;
  s.fin[p] = ctx.now - s.t0;
  s.dirty = true;
  if (s.players.every(q => q in s.fin)) Object.assign(s, { phase: 'over', deadline: ctx.now + 6000 });
}

// ───────────── Air Hockey: 1v1, drag your mallet, first to 7 ─────────────
const TW = 600, TH = 1000, PUCK = 28, MALLET = 46, GOALW = 115, TO = 7, MAXPUCK = 1500;
const hockey = {
  name: 'Air Hockey', icon: '🏒', min: 2, max: 2, secs: 150, desc: 'Live! Drag your mallet and smash it in', rt: 30,
  settings: () => ({}),
  init(ctx, players) {
    const s = { players, goals: zero(players), phase: 'ready', deadline: ctx.now + 3000, pause: 0 };
    s.m = [{ x: TW / 2, y: TH - 120 }, { x: TW / 2, y: 120 }].map(m => ({ ...m, tx: m.x, ty: m.y, vx: 0, vy: 0 }));
    resetPuck(s, 0, 0);
    return s;
  },
  input(ctx, s, pid, inp) {
    const i = s.players.indexOf(pid);
    if (i >= 0) aim(s, i, num(inp.x, 0, TW), num(inp.y, 0, TH));
  },
  timer(ctx, s) {
    if (s.phase === 'ready') return void Object.assign(s, { phase: 'play', deadline: ctx.now + 120e3 });
    if (s.phase === 'play') return void Object.assign(s, { phase: 'over', deadline: ctx.now + 4000 });
    const [a, b] = s.players, ga = s.goals[a], gb = s.goals[b];
    return ga === gb ? { [a]: 50, [b]: 50 } : { [a]: ga > gb ? 100 : ga * 10, [b]: gb > ga ? 100 : gb * 10 };
  },
  tick(ctx, s, dt) {
    if (s.phase !== 'play') return;
    s.players.forEach((p, i) => isBot(ctx, p) && hockeyBot(s, i, skill(p), ctx.rng));
    const subs = 4, h = dt / subs, k = s.k;
    for (let n = 0; n < subs; n++) {
      s.m.forEach(m => {
        const dx = m.tx - m.x, dy = m.ty - m.y, d = Math.hypot(dx, dy), max = (m.speed ?? 2400) * h, f = d > max ? max / d : 1;
        m.vx = (dx * f) / h; m.vy = (dy * f) / h; m.x += dx * f; m.y += dy * f;
        const pdx = k.x - m.x, pdy = k.y - m.y, pd = Math.hypot(pdx, pdy), sum = PUCK + MALLET;
        if (pd >= sum || pd === 0) return;
        if (ctx.now < s.pause) { m.x = k.x - (pdx / pd) * sum; m.y = k.y - (pdy / pd) * sum; return; } // face-off: mallets slide off the puck
        const nx = pdx / pd, ny = pdy / pd, rel = (k.vx - m.vx) * nx + (k.vy - m.vy) * ny;
        k.x = clamp(m.x + nx * sum, PUCK, TW - PUCK);
        k.y = Math.abs(k.x - TW / 2) < GOALW ? m.y + ny * sum : clamp(m.y + ny * sum, PUCK, TH - PUCK);
        if (rel < 0) { k.vx -= 1.75 * rel * nx; k.vy -= 1.75 * rel * ny; }
        const qx = k.x - m.x, qy = k.y - m.y, q = Math.hypot(qx, qy) || 1;
        if (q < sum) { m.x = k.x - (qx / q) * sum; m.y = k.y - (qy / q) * sum; } // puck pinned on a wall: the mallet gives way
      });
      if (ctx.now < s.pause) { k.vx = k.vy = 0; continue; }
      const nearWall = k.x < 80 || k.x > TW - 80 || k.y < 80 || k.y > TH - 80;
      s.still = Math.hypot(k.vx, k.vy) < 40 && nearWall ? (s.still ?? 0) + h : 0;
      if (s.still > 1.5) { // a dead puck by the boards drifts back out, like on a real air table
        const dx = TW / 2 - k.x, dy = TH / 2 - k.y, d = Math.hypot(dx, dy) || 1;
        k.vx = (dx / d) * 300; k.vy = (dy / d) * 300; s.still = 0;
      }
      const sp = Math.hypot(k.vx, k.vy);
      if (sp > MAXPUCK) { k.vx *= MAXPUCK / sp; k.vy *= MAXPUCK / sp; }
      k.vx *= 1 - 0.45 * h; k.vy *= 1 - 0.45 * h;
      k.x += k.vx * h; k.y += k.vy * h;
      if (k.x < PUCK) { k.x = PUCK; k.vx = Math.abs(k.vx) * 0.85; }
      if (k.x > TW - PUCK) { k.x = TW - PUCK; k.vx = -Math.abs(k.vx) * 0.85; }
      const mouth = Math.abs(k.x - TW / 2) < GOALW;
      if (k.y < PUCK && !mouth) { k.y = PUCK; k.vy = Math.abs(k.vy) * 0.85; }
      if (k.y > TH - PUCK && !mouth) { k.y = TH - PUCK; k.vy = -Math.abs(k.vy) * 0.85; }
      if (k.y < -PUCK || k.y > TH + PUCK) { // in the net
        const scorer = k.y < 0 ? 0 : 1;
        s.goals[s.players[scorer]]++;
        s.dirty = true;
        if (s.goals[s.players[scorer]] >= TO) return void Object.assign(s, { phase: 'over', deadline: ctx.now + 4000 });
        resetPuck(s, 1 - scorer, ctx.now + 1200);
        break;
      }
    }
  },
  status() {},
  frame: s => ({ k: [R(s.k.x), R(s.k.y)], m: s.m.map(m => [R(m.x), R(m.y)]) }),
  view: s => ({ phase: s.phase, players: s.players, goals: s.goals, deadline: s.deadline, ends: s.phase === 'play' ? s.deadline : null }),
  bot: noPlan,
};
function aim(s, i, x, y) {
  const m = s.m[i], lo = i === 0 ? TH / 2 + MALLET : MALLET, hi = i === 0 ? TH - MALLET : TH / 2 - MALLET;
  m.tx = clamp(x, MALLET, TW - MALLET); m.ty = clamp(y, lo, hi);
}
function resetPuck(s, side, pause) { // the conceding side gets the puck
  s.k = { x: TW / 2, y: side === 0 ? TH * 0.68 : TH * 0.32, vx: 0, vy: 0 };
  s.pause = pause;
}
function hockeyBot(s, i, sk, rng) {
  const m = s.m[i], k = s.k, home = i === 0 ? TH - 90 : 90, mine = i === 0 ? k.y >= TH / 2 : k.y < TH / 2;
  m.speed = 1150 * sk;
  if (!mine) return void (m.gx = null, aim(s, i, TW / 2 + (k.x - TW / 2) * 0.5, home));
  // pick a spot in their goal mouth (or a bank shot off a side wall), then hit through the puck towards it
  m.gx ??= rng() < 0.3 ? (rng() < 0.5 ? -TW / 2 : TW * 1.5) : TW / 2 + (rng() * 2 - 1) * GOALW * 0.8;
  const walled = k.x < 90 || k.x > TW - 90 || Math.abs(k.y - home) < 70 || k.y < 90 || k.y > TH - 90;
  const gx = walled ? TW / 2 : m.gx, gy = walled ? TH / 2 : i === 0 ? 0 : TH; // stuck by a wall: dig it out towards the middle
  const dx = gx - k.x, dy = gy - k.y, d = Math.hypot(dx, dy) || 1;
  const tx = k.x - (dx / d) * (PUCK + MALLET - 14), ty = k.y - (dy / d) * (PUCK + MALLET - 14);
  if (tx < MALLET || tx > TW - MALLET || ty < MALLET || ty > TH - MALLET) return aim(s, i, TW / 2, home); // can't get behind it: back off
  aim(s, i, tx, ty);
}


// ───────────── Table Volley: phones side by side make one court; flick the ball up and over the net ─────────────
// Side view. Each phone shows one 600×1000 slice. Left half of the line is one team, right half the other; the net sits
// where they meet. Let the ball touch the floor on your side and they score. First to 11, or most in 2 minutes.
const SW = 600, SH = 1000, VB = 36, NET_TOP = 600, GRAV = 1500;
const volley = {
  name: 'Table Volley', icon: '🏐', min: 2, max: 8, secs: 160, desc: 'Live! Line your phones up into one court. Flick it over the net', rt: 20,
  settings: () => ({}),
  init(ctx, players) {
    const n = players.length, s = { players, n, team: players.map((p, i) => (i < n / 2 ? 0 : 1)), goals: [0, 0], phase: 'ready', deadline: ctx.now + 6000, cd: {}, botAt: {} };
    serve(s, 0, 0);
    return s;
  },
  input(ctx, s, pid, inp) {
    const i = s.players.indexOf(pid), b = s.ball;
    if (i < 0 || s.phase !== 'play' || ctx.now < (s.cd[i] ?? 0)) return;
    const x = num(inp.x, -1e4, 1e4, null), y = num(inp.y, -1e4, 1e4, null);
    if (x == null || b.x < i * SW - VB || b.x > (i + 1) * SW + VB || Math.hypot(x - b.x, y - b.y) > 170) return; // only the ball on your own screen
    const vx = num(inp.vx, -2200, 2200), vy = num(inp.vy, -2600, 2600);
    if (Math.hypot(vx, vy) < 80) return;
    Object.assign(b, { vx, vy }); s.cd[i] = ctx.now + 250; s.pause = 0;
  },
  timer(ctx, s) {
    if (s.phase === 'ready') return void Object.assign(s, { phase: 'play', deadline: ctx.now + 120e3 });
    if (s.phase === 'play') return void Object.assign(s, { phase: 'over', deadline: ctx.now + 4000 });
    const [a, b] = s.goals;
    return Object.fromEntries(s.players.map((p, i) => { const m = s.team[i] ? b : a, o = s.team[i] ? a : b; return [p, m > o ? 100 : m === o ? 50 : 20]; }));
  },
  tick(ctx, s, dt) {
    if (s.phase !== 'play') return;
    s.now = ctx.now;
    const b = s.ball, L = s.n * SW, NX = L / 2;
    s.players.forEach((p, i) => { // computer players bump it back over when it drops onto their screen
      if (!isBot(ctx, p) || b.x < i * SW || b.x > (i + 1) * SW || b.y < 350 || b.vy < 0 || ctx.now < (s.cd[i] ?? 0)) return;
      if (ctx.rng() > 0.25 * skill(p)) return;
      const tx = s.team[i] ? NX * (0.2 + ctx.rng() * 0.6) : NX + NX * (0.2 + ctx.rng() * 0.6), vy = -1250 - ctx.rng() * 350, t = (-vy / GRAV) * 1.9;
      Object.assign(b, { vx: (tx - b.x) / t, vy }); s.cd[i] = ctx.now + 400; s.pause = 0;
    });
    if (ctx.now < s.pause) return; // serve: the ball hangs until someone hits it (or the wait runs out)
    for (let k = 0; k < 3; k++) {
      const h = dt / 3, px = b.x;
      b.vy += GRAV * h; b.x += b.vx * h; b.y += b.vy * h;
      if (b.y < VB) { b.y = VB; b.vy = Math.abs(b.vy) * 0.8; }
      if (b.x < VB) { b.x = VB; b.vx = Math.abs(b.vx) * 0.8; }
      if (b.x > L - VB) { b.x = L - VB; b.vx = -Math.abs(b.vx) * 0.8; }
      if (b.y > NET_TOP - VB && (px - NX) * (b.x - NX) <= 0 && px !== b.x) { b.x = px; b.vx = -b.vx * 0.6; } // into the net
      if (b.y > SH - VB) { // it hit the floor: point to the other side
        const scorer = b.x < NX ? 1 : 0;
        s.goals[scorer]++;
        Object.assign(s, { dirty: true, scored: scorer });
        if (s.goals[scorer] >= 11) return void Object.assign(s, { phase: 'over', deadline: ctx.now + 4000 });
        return serve(s, 1 - scorer, ctx.now + 2500);
      }
    }
  },
  status() {},
  frame: s => ({ k: [R(s.ball.x), R(s.ball.y)] }),
  view: s => ({ phase: s.phase, players: s.players, team: s.team, goals: s.goals, scored: s.scored ?? null, deadline: s.deadline, ends: s.phase === 'play' ? s.deadline : null }),
  bot: noPlan,
};
function serve(s, side, pause) { // the team that lost the point serves from the middle of their half
  const L = s.n * SW;
  s.ball = { x: side === 0 ? L * 0.25 : L * 0.75, y: 320, vx: 0, vy: 0 };
  s.pause = pause;
}

export const LIVE = { hockey, sumo, snake, land, paint, kickabout, volley, type_race: typeRace };

// shared with live2.js
export { clamp, num, R, hash, skill, isBot, noPlan, stick, moveDiscs, bump, dashing, rounds, DIRS, queueTurn };
