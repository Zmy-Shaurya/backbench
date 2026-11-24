// More real-time games. Same contract as live.js: tick() at `rt` Hz, frame() broadcast, inputs only steer.
import { int } from './games.js';
import { clamp, R, hash, skill, isBot, noPlan, stick, moveDiscs, bump, dashing, rounds, DIRS, queueTurn } from './live.js';

const AW = 1000, DR = 34; // square arena, disc radius
const walls = list => {
  for (const b of list) {
    if (b.x < DR || b.x > AW - DR) { b.x = clamp(b.x, DR, AW - DR); b.vx *= -0.6; }
    if (b.y < DR || b.y > AW - DR) { b.y = clamp(b.y, DR, AW - DR); b.vy *= -0.6; }
  }
};
const ring = (ctx, n, rad) => { const a0 = ctx.rng() * 7; return Array.from({ length: n }, (_, i) => { const a = a0 + (i * 2 * Math.PI) / n; return { x: 500 + Math.cos(a) * rad, y: 500 + Math.sin(a) * rad, vx: 0, vy: 0, cd: 0, dash: 0 }; }); };
const toward = (m, dx, dy, k) => { const d = Math.hypot(dx, dy) || 1; m.x = (dx / d) * k; m.y = (dy / d) * k; };
const byScore = (s, sc) => { const top = Math.max(1e-9, ...s.players.map((_, i) => sc[i])); return Object.fromEntries(s.players.map((p, i) => [p, R((100 * sc[i]) / top)])); };
const discFrame = s => s.b.map(b => [R(b.x), R(b.y), b.dash > s.now ? 1 : 0, b.cd > s.now ? 0 : 1]);
// one timed match on the disc arena: ready (3 s) → play → over (4 s) → points
function arenaGame(meta, g) {
  return {
    ...meta, rt: 20,
    settings: () => ({}),
    init(ctx, players) {
      const s = { players, b: ring(ctx, players.length, 330), in: {}, sc: players.map(() => 0), phase: 'ready', deadline: ctx.now + 3000, now: ctx.now };
      g.setup?.(ctx, s);
      return s;
    },
    input(ctx, s, pid, inp) { if (s.players.includes(pid)) stick(s, pid, inp, 'dash'); },
    timer(ctx, s) {
      if (s.phase === 'ready') return void Object.assign(s, { phase: 'play', t0: ctx.now, deadline: ctx.now + g.secs * 1000 });
      if (s.phase === 'play') return void Object.assign(s, { phase: 'over', deadline: ctx.now + 4000 });
      return g.points ? g.points(s) : byScore(s, s.sc);
    },
    tick(ctx, s, dt) {
      if (s.phase !== 'play') return;
      s.now = ctx.now;
      s.players.forEach((p, i) => isBot(ctx, p) && g.bot(ctx, s, i, (s.in[p] ||= { x: 0, y: 0, act: false })));
      const ins = s.players.map((p, i) => (s.b[i].stun > ctx.now ? null : s.in[p]));
      s.b.forEach((b, i) => ins[i] && dashing(ctx, b, ins[i], 620));
      for (let k = 0; k < 2; k++) {
        moveDiscs(s.b, ins.map((m, i) => (m && g.speed ? { x: m.x * g.speed(s, i), y: m.y * g.speed(s, i) } : m)), dt / 2, 1500, 2);
        g.collide ? g.collide(ctx, s) : bump(s.b, DR, 1.2);
        walls(s.b);
      }
      g.step(ctx, s, dt);
    },
    status() {},
    frame: s => ({ b: discFrame(s), sc: s.sc.map(x => R(x * 10) / 10), ...g.extra?.(s) }),
    view: s => ({ phase: s.phase, players: s.players, deadline: s.deadline, ends: s.phase === 'play' ? s.deadline : null }),
    bot: noPlan,
  };
}

// ───────────── King of the Hill: be alone in the glowing zone. It moves every 12 s ─────────────
const ZR = 150;
const zoneSpot = ctx => [ZR + 40 + ctx.rng() * (AW - 2 * ZR - 80), ZR + 40 + ctx.rng() * (AW - 2 * ZR - 80)];
const hill = arenaGame({ name: 'King of the Hill', icon: '👑', min: 2, max: 8, secs: 80, desc: 'Live! Hold the zone alone to score. Shove them out' }, {
  secs: 60,
  setup(ctx, s) { s.zone = [500, 500]; s.next = zoneSpot(ctx); s.moveAt = ctx.now + 3000 + 12000; },
  step(ctx, s, dt) {
    if (ctx.now >= s.moveAt) { s.zone = s.next; s.next = zoneSpot(ctx); s.moveAt = ctx.now + 12000; }
    const dist = i => Math.hypot(s.b[i].x - s.zone[0], s.b[i].y - s.zone[1]);
    const inside = s.b.map((b, i) => i).filter(i => dist(i) < ZR).sort((a, b) => dist(a) - dist(b));
    s.held = inside[0] ?? -1; // alone: full points. Crowded: whoever is closest to the middle scores at half speed
    s.crowd = inside.length > 1;
    if (inside.length) s.sc[inside[0]] += inside.length === 1 ? dt : dt / 2;
  },
  bot(ctx, s, i, m) {
    const me = s.b[i], [zx, zy] = s.zone, d = Math.hypot(me.x - zx, me.y - zy);
    const rival = s.b.map((b, j) => [b, j]).filter(([b, j]) => j !== i && Math.hypot(b.x - zx, b.y - zy) < ZR + 40).sort((a, b) => Math.hypot(a[0].x - me.x, a[0].y - me.y) - Math.hypot(b[0].x - me.x, b[0].y - me.y))[0];
    if (d < ZR * 0.6 && rival) { toward(m, rival[0].x - me.x, rival[0].y - me.y, skill(s.players[i])); if (Math.hypot(rival[0].x - me.x, rival[0].y - me.y) < 140 && ctx.rng() < 0.06) m.act = true; }
    else toward(m, zx - me.x, zy - me.y, d < 30 ? 0.2 : skill(s.players[i]));
  },
  extra: s => ({ z: [R(s.zone[0]), R(s.zone[1])], nz: s.moveAt - s.now < 3000 ? [R(s.next[0]), R(s.next[1])] : null, h: s.held ?? -1, cr: s.crowd ? 1 : 0 }),
});

// ───────────── Bumper Tag: one of you is IT. Bump someone to pass it on. Least time as IT wins ─────────────
const tag = arenaGame({ name: 'Bumper Tag', icon: '🏷️', min: 2, max: 8, secs: 80, desc: 'Live! Bump someone to make them IT. Least time IT wins' }, {
  secs: 60,
  setup(ctx, s) { s.it = Math.floor(ctx.rng() * s.players.length); s.safe = 0; },
  speed: (s, i) => (i === s.it ? 1.12 : 1), // IT is a touch faster, or nobody would ever get caught
  collide(ctx, s) {
    bump(s.b, DR, 1.2);
    if (ctx.now < s.safe) return;
    const it = s.b[s.it];
    const hit = s.b.findIndex((b, j) => j !== s.it && Math.hypot(b.x - it.x, b.y - it.y) < 2 * DR + 4);
    if (hit < 0) return;
    s.b[hit].stun = ctx.now + 900; // the new IT freezes for a moment: a free head start for everyone else
    Object.assign(s, { it: hit, safe: ctx.now + 1500, dirty: true });
  },
  step(ctx, s, dt) { s.sc[s.it] += dt; },
  points: s => { const worst = Math.max(1e-9, ...s.sc); return Object.fromEntries(s.players.map((p, i) => [p, R(100 * (1 - s.sc[i] / worst) * 0.9 + 10)])); },
  bot(ctx, s, i, m) {
    const me = s.b[i], k = skill(s.players[i]);
    if (i === s.it) { // chase the nearest
      const t = s.b.filter((b, j) => j !== i).sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))[0];
      if (!t) return;
      toward(m, t.x - me.x, t.y - me.y, k);
      if (Math.hypot(t.x - me.x, t.y - me.y) < 160 && ctx.rng() < 0.05) m.act = true;
      return;
    }
    const it = s.b[s.it]; // run away, but not into a corner
    let dx = me.x - it.x, dy = me.y - it.y;
    const d = Math.hypot(dx, dy) || 1;
    dx = dx / d + (500 - me.x) / 600; dy = dy / d + (500 - me.y) / 600;
    toward(m, dx, dy, d > 380 ? 0.4 : k);
    if (d < 110 && ctx.rng() < 0.05) m.act = true;
  },
  extra: s => ({ it: s.it, st: s.b.map(b => (b.stun > s.now ? 1 : 0)) }),
});

// ───────────── Coin Rush: grab coins. Dash into someone and they spill theirs ─────────────
const coinAt = ctx => [60 + ctx.rng() * (AW - 120), 60 + ctx.rng() * (AW - 120), ctx.rng() < 0.12 ? 5 : 1];
const coins = arenaGame({ name: 'Coin Rush', icon: '🪙', min: 1, max: 8, secs: 65, desc: 'Live! Grab the coins. Dash into people to make them spill' }, {
  secs: 45,
  setup(ctx, s) { s.c = Array.from({ length: 10 }, () => coinAt(ctx)); },
  collide(ctx, s) {
    for (let i = 0; i < s.b.length; i++) for (let j = 0; j < s.b.length; j++) { // a dash that lands makes the other spill 3
      const a = s.b[i], c = s.b[j];
      if (i === j || a.dash < ctx.now || c.stun > ctx.now || Math.hypot(a.x - c.x, a.y - c.y) > 2 * DR + 6) continue;
      const n = Math.min(3, Math.floor(s.sc[j]));
      s.sc[j] -= n;
      for (let k = 0; k < n; k++) { const ang = ctx.rng() * 7; s.c.push([clamp(c.x + Math.cos(ang) * 90, 40, AW - 40), clamp(c.y + Math.sin(ang) * 90, 40, AW - 40), 1]); }
      c.stun = ctx.now + 700; a.dash = 0;
    }
    bump(s.b, DR, 1.2);
  },
  step(ctx, s) {
    s.c = s.c.filter(cn => { const i = s.b.findIndex(b => Math.hypot(b.x - cn[0], b.y - cn[1]) < DR + 16); if (i < 0) return true; s.sc[i] += cn[2]; return false; });
    while (s.c.length < 10) s.c.push(coinAt(ctx));
  },
  bot(ctx, s, i, m) {
    const me = s.b[i], k = skill(s.players[i]);
    const best = s.c.reduce((b, cn) => { const v = cn[2] / (Math.hypot(cn[0] - me.x, cn[1] - me.y) + 60); return v > b[0] ? [v, cn] : b; }, [0, null])[1];
    const rich = s.b.findIndex((b, j) => j !== i && s.sc[j] >= 3 && Math.hypot(b.x - me.x, b.y - me.y) < 150);
    if (rich >= 0 && me.cd < ctx.now && ctx.rng() < 0.2) { toward(m, s.b[rich].x - me.x, s.b[rich].y - me.y, 1); m.act = true; return; }
    if (best) toward(m, best[0] - me.x, best[1] - me.y, k);
  },
  extra: s => ({ c: s.c.flatMap(cn => [R(cn[0]), R(cn[1]), cn[2]]) }),
});

// ───────────── Light Trails: riders leave walls behind them. Last one riding wins the round ─────────────
const TN = 40;
const trails = rounds({ name: 'Light Trails', icon: '🏍️', min: 2, max: 8, secs: 120, desc: 'Live! Your trail is a wall. Box them in, last rider wins' }, {
  rt: 10, secs: 45,
  setup(ctx, s) {
    const n = s.players.length, a0 = Math.floor(ctx.rng() * 4);
    s.g = Array(TN * TN).fill(0);
    s.r = s.players.map((p, i) => { // riders start round the edge, facing in
      const a = ((a0 + i) * 2 * Math.PI) / Math.max(n, 4), x = R(TN / 2 + Math.cos(a) * 15), y = R(TN / 2 + Math.sin(a) * 15);
      const inward = Math.abs(TN / 2 - x) > Math.abs(TN / 2 - y) ? (x < TN / 2 ? 1 : 3) : y < TN / 2 ? 2 : 0, d = (inward + 1) % 4; // start circling, not head-on
      s.g[y * TN + x] = i + 1;
      return { x, y, d, q: [], dead: 0 };
    });
  },
  steer(s, pid, inp) { const r = s.r[s.players.indexOf(pid)]; if (r && !r.dead) queueTurn(r.q, r.d, int(inp.d, 0, 3, -1)); },
  step(ctx, s) {
    const live = s.r.filter(r => !r.dead), heads = new Map();
    for (const r of live) { if (r.q.length) r.d = r.q.shift(); r.x += DIRS[r.d][0]; r.y += DIRS[r.d][1]; const c = r.y * TN + r.x; heads.set(c, (heads.get(c) ?? 0) + 1); }
    const crash = live.filter(r => r.x < 0 || r.y < 0 || r.x >= TN || r.y >= TN || s.g[r.y * TN + r.x] || heads.get(r.y * TN + r.x) > 1);
    for (const r of live) if (!crash.includes(r)) s.g[r.y * TN + r.x] = s.r.indexOf(r) + 1;
    for (const r of crash) { r.dead = ctx.now; s.dirty = true; }
  },
  alive: s => s.players.filter((p, i) => !s.r[i].dead),
  leader: () => null, // time up with riders left: nobody takes the round
  bot(ctx, s, pid) { // look at each way you could go and pick the one with the most room
    const r = s.r[s.players.indexOf(pid)];
    if (r.dead || r.q.length) return;
    const free = c => c >= 0 && !s.g[c];
    const near = new Set(s.r.filter(o => o !== r && !o.dead).flatMap(o => DIRS.map(([dx, dy]) => (o.y + dy) * TN + o.x + dx))); // where other riders could be next tick
    const room = (x, y) => {
      if (x < 0 || y < 0 || x >= TN || y >= TN || s.g[y * TN + x]) return -1;
      const seen = new Set([y * TN + x]), stack = [y * TN + x];
      while (stack.length && seen.size < 120) {
        const c = stack.pop(), cx = c % TN, cy = Math.floor(c / TN);
        for (const [dx, dy] of DIRS) { const nx = cx + dx, ny = cy + dy, n = ny * TN + nx; if (nx >= 0 && ny >= 0 && nx < TN && ny < TN && free(n) && !seen.has(n)) { seen.add(n); stack.push(n); } }
      }
      return seen.size;
    };
    const opts = [r.d, (r.d + 1) % 4, (r.d + 3) % 4].map(d => { const x = r.x + DIRS[d][0], y = r.y + DIRS[d][1]; return [d, room(x, y) - (near.has(y * TN + x) ? 60 : 0) + (d === r.d ? 3 : 0) + ctx.rng() * 4 * (1 - skill(pid))]; });
    const d = opts.sort((a, b) => b[1] - a[1])[0][0];
    if (d !== r.d) r.q.push(d);
  },
  frame: s => ({ g: s.g.map(c => c.toString(36)).join(''), r: s.r.map(r => (r.dead ? [] : [r.x, r.y, r.d])) }),
});

// ───────────── Red Light, Green Light: hold to run, freeze on red ─────────────
const GRACE = 350; // reaction allowance after the light turns red (phones lag a little)
const redlight = {
  name: 'Red Light, Green Light', icon: '🚦', min: 1, max: 12, secs: 100, desc: 'Live! Hold to run, freeze on red. Caught = back you go', rt: 10,
  settings: () => ({}),
  init(ctx, players) {
    return { players, pos: players.map(() => 0), run: players.map(() => false), fin: {}, stun: players.map(() => 0), caught: players.map(() => 0), light: 'green', lightAt: ctx.now + 3000 + 2500, phase: 'ready', deadline: ctx.now + 3000 };
  },
  input(ctx, s, pid, inp) { const i = s.players.indexOf(pid); if (i >= 0 && typeof inp.run === 'boolean') s.run[i] = inp.run; },
  timer(ctx, s) {
    if (s.phase === 'ready') return void Object.assign(s, { phase: 'play', t0: ctx.now, lightAt: ctx.now + 2000 + ctx.rng() * 2500, deadline: ctx.now + 90e3 });
    if (s.phase === 'play') return void Object.assign(s, { phase: 'over', deadline: ctx.now + 4000 });
    const order = Object.keys(s.fin).sort((a, b) => s.fin[a] - s.fin[b]);
    return Object.fromEntries(s.players.map((p, i) => [p, p in s.fin ? Math.max(55, 100 - 12 * order.indexOf(p)) : R(50 * s.pos[i])]));
  },
  tick(ctx, s, dt) {
    if (s.phase !== 'play') return;
    s.now = ctx.now;
    if (ctx.now >= s.lightAt) { // green → yellow (0.6 s warning) → red → green
      const next = { green: ['yellow', 600], yellow: ['red', 1600 + ctx.rng() * 1900], red: ['green', 1500 + ctx.rng() * 2800] }[s.light];
      Object.assign(s, { light: next[0], redAt: next[0] === 'red' ? ctx.now : s.redAt, lightAt: ctx.now + next[1], dirty: true });
    }
    s.players.forEach((p, i) => {
      if (p in s.fin) return;
      if (isBot(ctx, p)) { const k = skill(p); s.run[i] = s.light === 'green' || (s.light === 'yellow' && ctx.rng() > k) || (s.light === 'red' && ctx.now - s.redAt < 150 + (1 - k) * 600); }
      if (!s.run[i] || ctx.now < s.stun[i]) return;
      if (s.light === 'red') { // a short grace for reaction time (no progress either), then you're caught
        if (ctx.now - s.redAt > GRACE) { s.pos[i] = Math.max(0, s.pos[i] - 0.4); s.stun[i] = ctx.now + 1200; s.caught[i] = ctx.now; s.dirty = true; }
        return;
      }
      s.pos[i] = Math.min(1, s.pos[i] + dt * 0.06 * (0.92 + (hash(p) % 16) / 100));
      if (s.pos[i] >= 1) { s.fin[p] = ctx.now - s.t0; s.dirty = true; }
    });
    if (s.players.every(p => p in s.fin)) Object.assign(s, { phase: 'over', deadline: ctx.now + 4000 });
  },
  status(ctx, s) { if (s.phase === 'play' && s.players.filter(p => ctx.active.includes(p)).every(p => p in s.fin)) Object.assign(s, { phase: 'over', deadline: ctx.now + 4000, dirty: true }); },
  frame: s => ({ p: s.pos.map(x => R(x * 1000) / 1000), c: s.caught.map(t => (s.now - t < 1200 ? 1 : 0)) }),
  view: s => ({ phase: s.phase, players: s.players, light: s.light, fin: s.fin, deadline: s.deadline, ends: s.phase === 'play' ? s.deadline : null }),
  bot: noPlan,
};

// ───────────── Tug of War: two teams, tap tap tap ─────────────
const tug = {
  name: 'Tug of War', icon: '🪢', min: 2, max: 12, secs: 60, desc: 'Live! Two teams. Tap as fast as you can', rt: 10,
  settings: () => ({}),
  init(ctx, players) {
    return { players, team: players.map((p, i) => i % 2), rope: 0, rate: [0, 0], tok: players.map(() => 3), taps: [0, 0], phase: 'ready', deadline: ctx.now + 3000, last: ctx.now };
  },
  input(ctx, s, pid, inp) {
    const i = s.players.indexOf(pid), n = int(inp.t, 1, 6, 0);
    if (i < 0 || s.phase !== 'play' || !n) return;
    s.tok[i] = Math.min(4, s.tok[i] + ((ctx.now - (s.tokAt?.[i] ?? ctx.now)) / 1000) * 13); // nobody really taps faster than ~13/s
    (s.tokAt ||= [])[i] = ctx.now;
    const ok = Math.min(n, Math.floor(s.tok[i]));
    s.tok[i] -= ok;
    s.taps[s.team[i]] += ok;
  },
  timer(ctx, s) {
    if (s.phase === 'ready') return void Object.assign(s, { phase: 'play', deadline: ctx.now + 40e3 });
    if (s.phase === 'play') return void Object.assign(s, { phase: 'over', winner: s.rope === 0 ? null : s.rope < 0 ? 0 : 1, deadline: ctx.now + 4000 });
    return Object.fromEntries(s.players.map((p, i) => [p, s.winner == null ? 50 : s.team[i] === s.winner ? 100 : 25]));
  },
  tick(ctx, s, dt) {
    if (s.phase !== 'play') return;
    s.players.forEach((p, i) => { if (isBot(ctx, p) && ctx.rng() < (6 + (hash(p) % 4)) * dt) s.taps[s.team[i]]++; });
    const size = [0, 1].map(t => Math.max(1, s.team.filter(x => x === t).length)), pull = [0, 1].map(t => s.taps[t] / size[t]); // taps per player: big teams don't auto-win
    s.rate = pull.map(x => R(x / dt));
    s.rope = clamp(s.rope + (pull[1] - pull[0]) * 0.05, -1, 1);
    s.taps = [0, 0];
    if (Math.abs(s.rope) >= 1) Object.assign(s, { phase: 'over', winner: s.rope < 0 ? 0 : 1, deadline: ctx.now + 4000, dirty: true });
  },
  status() {},
  frame: s => ({ r: R(s.rope * 1000) / 1000, t: s.rate }),
  view: s => ({ phase: s.phase, players: s.players, team: s.team, winner: s.winner ?? null, deadline: s.deadline, ends: s.phase === 'play' ? s.deadline : null }),
  bot: noPlan,
};

export const LIVE2 = { hill, tag, coins, trails, redlight, tug };
