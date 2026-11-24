import { DurableObject } from 'cloudflare:workers';
import { GAMES as PARTY, text, shuffle } from './games.js';
import { CLASSICS } from './classics.js';
import { ARCADE } from './arcade.js';
import { LIVE } from './live.js';
import { CARDS } from './cards.js';
import { LIVE2 } from './live2.js';
import { clean } from './content.js';
export { Crew } from './crew.js';

const GAMES = { ...PARTY, ...CLASSICS, ...CARDS, ...ARCADE, ...LIVE, ...LIVE2 };
const BOT_NAMES = ['Ava', 'Max', 'Zara', 'Rio', 'Neo', 'Kiki', 'Juno', 'Ozzy'];

const V = 3, MAX_PLAYERS = 12, AWAY_MS = 60e3, IDLE_MS = 30 * 60e3, LIFE_MS = 3 * 3600e3, RESULTS_MS = 8000;
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O → 24^4 = 331,776 codes
const REACTIONS = ['👀', '🤔', '😂', '🔥', '😱', '👏'];
const NIGHT_PTS = [10, 7, 5, 3]; // Game Night: placement points per game (everyone else gets 1), so every game weighs the same
const CHUNK = 50_000; // DO values are capped at 128 KiB; strings with emoji serialise at 2 bytes/char

export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname;
    const room = code => env.ROOM.get(env.ROOM.idFromName(code));
    if (p === '/api/health') return Response.json({ ok: true });
    if (p === '/api/rooms' && req.method === 'POST') {
      for (let i = 0; i < 5; i++) {
        const code = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => ABC[b % 24]).join('');
        if ((await room(code).fetch(`https://do/init?code=${code}`, { method: 'POST' })).ok) return Response.json({ code });
      }
      return Response.json({ error: 'busy' }, { status: 503 });
    }
    const ip = req.headers.get('cf-connecting-ip') || 'local';
    const limited = async () => env.LOOKUPS && !(await env.LOOKUPS.limit({ key: ip })).success;
    const crew = code => env.CREW.get(env.CREW.idFromName(code));
    if (p === '/api/crews' && req.method === 'POST') {
      if (await limited()) return Response.json({ error: 'rate_limited' }, { status: 429 });
      const name = clean(text((await req.json().catch(() => ({}))).name, 24));
      if (!name) return Response.json({ error: 'Name your crew' }, { status: 400 });
      for (let i = 0; i < 5; i++) {
        const code = Array.from(crypto.getRandomValues(new Uint8Array(6)), b => ABC[b % 24]).join('');
        const res = await crew(code).fetch(`https://crew/init?code=${code}`, { method: 'POST', body: name });
        if (res.ok) return Response.json({ code, name });
      }
      return Response.json({ error: 'busy' }, { status: 503 });
    }
    const c = p.match(/^\/api\/crews\/([a-z]{6})$/i);
    if (c) {
      if (await limited()) return Response.json({ error: 'rate_limited' }, { status: 429 });
      return crew(c[1].toUpperCase()).fetch('https://crew/info');
    }
    const m = p.match(/^\/(api\/rooms|ws)\/([a-z]{4})$/i);
    if (m) {
      const code = m[2].toUpperCase();
      if (m[1] === 'ws') return room(code).fetch(req);
      if (await limited()) return Response.json({ error: 'rate_limited' }, { status: 429 });
      return room(code).fetch('https://do/info');
    }
    return env.ASSETS.fetch(req);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sent = new Map(); // pid → last snapshot string (skip identical re-sends)
    this.buckets = new Map();
    this.botTimers = new Map();
    ctx.blockConcurrencyWhile(async () => {
      const n = await ctx.storage.get('n');
      const keys = Array.from({ length: n || 0 }, (_, i) => `c${i}`);
      const parts = n ? await ctx.storage.get(keys) : null;
      this.n = n || 0;
      this.room = n ? JSON.parse(keys.map(k => parts.get(k)).join('')) : null;
      this.tickLoop(); // woke up (or was evicted) mid live game: keep it moving
    });
  }

  // ── HTTP / connect ──
  async fetch(req) {
    const url = new URL(req.url), r = this.room, now = Date.now();
    if (url.pathname === '/init') {
      if (r) return new Response('taken', { status: 409 });
      this.room = {
        code: url.searchParams.get('code'), createdAt: now, lastActive: now, hostId: null, players: {}, banned: [],
        clean: true, phase: 'lobby', gameId: 'tap_duel', settings: {}, game: null, result: null, history: [],
      };
      this.changed();
      return new Response('ok');
    }
    if (url.pathname === '/info') {
      const n = r ? Object.keys(r.players).length : 0;
      return Response.json(r ? { exists: true, playerCount: n, full: n >= MAX_PLAYERS, phase: r.phase } : { exists: false });
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });

    const [client, ws] = Object.values(new WebSocketPair());
    const q = url.searchParams, pid = q.get('pid') || '';
    const fail = code => {
      ws.accept();
      ws.send(JSON.stringify({ t: 'error', code }));
      ws.close(4000, code);
      return new Response(null, { status: 101, webSocket: client });
    };
    if (q.get('v') !== String(V)) return fail('update_required');
    if (!r) return fail('not_found');
    if (q.get('tv')) { // big-screen view: watches everything, plays nothing, never counts as a player
      if (this.ctx.getWebSockets().filter(w => this.ctx.getTags(w)[0]?.startsWith('tv:')).length >= 4) return fail('room_full');
      this.ctx.acceptWebSocket(ws, [`tv:${crypto.randomUUID()}`]);
      this.changed();
      return new Response(null, { status: 101, webSocket: client });
    }
    if (!/^[\w-]{8,64}$/.test(pid)) return fail('invalid_input');
    if (r.banned.includes(pid)) return fail('kicked');
    let p = r.players[pid];
    if (!p) {
      if (Object.keys(r.players).length >= MAX_PLAYERS) return fail('room_full');
      p = r.players[pid] = {
        id: pid, name: this.uniqueName(q.get('name'), pid), avatar: Math.abs(parseInt(q.get('a')) || 0) % 160,
        status: 'connected', joinedAt: now, score: 0, spectator: !!r.game, lv: 1,
      };
      r.hostId ||= pid;
      this.event('all', 'toast', `${p.name} joined`);
    }
    p.lv = Math.min(999, Math.max(1, parseInt(q.get('lv')) || p.lv || 1));
    for (const old of this.ctx.getWebSockets(pid)) { // newest tab wins
      this.send(old, { t: 'error', code: 'session_replaced' });
      old.close(4001, 'session_replaced');
    }
    this.ctx.acceptWebSocket(ws, [pid]);
    this.sent.delete(pid);
    if (p.status !== 'connected') this.setStatus(p, 'connected');
    this.changed();
    return new Response(null, { status: 101, webSocket: client });
  }

  // ── messages ──
  async webSocketMessage(ws, raw) {
    const [pid] = this.ctx.getTags(ws), r = this.room;
    if (!pid || !r || (!r.players[pid] && !pid.startsWith('tv:'))) return;
    if (typeof raw !== 'string' || raw.length > 65536) return this.send(ws, { t: 'error', code: 'invalid_input' });
    if (!this.allow(pid, ws)) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m?.t === 'ping') return this.send(ws, { t: 'pong', c: m.c, s: Date.now() });
    if (!r.players[pid]) return; // TV screens only ping
    if (m?.t === 'set_crew') return this.setCrew(ws, pid, m.code);
    try {
      if (this.handle(pid, m) === 'noop') return;
    } catch (e) {
      if (!e?.reject) throw e;
      return this.send(ws, { t: 'error', code: e.code || 'invalid_input', message: e.reject });
    }
    this.changed();
  }

  handle(pid, m) {
    const r = this.room, isHost = r.hostId === pid, G = GAMES[r.game?.id];
    const need = ok => { if (!ok) throw { reject: 'Not allowed', code: 'not_host' }; };
    switch (m?.t) {
      case 'set_name':
        need(r.phase === 'lobby');
        r.players[pid].name = this.uniqueName(m.name, pid);
        break;
      case 'select_game':
        need(isHost && r.phase === 'lobby' && Object.hasOwn(GAMES, m.gameId));
        r.gameId = m.gameId;
        break;
      case 'update_game_settings':
        need(isHost && r.phase === 'lobby');
        r.settings[r.gameId] = GAMES[r.gameId].settings(m.settings);
        break;
      case 'set_clean':
        need(isHost);
        r.clean = !!m.on;
        break;
      case 'add_bot': {
        need(isHost && r.phase === 'lobby' && Object.keys(r.players).length < MAX_PLAYERS);
        const id = `bot-${crypto.randomUUID()}`, used = Object.values(r.players).map(p => p.name);
        const name = `🤖 ${BOT_NAMES.find(n => !used.includes(`🤖 ${n}`)) ?? 'Bot'}`;
        r.players[id] = { id, name, avatar: Math.floor(Math.random() * 160), status: 'connected', joinedAt: Date.now(), score: 0, spectator: false, bot: true };
        break;
      }
      case 'start_game':
        need(isHost && r.phase === 'lobby');
        this.start(r.gameId, m.players);
        break;
      case 'start_night': { // Game Night: a queue of games played back to back with one running scoreboard
        need(isHost && r.phase === 'lobby' && Array.isArray(m.queue));
        const queue = m.queue.filter(id => Object.hasOwn(GAMES, id)).slice(0, 10);
        if (queue.length < 2) throw { reject: 'Pick at least 2 games for a Game Night' };
        r.night = { queue, i: 0, pts: {}, at: Date.now() };
        try { this.start(queue[0]); } catch (e) { r.night = null; throw e; }
        break;
      }
      case 'set_lv':
        r.players[pid].lv = Math.min(999, Math.max(1, parseInt(m.lv) || 1));
        break;
      case 'end_game':
        need(isHost && r.game);
        Object.assign(r, { game: null, phase: 'lobby', night: null });
        break;
      case 'play_again': // same game, same players, straight from the results screen
        need(isHost && r.phase === 'results' && r.result && !r.night);
        this.start(r.result.gameId, r.lastIds);
        break;
      case 'back_to_lobby': // during a Game Night this is "next game"
        need(isHost && (r.phase === 'results' || r.phase === 'night'));
        this.next();
        break;
      case 'kick': {
        need(isHost && m.pid !== pid && r.players[m.pid]);
        const wasBot = r.players[m.pid].bot;
        delete r.players[m.pid];
        if (!wasBot) r.banned.push(m.pid);
        for (const w of this.ctx.getWebSockets(m.pid)) { this.send(w, { t: 'error', code: 'kicked' }); w.close(4002, 'kicked'); }
        if (r.game) this.checkGame();
        break;
      }
      case 'transfer_host':
        need(isHost && r.players[m.pid]);
        r.hostId = m.pid;
        break;
      case 'game_input':
        need(G && !r.players[pid].spectator && m.input && typeof m.input === 'object');
        if (G.rt) { G.input(this.ctx_(), r.game.state, pid, m.input); this.tickLoop(); return 'noop'; } // steering only: the tick loop broadcasts
        this.step(() => G.input(this.ctx_(), r.game.state, pid, m.input));
        break;
      case 'react': {
        const p = r.players[pid], now = Date.now();
        if (!REACTIONS.includes(m.emoji) || now - (p.reactedAt || 0) < 2000) return 'noop';
        p.reactedAt = now;
        this.event('all', 'reaction', { pid, emoji: m.emoji });
        return 'noop';
      }
      default:
        return 'noop';
    }
  }

  // token bucket: 20 burst, 5/s sustained (40 and 30/s during a live game); 3 strikes in 60 s → disconnect
  allow(pid, ws) {
    const now = Date.now(), b = this.buckets.get(pid) ?? { tok: 20, at: now, strikes: [] }, fast = GAMES[this.room.game?.id]?.rt;
    this.buckets.set(pid, b);
    b.tok = Math.min(fast ? 40 : 20, b.tok + ((now - b.at) * (fast ? 30 : 5)) / 1000);
    b.at = now;
    if (b.tok >= 1) return b.tok--, true;
    b.strikes = [...b.strikes.filter(t => now - t < 60e3), now];
    this.send(ws, { t: 'error', code: 'rate_limited' });
    if (b.strikes.length >= 3) ws.close(4003, 'rate_limited');
    return false;
  }

  webSocketClose(ws) {
    try { ws.close(); } catch {}
    const [pid] = this.ctx.getTags(ws), p = this.room?.players[pid];
    if (!p || this.ctx.getWebSockets(pid).some(w => w !== ws && w.readyState === 1)) return; // replaced by a newer tab
    this.room.lastActive = Date.now();
    this.setStatus(p, 'disconnected');
    this.changed();
  }
  webSocketError(ws) { this.webSocketClose(ws); }

  // ── timers: one alarm, set to the earliest thing that is due ──
  async alarm() {
    const r = this.room;
    if (!r) return;
    const now = Date.now(), ps = Object.values(r.players);
    if (now >= r.createdAt + LIFE_MS || (!ps.some(p => p.status === 'connected' && !p.bot) && now >= r.lastActive + IDLE_MS)) {
      for (const w of this.ctx.getWebSockets()) { this.send(w, { t: 'error', code: 'room_expired' }); w.close(4004, 'expired'); }
      this.room = null;
      clearTimeout(this.saving);
      await this.ctx.storage.deleteAll();
      return;
    }
    for (const p of ps) if (p.status === 'disconnected' && now >= p.goneAt + AWAY_MS) this.setStatus(p, 'away');
    const s = r.game?.state;
    if (s?.deadline && now >= s.deadline) this.step(() => GAMES[r.game.id].timer(this.ctx_(), s));
    if ((r.phase === 'results' || r.phase === 'night') && now >= r.resultsUntil) this.next();
    this.changed();
  }

  schedule() {
    const r = this.room, ps = Object.values(r.players), t = [r.createdAt + LIFE_MS];
    if (!ps.some(p => p.status === 'connected' && !p.bot)) t.push(r.lastActive + IDLE_MS);
    for (const p of ps) if (p.status === 'disconnected') t.push(p.goneAt + AWAY_MS);
    if (r.game?.state.deadline) t.push(r.game.state.deadline);
    if (r.phase === 'results' || r.phase === 'night') t.push(r.resultsUntil);
    const next = Math.min(...t);
    this.ctx.storage.setAlarm(next);
    // Alarms can arrive seconds late. For anything due soon, an in-memory timer does the job on time;
    // alarm() only acts on what is actually due, so whichever fires first wins and the other is a no-op.
    clearTimeout(this.wake);
    if (next - Date.now() < 60e3) this.wake = setTimeout(() => this.room && this.alarm(), Math.max(0, next - Date.now()) + 5);
  }

  // ── game plumbing ──
  ctx_() {
    const r = this.room;
    return {
      now: Date.now(), rng: Math.random, host: r.hostId, clean: r.clean,
      active: Object.values(r.players).filter(p => p.status !== 'away' && !p.spectator).map(p => p.id),
      bots: Object.values(r.players).filter(p => p.bot).map(p => p.id),
    };
  }

  start(gameId, picked) {
    const r = this.room, g = GAMES[gameId];
    for (const p of Object.values(r.players)) p.spectator = false;
    const active = this.ctx_().active.filter(p => g.bot || !r.players[p].bot); // bots sit out games they can't play
    // host may pick who plays (e.g. 2 of 6 for chess); otherwise host + random others up to the max
    const ids = Array.isArray(picked) && picked.length ? active.filter(p => picked.includes(p))
      : [r.hostId, ...shuffle(Math.random, active.filter(p => p !== r.hostId))].filter(p => active.includes(p)).slice(0, g.max);
    if (ids.length < g.min || ids.length > g.max) throw { reject: `${g.name} needs ${g.min === g.max ? g.min : `${g.min}–${g.max}`} players` };
    Object.assign(r, { gameId, phase: 'game', result: null, lastIds: ids, game: { id: gameId, startedAt: Date.now(), state: null } });
    r.game.state = g.init(this.ctx_(), ids, g.settings(r.settings[gameId]));
  }

  // after a game's results: next game of the night (skipping ones that no longer fit), the night's final board, or the lobby
  next() {
    const r = this.room, n = r.night;
    if (n && r.phase === 'results') {
      while (++n.i < n.queue.length) {
        try { return this.start(n.queue[n.i]); } catch (e) { if (!e?.reject) throw e; }
      }
      return Object.assign(r, { phase: 'night', result: null, resultsUntil: Date.now() + 30e3 });
    }
    Object.assign(r, { phase: 'lobby', result: null, night: null });
  }

  step(fn) {
    const points = fn();
    if (!points) return;
    const r = this.room, now = Date.now(), max = Math.max(...Object.values(points));
    const winnerIds = max > 0 ? Object.keys(points).filter(p => points[p] === max) : [];
    for (const [p, v] of Object.entries(points)) if (r.players[p]) r.players[p].score += v;
    r.result = { gameId: r.game.id, points, winnerIds, at: now };
    if (r.night) { // placement points, ties share the better place
      for (const [p, v] of Object.entries(points)) {
        const place = Object.values(points).filter(x => x > v).length;
        r.night.pts[p] = (r.night.pts[p] ?? 0) + (NIGHT_PTS[place] ?? 1);
      }
    }
    r.history = [...r.history, { gameId: r.game.id, startedAt: r.game.startedAt, endedAt: now, points, winnerIds }].slice(-20);
    if (r.crew) this.postCrew(r.game.id, points, winnerIds);
    Object.assign(r, { game: null, phase: 'results', resultsUntil: now + RESULTS_MS });
  }

  // ── crews: finished games go to the linked crew's leaderboard (humans only) ──
  async setCrew(ws, pid, code) {
    const r = this.room;
    if (r.hostId !== pid || r.phase !== 'lobby') return this.send(ws, { t: 'error', code: 'not_host', message: 'Only the host can link a crew' });
    if (code == null) { r.crew = null; return this.changed(); }
    if (!/^[A-HJ-NP-Z]{6}$/.test(String(code))) return this.send(ws, { t: 'error', code: 'invalid_input', message: 'Crew codes are 6 letters' });
    const info = await this.env.CREW.get(this.env.CREW.idFromName(code)).fetch('https://crew/info').then(x => x.json());
    if (!info.exists) return this.send(ws, { t: 'error', code: 'invalid_input', message: 'Crew not found' });
    r.crew = { code, name: info.name, champion: info.champion };
    this.changed();
  }
  async postCrew(gameId, points, winnerIds) {
    const r = this.room, code = r.crew.code, players = {};
    for (const p of Object.keys(points)) {
      if (r.players[p] && !r.players[p].bot) players[p] = { name: r.players[p].name, avatar: r.players[p].avatar, points: points[p], win: winnerIds.includes(p) };
    }
    if (!Object.keys(players).length) return;
    try {
      const res = await this.env.CREW.get(this.env.CREW.idFromName(code))
        .fetch('https://crew/result', { method: 'POST', body: JSON.stringify({ gameId, room: r.code, players }) });
      const { champion } = await res.json();
      if (this.room?.crew?.code === code) { this.room.crew.champion = champion; this.changed(); }
    } catch {} // a leaderboard hiccup must never break the room
  }

  // ── computer players: ask the game what each bot would do, act after a "thinking" delay ──
  drive() {
    const r = this.room, G = GAMES[r.game?.id];
    if (!G?.bot) return;
    const state = r.game.state;
    for (const pid of state.players) {
      if (!r.players[pid]?.bot || this.botTimers.has(pid)) continue;
      const plan = G.bot(this.ctx_(), state, pid);
      if (!plan) continue;
      this.botTimers.set(pid, setTimeout(() => {
        this.botTimers.delete(pid);
        if (this.room?.game?.state !== state) return; // game ended or changed
        try { this.step(() => G.input(this.ctx_(), state, pid, plan.input)); } catch (e) { if (!e?.reject) throw e; } // stale move → ignored
        this.changed();
      }, plan.delay ?? 900));
    }
  }

  // ── live games: tick at G.rt Hz while one runs. Frames go straight out; only s.dirty changes trigger a snapshot + save ──
  tickLoop() {
    const r = this.room, G = GAMES[r?.game?.id];
    if (!G?.rt || this.ticking === r.game.state) return;
    clearInterval(this.ticker);
    const s = (this.ticking = r.game.state);
    let last = Date.now();
    this.ticker = setInterval(() => {
      if (this.room?.game?.state !== s) { clearInterval(this.ticker); this.ticking = null; return; }
      const now = Date.now(), ctx = { ...this.ctx_(), now }, dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      this.step(() => (s.deadline && now >= s.deadline ? G.timer(ctx, s) : G.tick(ctx, s, dt)));
      if (this.room.game?.state !== s || s.dirty || s.phase !== s.shown) { s.dirty = false; s.shown = s.phase; this.changed(); }
      if (this.room.game?.state !== s) return;
      const f = JSON.stringify({ t: 'f', s: now, f: G.frame(s) }); // server time: phones play frames back on a steady clock
      for (const ws of this.ctx.getWebSockets()) try { ws.send(f); } catch {}
    }, 1000 / G.rt);
  }

  setStatus(p, status) {
    const r = this.room;
    p.status = status;
    if (status === 'disconnected') p.goneAt = Date.now();
    if (status === 'away' && r.hostId === p.id) { // host gone > 60 s → longest-connected player takes over
      const next = Object.values(r.players).filter(q => q.status === 'connected' && !q.bot).sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (next) r.hostId = next.id;
    }
    if (r.game) this.checkGame();
  }

  checkGame() {
    const r = this.room, G = GAMES[r.game.id], ctx = this.ctx_();
    if (r.game.state.players.filter(p => ctx.active.includes(p)).length < G.min) {
      Object.assign(r, { game: null, phase: 'lobby' });
      this.event('all', 'toast', 'Not enough players — game ended');
    } else this.step(() => G.status(ctx, r.game.state));
  }

  uniqueName(raw, pid) {
    let base = text(raw, 16) || 'Player';
    if (this.room.clean) base = clean(base);
    const taken = new Set(Object.values(this.room.players).filter(p => p.id !== pid).map(p => p.name));
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${Array.from(base).slice(0, 13).join('')} ${i}`;
    return name;
  }

  // ── output ──
  project(pid) {
    const r = this.room, G = GAMES[r.gameId];
    return {
      code: r.code, you: pid, hostId: r.hostId, phase: r.phase, clean: r.clean, gameId: r.gameId,
      settings: G.settings(r.settings[r.gameId]),
      players: Object.values(r.players).sort((a, b) => a.joinedAt - b.joinedAt)
        .map(({ id, name, avatar, status, score, spectator, bot, lv }) => ({ id, name, avatar, status, score, spectator, bot: !!bot, lv: lv ?? 1 })),
      games: Object.entries(GAMES).map(([id, { name, icon, min, max, secs, desc, bot, rt }]) => ({ id, name, icon, min, max, secs, desc, bots: !!bot, live: !!rt })),
      night: r.night ?? null,
      crew: r.crew ?? null,
      game: r.game && { id: r.game.id, view: GAMES[r.game.id].view(r.game.state, pid) },
      result: r.result, resultsUntil: r.resultsUntil,
    };
  }

  send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch {} }

  event(to, kind, data) {
    for (const ws of to === 'all' ? this.ctx.getWebSockets() : this.ctx.getWebSockets(to)) this.send(ws, { t: 'event', kind, data });
  }

  changed() {
    if (!this.room) return;
    for (const ws of this.ctx.getWebSockets()) {
      const [pid] = this.ctx.getTags(ws);
      if (!pid || (!this.room.players[pid] && !pid.startsWith('tv:'))) continue;
      const s = JSON.stringify({ t: 'snapshot', room: this.project(pid) });
      if (this.sent.get(pid) === s) continue;
      this.sent.set(pid, s);
      try { ws.send(s); } catch {}
    }
    this.schedule();
    this.drive();
    this.tickLoop();
    // ponytail: whole-state rewrite, coalesced over 300 ms; store doodle drawings under their own keys if write volume ever matters
    this.saving ??= setTimeout(() => {
      this.saving = null;
      if (!this.room) return;
      const s = JSON.stringify(this.room), n = Math.ceil(s.length / CHUNK), o = { n };
      for (let i = 0; i < n; i++) o[`c${i}`] = s.slice(i * CHUNK, (i + 1) * CHUNK);
      this.ctx.storage.put(o);
      if (this.n > n) this.ctx.storage.delete(Array.from({ length: this.n - n }, (_, i) => `c${n + i}`));
      this.n = n;
    }, 300);
  }
}
