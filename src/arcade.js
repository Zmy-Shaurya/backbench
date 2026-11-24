// Touch-physics sports games. Physics runs on each phone; the server keeps scores honest with rate caps.
import { int, zero } from './games.js';

const hash = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const skill = pid => 0.3 + (hash(pid) % 30) / 100; // each computer player has a fixed skill, 0.30–0.59

// Score attack: everyone plays the same seeded run at once; best score in the window wins.
function scoreAttack(meta, secs, rate, botRate) { // rate: the human cap; botRate: how fast a good computer player scores
  return {
    ...meta,
    settings: () => ({}),
    init(ctx, players) {
      return { players, seed: Math.floor(ctx.rng() * 1e9), best: zero(players), phase: 'ready', start: ctx.now + 3000, deadline: ctx.now + 3000 };
    },
    input(ctx, s, pid, inp) {
      if (s.phase !== 'play' || !(pid in s.best)) return;
      const v = int(inp.score, 0, 1e5, -1), cap = Math.ceil(((ctx.now - s.start) / 1000) * rate) + 2; // no faster than humanly possible
      if (v >= 0 && v <= cap) s.best[pid] = Math.max(s.best[pid], v);
    },
    timer(ctx, s) {
      if (s.phase === 'ready') return void Object.assign(s, { phase: 'play', start: ctx.now, deadline: ctx.now + secs * 1000 + 1500 });
      if (s.phase === 'play') return void Object.assign(s, { phase: 'result', deadline: ctx.now + 5000 });
      const top = Math.max(1, ...Object.values(s.best));
      return Object.fromEntries(s.players.map(p => [p, Math.round((100 * s.best[p]) / top)]));
    },
    status() {},
    view: s => ({ phase: s.phase, seed: s.seed, start: s.start, ends: s.phase === 'play' ? s.start + secs * 1000 : s.deadline, deadline: s.deadline, best: s.best, players: s.players }),
    bot(ctx, s, pid) {
      if (s.phase !== 'play' || ctx.now > s.start + secs * 1000) return null;
      return { input: { score: s.best[pid] + 1 }, delay: 1000 / (botRate * skill(pid) * 1.7) };
    },
  };
}

const keepy = scoreAttack({ name: 'Keepy Uppy', icon: '⚽', min: 1, max: 12, secs: 50, desc: 'Tap the ball to keep it up. Longest streak wins' }, 40, 3.5, 0.5);
const binToss = scoreAttack({ name: 'Bin Toss', icon: '🗑️', min: 1, max: 12, secs: 50, desc: 'Flick paper into the bin. Mind the wind' }, 40, 1.5, 0.3);
const sweetSpot = scoreAttack({ name: 'Sweet Spot', icon: '🎯', min: 1, max: 12, secs: 50, desc: 'Stop the needle in the zone. It gets smaller' }, 40, 2.5, 0.4);

// ───────────── Penalty Shootout ─────────────
// zones: 0 1 2 (top) / 3 4 5 (bottom). Top corners are riskier: 15% chance to sail over.
const PICK_MS = 10000, SHOW_MS = 3500;
const penalty = {
  name: 'Penalty Shootout', icon: '🥅', min: 2, max: 2, secs: 120, desc: 'Pick your corner. Out-guess the keeper',
  settings: () => ({}),
  init(ctx, players) {
    const s = { players, goals: zero(players), log: [], kick: 0 };
    nextKick(ctx, s);
    return s;
  },
  input(ctx, s, pid, inp) {
    if (s.phase !== 'aim') return;
    const z = int(inp.zone, 0, 5, -1);
    if (z < 0) return;
    if (pid === s.shooter && s.shot == null) s.shot = z;
    else if (pid === s.keeper && s.dive == null) s.dive = z;
    if (s.shot != null && s.dive != null) resolveKick(ctx, s);
  },
  timer(ctx, s) {
    if (s.phase === 'aim') {
      s.shot ??= Math.floor(ctx.rng() * 6);
      s.dive ??= Math.floor(ctx.rng() * 6);
      return resolveKick(ctx, s);
    }
    if (s.phase === 'kick') {
      const [a, b] = s.players, ga = s.goals[a], gb = s.goals[b], k = s.kick; // k kicks taken so far
      const left = p => Math.max(0, 5 - Math.ceil((k - (p === a ? 0 : 1)) / 2)); // regulation kicks left for p
      const decided = k <= 10 ? ga > gb + left(b) || gb > ga + left(a) : k % 2 === 0 && ga !== gb;
      if (decided || k >= 20) return void Object.assign(s, { phase: 'over', deadline: ctx.now + 4000 });
      return nextKick(ctx, s);
    }
    const [a, b] = s.players;
    return s.goals[a] === s.goals[b] ? { [a]: 50, [b]: 50 } : { [a]: s.goals[a] > s.goals[b] ? 100 : 0, [b]: s.goals[b] > s.goals[a] ? 100 : 0 };
  },
  status() {},
  view: (s, pid) => ({
    phase: s.phase, players: s.players, shooter: s.shooter, keeper: s.keeper, kick: s.kick, goals: s.goals, log: s.log,
    chosen: pid === s.shooter ? s.shot != null : pid === s.keeper ? s.dive != null : null, deadline: s.deadline,
  }),
  bot: (ctx, s, pid) =>
    s.phase === 'aim' && ((pid === s.shooter && s.shot == null) || (pid === s.keeper && s.dive == null))
      ? { input: { zone: Math.floor(ctx.rng() * 6) }, delay: 1200 + ctx.rng() * 1500 } : null,
};
function nextKick(ctx, s) {
  const i = s.kick % 2;
  Object.assign(s, { shooter: s.players[i], keeper: s.players[1 - i], shot: null, dive: null, phase: 'aim', deadline: ctx.now + PICK_MS });
}
function resolveKick(ctx, s) {
  const over = s.shot < 3 && s.shot !== 1 && ctx.rng() < 0.15;
  const result = over ? 'over' : s.shot === s.dive ? 'saved' : 'goal';
  if (result === 'goal') s.goals[s.shooter]++;
  s.log.push({ shooter: s.shooter, zone: s.shot, dive: s.dive, result });
  s.kick++;
  Object.assign(s, { phase: 'kick', deadline: ctx.now + SHOW_MS });
}

export const ARCADE = { keepy, penalty, bin_toss: binToss, sweet_spot: sweetSpot };
