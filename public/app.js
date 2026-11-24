import { html, render, useState, useEffect, useRef } from '/vendor/preact.js';

// ── prefs (localStorage may be unavailable in private mode) ──
const safe = f => { try { const s = f(); s.setItem('_', '1'); return s; } catch { return null; } };
const ls = safe(() => localStorage), ss = safe(() => sessionStorage);
const get = (k, d) => ls?.getItem(k) ?? d, put = (k, v) => ls?.setItem(k, String(v));
const pid = get('pid') || crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
put('pid', pid);

const EMOJI = [...'🦊🐼🐸🐙🦄🐯🐵🐧🐨🦁🐮🐷🐰🐻🐔🦉🐢🐳🦖🐝'];
const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899'];
const hash = [...pid].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

const TV = /^\/tv(\/|$)/.test(location.pathname); // big-screen mode: watches a room, plays nothing
const S = {
  tv: TV, name: get('name', ''), av: +get('av', hash % 160), theme: get('theme', 'dark'), haptics: get('haptics', '1') === '1', sound: get('sound', '0') === '1',
  screen: null, crew: null, install: null, code: null, lastCode: null, room: null, offline: false, fatal: null, boss: false, settings: false, busy: false, toasts: [], offset: 0,
};
const up = patch => { Object.assign(S, patch); draw(); };
const draw = () => render(html`<${App} />`, document.body);
let toastId = 0;
const toast = text => {
  const t = { id: ++toastId, text };
  up({ toasts: [...S.toasts, t].slice(-3) });
  setTimeout(() => up({ toasts: S.toasts.filter(x => x !== t) }), 2500);
};
const buzz = ms => S.haptics && navigator.vibrate?.(ms);
const now = () => Date.now() + S.offset; // server clock
const P = id => S.room?.players.find(p => p.id === id);
const nameOf = id => P(id)?.name ?? '?';
const Av = ({ a = 0 }) => html`<span class="avatar" style=${`background:${COLORS[Math.floor(a / 20) % 8]}`}>${EMOJI[a % 20]}</span>`;

// ── network ──
const FATAL = { not_found: 'Room not found', room_full: 'Room is full (12/12)', kicked: 'You were removed from this room', session_replaced: 'This room is open in another tab', update_required: 'A new version is out', room_expired: 'This room has expired' };
const ERR = { not_host: 'Only the host can do that', rate_limited: 'Slow down!' };
let ws, retries = 0, retryTimer, bestRtt;
const send = (t, o = {}) => ws?.readyState === 1 && ws.send(JSON.stringify({ v: 1, t, ...o }));
const input = o => send('game_input', { input: o });

function connect() {
  clearTimeout(retryTimer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const who = S.tv ? 'tv=1' : `pid=${pid}&a=${S.av}&lv=${lvOf(prof().xp)}&name=${encodeURIComponent(S.name)}`;
  const sock = (ws = new WebSocket(`${proto}://${location.host}/ws/${S.code}?v=3&${who}`));
  sock.onopen = () => { retries = 0; up({ offline: false }); sync(); };
  sock.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.t === 'f') return onFrame(m); // live-game frame: no re-render, the canvas loop picks it up
    if (m.t === 'snapshot') {
      if (m.room.game?.id === 'tap_duel' && S.room?.game?.id !== 'tap_duel') sync(); // re-sync clock for timed game
      if (m.room.game?.id !== S.room?.game?.id) resetFrames();
      up({ room: m.room });
    } else if (m.t === 'pong') {
      const t = Date.now(), rtt = t - m.c;
      if (rtt < bestRtt) { bestRtt = rtt; S.offset = m.s + rtt / 2 - t; }
    } else if (m.t === 'error') {
      if (FATAL[m.code]) { ss?.removeItem('room'); up({ fatal: m.code, code: null, room: null, offline: false }); }
      else toast(m.message || ERR[m.code] || m.code);
    } else if (m.t === 'event') toast(m.kind === 'reaction' ? `${nameOf(m.data.pid)} ${m.data.emoji}` : m.data);
  };
  sock.onclose = () => {
    if (ws !== sock || !S.code) return;
    up({ offline: true });
    retryTimer = setTimeout(connect, Math.min(8000, 500 * 2 ** retries++) * (0.75 + Math.random() / 2));
  };
}
function sync() {
  bestRtt = Infinity;
  for (let i = 0; i < 5; i++) setTimeout(() => send('ping', { c: Date.now() }), i * 150);
}
const wake = () => !document.hidden && S.code && ws?.readyState === WebSocket.CLOSED && connect();
document.addEventListener('visibilitychange', wake);
addEventListener('online', wake);
addEventListener('touchstart', e => e.touches.length === 2 && !S.boss && up({ boss: true }), { passive: true });
addEventListener('keydown', e => e.key === 'Escape' && up({ boss: !S.boss, settings: false })); // laptop boss key

// ── actions ──
const saveName = () => {
  S.name = S.name.trim();
  if (!S.name) return toast('Pick a nickname first'), false;
  return put('name', S.name), true;
};
async function create() {
  if (!saveName()) return;
  up({ busy: true });
  try { enter((await (await fetch('/api/rooms', { method: 'POST' })).json()).code); }
  catch { toast('Could not create a room'); }
  up({ busy: false });
}
async function join(code) {
  if (!saveName()) return;
  up({ busy: true });
  try {
    const res = await fetch(`/api/rooms/${code}`);
    const info = res.ok ? await res.json() : {};
    if (res.status === 429) toast('Too many tries, wait a minute');
    else if (!info.exists) up({ fatal: 'not_found', lastCode: code });
    else if (info.full) up({ fatal: 'room_full' });
    else enter(code);
  } catch { toast('Network error'); }
  up({ busy: false });
}
function enter(code) {
  history.replaceState(null, '', `${S.tv ? '/tv' : '/r'}/${code}`);
  if (S.tv) navigator.wakeLock?.request('screen').catch(() => {}); // keep the TV awake
  else ss?.setItem('room', code);
  up({ code, lastCode: code, fatal: null, room: null });
  connect();
}
function leave() {
  S.code = null;
  ws?.close();
  ss?.removeItem('room');
  history.replaceState(null, '', S.tv ? '/tv' : '/');
  up({ room: null, offline: false, fatal: null });
}
async function shareText(text) {
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); }
  } catch {}
}
const share = () => shareText(`Join my BackBench room 🎮 ${S.room.code} → ${location.origin}/r/${S.room.code}`);
addEventListener('beforeinstallprompt', e => { e.preventDefault(); up({ install: e }); });
const install = async () => { S.install.prompt(); await S.install.userChoice.catch(() => {}); up({ install: null }); };
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
const LOGO = html`<svg class="mark" viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="112" fill="#1d1640" />
  <circle cx="166" cy="206" r="46" fill="#38bdf8" /><circle cx="256" cy="184" r="52" fill="#ffd23f" /><circle cx="346" cy="206" r="46" fill="#f472b6" />
  <rect x="96" y="290" width="320" height="44" rx="22" fill="#ffd23f" /><rect x="136" y="326" width="32" height="92" rx="12" fill="#ffd23f" /><rect x="344" y="326" width="32" height="92" rx="12" fill="#ffd23f" /></svg>`;

// ── screens ──
function App() {
  const r = S.room;
  const [key, body] = S.fatal ? ['fatal', html`<${Fatal} />`]
    : !S.code ? [`home-${S.screen}-${S.crew}`, S.tv ? html`<${TvHome} />` : S.screen === 'crews' ? html`<${Crews} />` : S.screen === 'profile' ? html`<${Profile} />` : html`<${Home} />`]
    : !r ? ['conn', html`<div class="center"><div class="dots-loader"><i /><i /><i /></div><p class="muted">Joining ${S.code}…</p></div>`]
    : r.phase === 'game' && r.game ? [`game-${r.game.id}`, html`<${GameShell} r=${r} />`]
    : r.phase === 'results' && r.result ? ['results', html`<${Results} r=${r} />`]
    : r.phase === 'night' && r.night ? ['night', html`<${NightFinal} r=${r} />`]
    : ['lobby', S.tv ? html`<${TvLobby} r=${r} />` : html`<${Lobby} r=${r} />`];
  return html`
    ${!S.tv && html`<button class="boss-btn" onClick=${() => up({ boss: true })} aria-label="Hide game">📖</button>`}
    ${S.offline && html`<div class="banner" role="status">Reconnecting…</div>`}
    <div class="screen" key=${key}>${body}</div>
    ${S.settings && html`<${Settings} />`}
    ${S.boss && html`<${Boss} />`}
    <div class="toasts" aria-live="polite">${S.toasts.map(t => html`<div class="toast" key=${t.id}>${t.text}</div>`)}</div>`;
}

function Home() {
  const linked = location.pathname.match(/^\/r\/([a-z]{4})$/i)?.[1].toUpperCase() ?? '';
  const [code, setCode] = useState(linked);
  const reroll = () => { S.av = Math.floor(Math.random() * 160); put('av', S.av); feel('tap', 10); draw(); };
  return html`<main class="home">
    <header class="hero">
      ${LOGO}
      <h1 class="logo">Back<span>Bench</span></h1>
      <p class="tagline">Party games for the last row.</p>
      <div class="chips"><span class="chip">31 games</span><span class="chip">No app</span><span class="chip">No sign-up</span></div>
    </header>
    <div class="panel me">
      <button class="avatar big" style=${`background:${COLORS[Math.floor(S.av / 20) % 8]}`} onClick=${reroll} aria-label="Change avatar" title="Tap for a new avatar">${EMOJI[S.av % 20]}</button>
      <label class="field"><span>Your nickname</span>
        <input value=${S.name} maxlength="16" placeholder="e.g. Rahul" autocomplete="nickname" onInput=${e => (S.name = e.target.value)} /></label>
    </div>
    ${!ls && html`<p class="small warn">Private mode: refreshing may lose your seat.</p>`}
    ${!navigator.onLine && html`<p class="soft">You're offline. Connect to play with friends.</p>`}
    <div class="panel">
      <h3>Join a room</h3>
      <form class="row" onSubmit=${e => { e.preventDefault(); code.length === 4 && join(code); }}>
        <input class="code" value=${code} maxlength="4" placeholder="CODE" aria-label="Room code" autocapitalize="characters" autocomplete="off" spellcheck="false"
          onInput=${e => { const v = e.target.value.toUpperCase().replace(/[^A-HJ-NP-Z]/g, ''); e.target.value = v; setCode(v); }} />
        <button class="btn ${linked ? 'primary' : ''}" disabled=${code.length !== 4 || S.busy}>Join</button>
      </form>
    </div>
    <button class="btn ${linked ? '' : 'primary'} big" disabled=${S.busy} onClick=${create}>Create a room</button>
    <p class="small muted center-text">Playing alone? Create a room and add computer players.</p>
    <nav class="home-links">
      <button class="link" onClick=${() => up({ screen: 'profile' })}>🏅 Lv ${lvOf(prof().xp)}</button>
      <button class="link" onClick=${() => up({ screen: 'crews' })}>🏆 Crews</button>
      ${S.install && html`<button class="link" onClick=${install}>📲 Install app</button>`}
      <button class="link" onClick=${() => up({ settings: true })}>⚙ Settings</button>
    </nav>
  </main>`;
}

function Fatal() {
  const f = S.fatal;
  return html`<main class="center">
    <h2>${FATAL[f]}</h2>
    ${f === 'update_required' && html`<button class="btn primary" onClick=${() => location.reload()}>Reload</button>`}
    ${f === 'session_replaced' && html`<button class="btn primary" onClick=${() => enter(S.lastCode)}>Play here instead</button>`}
    ${(f === 'not_found' || f === 'room_expired') && !S.tv && html`<button class="btn primary" onClick=${() => { up({ fatal: null }); create(); }}>Create one instead</button>`}
    <button class="btn" onClick=${leave}>Home</button>
  </main>`;
}

const CAT = { '1 player': 'solo', '2 players': 'duo', '2+ players': 'two', '3+ players': 'three', '4+ players': 'four' };
function Lobby({ r }) {
  const host = r.hostId === r.you, [modal, setModal] = useState(null), playersRef = useAuto();
  const count = g => r.players.filter(p => p.status !== 'away' && (g.bots || !p.bot)).length; // bots only count where they can play
  const sel = r.games.find(g => g.id === r.gameId), fits = g => count(g) >= g.min, n = count(sel); // extra people watch
  const [picked, setPicked] = useState([]);
  useEffect(() => setPicked([]), [r.gameId]);
  const toggle = id => setPicked(pk => (pk.includes(id) ? pk.filter(x => x !== id) : [...pk, id].slice(-sel.max)));
  // group by player count: 1 player · 2 players · 2+ · 3+ · 4+
  const label = g => (g.min === 1 ? '1 player' : g.max === 2 ? '2 players' : `${g.min}+ players`);
  const sorted = [...r.games].sort((a, b) => a.min - b.min || (b.max === 2) - (a.max === 2));
  const groups = [...new Set(sorted.map(label))].map(l => [l, sorted.filter(g => label(g) === l)]);
  const range = g => (g.min === g.max ? `${g.min} players` : `${g.min}–${g.max} players`);
  return html`<main class="lobby">
    <header class="room-head">
      <div><div class="small muted">Room code</div><div class="code-tiles big" aria-label=${`Room code ${r.code}`}>${[...r.code].map((c, i) => html`<span key=${i}>${c}</span>`)}</div></div>
      <div class="row"><button class="btn" onClick=${() => setModal('qr')} aria-label="Show QR code">▦ QR</button>
        <button class="btn" onClick=${() => open(`/tv/${r.code}`, '_blank')} title="Open the big-screen view on a laptop or TV">📺 TV</button>
        <button class="btn primary" onClick=${share}>Invite</button></div>
    </header>
    ${r.crew ? html`<div class="crew-banner"><button class="link-plain" onClick=${() => setModal('crew')}>🏆 Playing for <b>${r.crew.name}</b> · <span class="muted">leaderboard →</span></button>
        ${host && html`<button class="icon" aria-label="Unlink crew" onClick=${() => send('set_crew', { code: null })}>✕</button>`}</div>`
      : host && html`<button class="crew-banner ghost" onClick=${() => setModal('link')}>🏆 Play for a crew <span class="muted small">· keep score across days</span></button>`}
    <section class="col">
      <h3>Players · ${r.players.length}/12</h3>
      <ul class="players" ref=${playersRef}>${r.players.map(p => html`<li class=${p.status} key=${p.id}>
        <${Av} a=${p.avatar} />
        <span class="pname">${p.name}${p.id === r.you ? ' (you)' : ''} ${p.id === r.hostId ? '👑' : ''}${r.crew?.champion === p.id ? html` <span title="Champion of the week">🏆</span>` : ''}${!p.bot && html` <span class="lv">Lv ${p.lv}</span>`}
          ${p.status !== 'connected' && html`<span class="small muted"> ${p.status === 'away' ? 'away' : 'reconnecting…'}</span>`}</span>
        <span class="score" title="Room score">${p.score}</span>
        ${host && p.id !== r.you && html`
          ${!p.bot && html`<button class="icon" aria-label=${`Make ${p.name} host`} onClick=${() => confirm(`Make ${p.name} the host?`) && send('transfer_host', { pid: p.id })}>👑</button>`}
          <button class="icon" aria-label=${`Remove ${p.name}`} onClick=${() => (p.bot || confirm(`Kick ${p.name}? They can't rejoin this room.`)) && send('kick', { pid: p.id })}>✕</button>`}
      </li>`)}</ul>
      ${host && r.players.length < 12 && html`<button class="btn ghost" onClick=${() => send('add_bot')}>🤖 Add a computer player</button>`}
    </section>
    <section class="col">
      ${groups.map(([l, gs]) => html`<div key=${l} class="group">
        <h3>${l}</h3>
        <div class="carousel">${gs.map(g => html`
          <button key=${g.id} data-cat=${CAT[l]} class="game-card ${g.id === r.gameId ? 'sel' : ''}" disabled=${!fits(g) && g.id !== r.gameId}
            aria-pressed=${g.id === r.gameId} onClick=${() => host && (g.id === r.gameId && fits(g) ? send('start_game', { players: picked }) : send('select_game', { gameId: g.id }))}>
            <span class="gicon">${g.icon}</span><b>${g.name}${g.live ? html` <span class="live-tag">LIVE</span>` : ''}</b>
            <span class="small muted">${g.desc}</span>
            <span class="small">${range(g)} · ~${Math.max(1, Math.round(g.secs / 60))} min${g.bots ? ' · 🤖 ok' : ''}</span>
            ${!fits(g) && html`<span class="small warn">Needs ${g.min}+ ${g.bots ? 'players' : 'people'}</span>`}
            ${host && g.id === r.gameId && fits(g) && html`<span class="again">Tap again to start ▶</span>`}
          </button>`)}</div></div>`)}
      ${host && html`<${GameSettings} r=${r} />`}
      ${!sel.bots && r.players.some(p => p.bot) && html`<p class="small muted">🤖 Computer players sit this one out.</p>`}
      ${host && n > sel.max && html`<div class="group">
        <h3>Who plays? <span class="small">(pick ${sel.min === sel.max ? sel.max : `up to ${sel.max}`} · default: you + random)</span></h3>
        <div class="chips">${r.players.filter(p => p.status !== 'away' && (sel.bots || !p.bot)).map(p => html`<button key=${p.id} class="chip pickable ${picked.includes(p.id) ? 'on' : ''}"
          aria-pressed=${picked.includes(p.id)} onClick=${() => toggle(p.id)}>${p.name}</button>`)}</div></div>`}
      ${host ? html`<button class="btn primary big" disabled=${!fits(sel)} onClick=${() => send('start_game', { players: picked })}>Start ${sel.name}</button>
          <button class="btn" onClick=${() => setModal('night')}>🌙 Plan a Game Night</button>`
        : html`<p class="soft">Waiting for ${nameOf(r.hostId)} to start ${sel.name}…</p>`}
      <button class="link" onClick=${leave}>Leave room</button>
    </section>
    ${modal === 'qr' && html`<${QR} onClose=${() => setModal(null)} />`}
    ${modal === 'link' && html`<${CrewLink} onClose=${() => setModal(null)} />`}
    ${modal === 'night' && html`<${NightSheet} games=${r.games.filter(fits)} onClose=${() => setModal(null)} />`}
    ${modal === 'crew' && r.crew && html`<${CrewBoard} modal code=${r.crew.code} onBack=${() => setModal(null)} />`}
  </main>`;
}

const ROUND_OPTS = { tap_duel: [3, 5, 7, 10], imposter: [1, 2, 3, 4, 5], who_said: [1, 2, 3], bomb: [1, 2, 3, 4, 5], emoji: [5, 8, 10, 12, 15], tictactoe: [1, 3, 5], four_row: [1, 3, 5], sumo: [1, 3, 5, 7, 9], snake: [1, 3, 5, 7, 9] };
function GameSettings({ r }) {
  const s = r.settings, set = patch => send('update_game_settings', { settings: { ...s, ...patch } });
  const pick = (label, key, opts) => html`<label class="setting">${label}
    <select value=${s[key]} onChange=${e => set({ [key]: +e.target.value })}>${(opts ?? [s[key]]).map(o => html`<option value=${o}>${o}</option>`)}</select></label>`;
  return html`<div class="settings-row">
    ${'rounds' in s && pick(r.gameId === 'emoji' ? 'Puzzles' : 'Rounds', 'rounds', ROUND_OPTS[r.gameId])}
    ${'clueSec' in s && pick('Clue time (s)', 'clueSec', [10, 15, 20, 30, 45, 60])}
    ${'minutes' in s && (r.gameId === 'kickabout' ? pick('Match (min)', 'minutes', [1, 2, 3, 5]) : pick('Clock (min each)', 'minutes', [1, 3, 5, 10, 15]))}
    ${'size' in s && pick('Board size', 'size', r.gameId === 'mines' ? [8, 9, 10, 12, 14, 16] : [3, 4, 5, 6])}
    ${'start' in s && pick('Starting cards', 'start', [5, 7, 10])}
    ${'hard' in s && html`<label class="setting"><input type="checkbox" checked=${s.hard} onChange=${e => set({ hard: e.target.checked })} /> Hard mode</label>`}
    <label class="setting"><input type="checkbox" checked=${r.clean} onChange=${e => send('set_clean', { on: e.target.checked })} /> Clean mode</label>
  </div>`;
}

function Podium({ rows, fmt = n => `${n > 0 ? '+' : ''}${n}` }) {
  return html`<div class="podium">${[1, 0, 2].filter(i => rows[i]).map(i => { const [id, pts] = rows[i]; return html`<div key=${id} class="step s${i}">
      <${Av} a=${P(id)?.avatar} /><b class="pname">${nameOf(id)}</b><span class="pts">${fmt(pts)}</span><div class="block">${i + 1}</div></div>`; })}</div>
    ${rows.length > 3 && html`<ol class="rows" start="4">${rows.slice(3).map(([id, pts], i) => html`<li key=${id}>
      <span class="rank">${i + 4}</span><${Av} a=${P(id)?.avatar} /><span class="pname">${nameOf(id)}</span><span class="pts ${pts < 0 ? 'neg' : ''}">${fmt(pts)}</span></li>`)}</ol>`}`;
}
// room standings: shown in the old order first, then they slide into the new one
function Standings({ r }) {
  const gain = r.result.points, ref = useAuto(), [after, setAfter] = useState(false);
  useEffect(() => { const t = setTimeout(() => setAfter(true), 900); return () => clearTimeout(t); }, []);
  const total = p => p.score - (after ? 0 : gain[p.id] ?? 0), max = Math.max(1, ...r.players.map(p => p.score));
  const rows = [...r.players].sort((a, b) => total(b) - total(a));
  return html`<div class="panel standings"><h3>Room standings</h3>
    <ol class="rows" ref=${ref}>${rows.map((p, i) => html`<li key=${p.id} class=${p.id === r.you ? 'me' : ''}>
      <span class="rank">${i + 1}</span><${Av} a=${p.avatar} /><span class="pname">${p.name}<span class="sbar"><i style=${`width:${(100 * Math.max(0, total(p))) / max}%`} /></span></span>
      ${gain[p.id] ? html`<span class="gain">+${gain[p.id]}</span>` : null}<b class="pts">${total(p)}</b></li>`)}</ol></div>`;
}
function Countdown({ until }) {
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick(x => x + 1), 200); return () => clearInterval(i); }, []);
  const left = Math.max(0, until - now());
  return html`<div class="countdown" aria-hidden="true"><i style=${`width:${Math.min(100, (left / 8000) * 100)}%`} /></div>`;
}
function Results({ r }) {
  const res = r.result, g = r.games.find(x => x.id === res.gameId), n = r.night;
  const rows = Object.entries(res.points).sort((a, b) => b[1] - a[1]), won = res.winnerIds.includes(r.you);
  const [rec] = useState(() => (S.tv ? null : record(r)));
  useEffect(() => { if (res.winnerIds.length) confetti(); feel(won ? 'win' : 'end', won ? [60, 60, 120] : 40); }, []);
  const nextUp = n && n.i + 1 < n.queue.length ? r.games.find(x => x.id === n.queue[n.i + 1]) : null;
  return html`<main class="results">
    <p class="muted center-text">${g.icon} ${g.name}</p>
    <h1 class="title center-text">${won ? 'You win!' : res.winnerIds.length ? `${res.winnerIds.map(nameOf).join(' & ')} ${res.winnerIds.length > 1 ? 'win' : 'wins'}!` : 'Game over'}</h1>
    <${Podium} rows=${rows} />
    ${rec && html`<${XpGain} rec=${rec} />`}
    ${n ? html`<${NightTable} r=${r} />` : html`<${Standings} r=${r} />`}
    ${r.hostId !== r.you && html`<${Countdown} until=${r.resultsUntil} />`}
    ${r.crew && html`<p class="small muted center-text">🏆 Counted for ${r.crew.name}</p>`}
    ${r.hostId === r.you ? (n ? html`<button class="btn primary big" onClick=${() => send('back_to_lobby')}>${nextUp ? `Next: ${nextUp.icon} ${nextUp.name} →` : 'Final standings →'}</button>`
      : html`<div class="row end-row"><button class="btn primary big" onClick=${() => send('play_again')}>↻ Play again</button><button class="btn big" onClick=${() => send('back_to_lobby')}>Back to lobby</button></div>`)
      : html`<p class="soft">${n ? 'Next game in a moment…' : 'Back to the lobby in a moment…'}</p>`}
  </main>`;
}

// ── Game Night: games back to back, placement points per game, one champion ──
function NightSheet({ games, onClose }) {
  const [q, setQ] = useState([]);
  const toggle = id => setQ(x => (x.includes(id) ? x.filter(y => y !== id) : [...x, id].slice(0, 10)));
  const surprise = () => setQ(games.map(g => [Math.random(), g.id]).sort((a, b) => a[0] - b[0]).slice(0, 5).map(x => x[1]));
  return html`<div class="modal" onClick=${e => e.target === e.currentTarget && onClose()}><div class="sheet tall">
    <h2>🌙 Game Night</h2>
    <p class="muted small">Tap games in the order you want to play them. They run back to back with one scoreboard: each game gives 10 points for 1st, then 7, 5, 3, and 1 for everyone else.</p>
    <button class="btn" onClick=${surprise}>🎲 Surprise me (5 games)</button>
    <div class="chips night-pick">${games.map(g => { const i = q.indexOf(g.id); return html`<button key=${g.id} class="chip pickable ${i >= 0 ? 'on' : ''}" aria-pressed=${i >= 0} onClick=${() => toggle(g.id)}>
      ${i >= 0 && html`<b class="nnum">${i + 1}</b> `}${g.icon} ${g.name}</button>`; })}</div>
    <button class="btn primary big" disabled=${q.length < 2} onClick=${() => { send('start_night', { queue: q }); onClose(); }}>Start the night · ${q.length} games</button>
    <button class="btn" onClick=${onClose}>Cancel</button></div></div>`;
}
function NightTable({ r }) {
  const n = r.night, rows = Object.entries(n.pts).sort((a, b) => b[1] - a[1]);
  return html`<div class="panel"><h3>🌙 Game Night · game ${Math.min(n.i + 1, n.queue.length)} of ${n.queue.length}</h3>
    <div class="chips">${n.queue.map((id, i) => html`<span key=${i} class="chip ${i === n.i ? 'on' : i < n.i ? 'done' : ''}">${r.games.find(g => g.id === id)?.icon}</span>`)}</div>
    <ol class="rows">${rows.map(([id, pts], i) => html`<li key=${id}><span class="rank">${i + 1}</span><${Av} a=${P(id)?.avatar} /><span class="pname">${nameOf(id)}</span><span class="pts">${pts}</span></li>`)}</ol></div>`;
}
function NightFinal({ r }) {
  const rows = Object.entries(r.night.pts).sort((a, b) => b[1] - a[1]), champs = rows.filter(x => x[1] === rows[0]?.[1]).map(x => x[0]);
  const [rec] = useState(() => (S.tv ? null : recordNight(r, champs)));
  useEffect(() => { confetti(); feel(champs.includes(r.you) ? 'win' : 'end', 60); }, []);
  return html`<main class="results">
    <p class="muted center-text">🌙 Game Night · ${r.night.queue.length} games</p>
    <h1 class="title center-text">${champs.includes(r.you) ? 'You rule the night!' : `${champs.map(nameOf).join(' & ')} ${champs.length > 1 ? 'rule' : 'rules'} the night!`}</h1>
    <${Podium} rows=${rows} fmt=${x => `${x} pts`} />
    ${rec && html`<${XpGain} rec=${rec} />`}
    ${r.hostId === r.you ? html`<button class="btn primary big" onClick=${() => send('back_to_lobby')}>Back to lobby</button>` : html`<p class="soft">Back to the lobby soon…</p>`}
  </main>`;
}

function Timer({ at }) {
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick(x => x + 1), 250); return () => clearInterval(i); }, []);
  if (!at) return null;
  const s = Math.max(0, Math.ceil((at - now()) / 1000));
  return html`<span class="timer ${s <= 5 ? 'low' : ''}">${s}s</span>`;
}

function GameShell({ r }) {
  const g = r.games.find(x => x.id === r.game.id), v = r.game.view;
  const Game = {
    tap_duel: TapDuel, imposter: Imposter, doodle: Doodle, who_said: WhoSaid, bomb: Bomb, emoji: EmojiDecode,
    chess: ChessBoard, tictactoe: Duel, four_row: Duel, dots: Dots, mines: Mines,
    keepy: Arcade, bin_toss: Arcade, sweet_spot: Arcade, penalty: Penalty, hockey: Live, sumo: Live, snake: Live, land: Live, paint: Live, kickabout: Live, volley: Live, hill: Live, tag: Live, coins: Live, trails: Live, redlight: RedLight, tug: Tug, type_race: TypeRace, bluff: Bluff, clash: Clash,
  }[r.game.id];
  const myTurn = v.turn === r.you && ['play', 'bid', 'clues'].includes(v.phase);
  useEffect(() => { if (myTurn) feel('turn', 50); }, [myTurn]);
  return html`<div class="shell">
    <header class="topbar">
      <span class="gname">${g.icon} ${g.name}</span>
      ${r.night && html`<span class="chip">🌙 ${r.night.i + 1}/${r.night.queue.length}</span>`}
      <${Timer} at=${v.ends ?? v.deadline} />
      ${r.hostId === r.you && html`<button class="link small" onClick=${() => confirm('End the game for everyone? No points are awarded.') && send('end_game')}>End</button>`}
    </header>
    ${S.tv ? null : P(r.you)?.spectator ? html`<p class="soft">Spectating — you'll play next game</p>`
      : v.players && !v.players.includes(r.you) ? html`<p class="soft">Watching — you're not in this one</p>` : null}
    <${Game} v=${v} r=${r} id=${r.game.id} />
  </div>`;
}

// ── Tap Duel ──
function TapDuel({ v, r }) {
  const el = useRef(), st = useRef({});
  useEffect(() => {
    st.current = { sent: v.mine != null, shown: 0 };
    if (v.phase !== 'go' || v.mine != null) return;
    let alive = true;
    const wait = () => requestAnimationFrame(t => {
      if (!alive) return;
      if (now() < v.goAt) return wait();
      el.current.dataset.go = ''; // direct DOM write: no render delay between GO and paint
      st.current.shown = t;
      feel('go', 40);
    });
    const to = setTimeout(wait, Math.max(0, v.goAt - now() - 40));
    return () => { alive = false; clearTimeout(to); };
  }, [v.round, v.phase, v.goAt]);

  const tap = e => {
    const s = st.current;
    if (s.sent || S.boss || !['armed', 'go'].includes(v.phase)) return;
    s.sent = true;
    if (!s.shown) { input({ early: true }); buzz(200); }
    else input({ ms: Math.round(e.timeStamp - s.shown) });
  };
  const tapRef = useRef();
  tapRef.current = tap;
  useEffect(() => {
    const k = e => { if ((e.code === 'Space' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); tapRef.current(e); } };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);
  if (v.phase === 'result') return html`<${TapResult} v=${v} />`;
  const m = v.mine;
  const msg = v.phase === 'countdown' ? `Round ${v.round}/${v.rounds}\nGet ready…`
    : m === 'false' ? 'Too early! −5' : typeof m === 'number' ? `${m} ms` : m === 'miss' ? 'Too slow' : null;
  return html`<div class="tap" key=${v.round} ref=${el} onPointerDown=${tap} role="button" aria-label="Tap area">
    ${msg ? html`<b style="white-space:pre-line">${msg}</b>` : html`<div><b class="wait">Wait…</b><b class="now">TAP!</b></div>`}
  </div>`;
}
function TapResult({ v }) {
  if (v.voided) return html`<div class="center"><h2>Everyone jumped the gun!</h2><p class="muted">Replaying the round…</p></div>`;
  const val = x => (typeof x === 'number' ? x : x === 'miss' ? 1e6 : 2e6);
  const rows = Object.entries(v.last).sort((a, b) => val(a[1].r) - val(b[1].r));
  return html`<h3>Round ${v.round}/${v.rounds}</h3>
    <ol class="rows">${rows.map(([id, x]) => html`<li key=${id}><${Av} a=${P(id)?.avatar} /><span class="pname">${nameOf(id)}</span>
      <span class="muted">${typeof x.r === 'number' ? `${x.r} ms` : x.r === 'false' ? 'false start' : 'miss'}</span>
      <span class="pts ${x.pts < 0 ? 'neg' : ''}">${x.pts > 0 ? '+' : ''}${x.pts}</span></li>`)}</ol>`;
}

// ── Imposter Word ──
function Card({ card }) {
  const [show, setShow] = useState(false), off = () => setShow(false);
  if (!card) return null;
  return html`<div class="card ${show ? 'open' : ''}" onPointerDown=${() => setShow(true)} onPointerUp=${off} onPointerLeave=${off} onPointerCancel=${off} onContextMenu=${e => e.preventDefault()}>
    ${!show ? html`<span class="muted">Hold to reveal your card</span>`
      : card.imposter ? html`<b>You are the IMPOSTER</b><span>Category: ${card.category}</span>`
      : html`<span class="small muted">${card.category}</span><b>${card.word}</b>`}
  </div>`;
}
function Clues({ v }) {
  return html`<ul class="clues">${v.clues.map(c => html`<li key=${c.pid}><${Av} a=${P(c.pid)?.avatar} /><span>${nameOf(c.pid)}</span>
    <span class="bubble">${c.clue ?? html`<i class="muted">(no clue)</i>`}</span></li>`)}</ul>`;
}
function Imposter({ v, r }) {
  const [txt, setTxt] = useState('');
  const myTurn = v.phase === 'clues' && v.turn === r.you, host = r.hostId === r.you;
  useEffect(() => { setTxt(''); }, [myTurn, v.phase, v.round]);
  const form = (key, ph, max) => html`<form class="row" onSubmit=${e => { e.preventDefault(); txt && input({ [key]: txt }); }}>
    <input value=${txt} maxlength=${max} placeholder=${ph} aria-label=${ph} autocomplete="off"
      onInput=${e => setTxt(key === 'clue' ? e.target.value.replace(/\s/g, '') : e.target.value)} />
    <button class="btn primary">Send</button></form>`;
  const head = html`<h3>Round ${v.round}/${v.rounds}</h3>`;

  if (v.phase === 'reveal') return html`${head}<${Card} card=${v.card} /><p class="soft">Memorise it. Don't show anyone!</p>`;
  if (v.phase === 'clues') return html`${head}<${Card} card=${v.card} /><${Clues} v=${v} />
    ${myTurn ? form('clue', 'Your one-word clue', 20) : html`<p class="soft">Waiting for ${nameOf(v.turn)}'s clue…</p>`}`;
  if (v.phase === 'discuss') return html`${head}<${Clues} v=${v} />
    <p class="soft">Discuss! Who's faking it?</p>
    <div class="reacts">${['👀', '🤔', '😂', '😱'].map(e => html`<button onClick=${() => send('react', { emoji: e })} aria-label=${`React ${e}`}>${e}</button>`)}</div>
    ${host && html`<button class="btn" onClick=${() => input({ skip: true })}>Skip to vote</button>`}`;
  if (v.phase === 'vote') return html`${head}<p class="soft">Vote for the imposter · ${v.votedCount}/${v.players.length} voted</p>
    ${v.card ? html`<div class="grid">${v.players.filter(p => p !== r.you).map(p => html`<button key=${p} class=${v.voted === p ? 'sel' : ''} aria-pressed=${v.voted === p}
      onClick=${() => input({ vote: p })}><${Av} a=${P(p)?.avatar} /> ${nameOf(p)}</button>`)}</div>` : null}
    <${Clues} v=${v} />`;
  const imps = v.imps?.map(nameOf).join(' & ');
  if (v.phase === 'reveal_result') return html`${head}
    <h2>${v.caught ? `Caught! ${nameOf(v.caught)} was the imposter` : `${imps} escaped!`}</h2>
    ${v.caught && v.imps.length > 1 && html`<p class="muted">Imposters: ${imps}</p>`}
    <ul class="rows">${Object.entries(v.votes).map(([a, b]) => html`<li key=${a}><span class="pname">${nameOf(a)} → ${nameOf(b)}</span></li>`)}</ul>`;
  if (v.phase === 'imposter_guess') return v.caught === r.you
    ? html`<h2>Last chance!</h2><p class="soft">Guess the secret word</p>${form('guess', 'The secret word', 40)}`
    : html`<p class="soft">${nameOf(v.caught)} is guessing the word…</p>`;
  // round_result
  const pts = Object.entries(v.roundPts).filter(([, n]) => n).sort((a, b) => b[1] - a[1]);
  return html`${head}<h2>The word was “${v.word}”</h2>
    ${v.guess != null && html`<p class="muted">${nameOf(v.caught)} guessed “${v.guess}”</p>`}
    <ul class="rows">${pts.map(([id, n]) => html`<li key=${id}><${Av} a=${P(id)?.avatar} /><span class="pname">${nameOf(id)}</span><span class="pts">+${n}</span></li>`)}</ul>`;
}

// ── Doodle Telephone ──
const PAL = ['#111827', '#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#ffffff']; // 8 = eraser
const SIZES = [3, 8, 18], W = 360, H = 480, LIMIT = 48 * 1024;
function stroke(x, { c, w, p }) {
  x.strokeStyle = PAL[c]; x.lineWidth = SIZES[w]; x.lineCap = x.lineJoin = 'round';
  x.beginPath(); x.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) x.lineTo(p[i], p[i + 1]);
  if (p.length === 2) x.lineTo(p[0] + 0.1, p[1]);
  x.stroke();
}
function paint(canvas, strokes) {
  const x = canvas.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
  strokes.forEach(s => stroke(x, s));
}
// Ramer–Douglas–Peucker
function rdp(pts, eps = 1.5) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts.at(-1)], dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  let max = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const t = L ? Math.max(0, Math.min(1, ((pts[i][0] - a[0]) * dx + (pts[i][1] - a[1]) * dy) / L)) : 0;
    const d = Math.hypot(pts[i][0] - a[0] - t * dx, pts[i][1] - a[1] - t * dy);
    if (d > max) { max = d; idx = i; }
  }
  return max > eps ? [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)] : [a, b];
}
function Sketch({ strokes }) {
  const c = useRef();
  useEffect(() => { c.current && paint(c.current, strokes); }, [strokes]);
  return strokes.length ? html`<canvas ref=${c} width=${W} height=${H} />` : html`<p class="soft">(blank canvas)</p>`;
}
function DrawPad({ skey, prompt, ends }) {
  const c = useRef(), cur = useRef(null), [, bump] = useState(0);
  const strokes = useRef(null);
  if (!strokes.current) { try { strokes.current = JSON.parse(ss?.getItem(skey)) || []; } catch { strokes.current = []; } }
  const [col, setCol] = useState(0), [size, setSize] = useState(1);
  const submit = () => input({ drawing: strokes.current });
  const repaint = () => { paint(c.current, strokes.current); bump(x => x + 1); };
  useEffect(() => {
    repaint();
    const save = setInterval(() => ss?.setItem(skey, JSON.stringify(strokes.current)), 2000);
    const to = setTimeout(submit, Math.max(0, ends - now())); // partial drawing counts
    return () => { clearInterval(save); clearTimeout(to); };
  }, []);
  const pos = e => {
    const b = c.current.getBoundingClientRect();
    return [Math.round(((e.clientX - b.left) * W) / b.width), Math.round(((e.clientY - b.top) * H) / b.height)];
  };
  const used = JSON.stringify(strokes.current).length / LIMIT;
  const down = e => {
    if (used >= 1) return toast('Canvas is full');
    c.current.setPointerCapture(e.pointerId);
    cur.current = { c: col, w: size, pts: [pos(e)] };
    stroke(c.current.getContext('2d'), { c: col, w: size, p: pos(e) });
  };
  const move = e => {
    const s = cur.current, p = pos(e), last = s?.pts.at(-1);
    if (!s || (p[0] === last[0] && p[1] === last[1])) return;
    s.pts.push(p);
    stroke(c.current.getContext('2d'), { c: s.c, w: s.w, p: [...last, ...p] });
  };
  const end = () => {
    const s = cur.current;
    if (!s) return;
    cur.current = null;
    strokes.current.push({ c: s.c, w: s.w, p: rdp(s.pts).flat() });
    if (JSON.stringify(strokes.current).length > LIMIT) { strokes.current.pop(); toast('Canvas is full'); }
    repaint();
  };
  return html`<p class="soft">Draw: <b>${prompt}</b></p>
    <canvas ref=${c} width=${W} height=${H} onPointerDown=${down} onPointerMove=${move} onPointerUp=${end} onPointerCancel=${end} />
    <div class="tools">
      ${PAL.map((p, i) => html`<button class="sw ${col === i ? 'sel' : ''}" style=${`background:${p}`} onClick=${() => setCol(i)} aria-label=${i === 8 ? 'Eraser' : `Colour ${i + 1}`}>${i === 8 ? '⌫' : ''}</button>`)}
    </div>
    <div class="tools">
      ${SIZES.map((s, i) => html`<button class="btn ${size === i ? 'primary' : ''}" onClick=${() => setSize(i)} aria-label=${`Pen size ${i + 1}`}>${['S', 'M', 'L'][i]}</button>`)}
      <button class="btn" onClick=${() => { strokes.current.pop(); repaint(); }}>Undo</button>
      <button class="btn" onClick=${() => { strokes.current = []; repaint(); }}>Clear</button>
    </div>
    ${used >= 0.8 && html`<p class="small warn">Canvas ${Math.round(used * 100)}% full</p>`}
    <button class="btn primary big" onClick=${submit}>Done</button>`;
}
function TextStep({ v }) {
  const [t, setT] = useState(''), ref = useRef('');
  ref.current = t;
  useEffect(() => { const to = setTimeout(() => input({ text: ref.current }), Math.max(0, v.ends - now())); return () => clearTimeout(to); }, []);
  const write = v.phase === 'write';
  return html`
    ${write ? html`<p class="soft">Write something for the next person to draw</p>` : html`<p class="soft">What is this drawing?</p><${Sketch} strokes=${v.me.prev.v} />`}
    <form class="row" onSubmit=${e => { e.preventDefault(); input({ text: t }); }}>
      <input value=${t} maxlength="40" placeholder=${write ? 'A funny prompt' : 'Your guess'} aria-label=${write ? 'Prompt' : 'Guess'} autocomplete="off" onInput=${e => setT(e.target.value)} />
      <button class="btn primary">Done</button>
    </form>
    ${write && html`<button class="link" onClick=${() => setT(v.me.suggest)}>🎲 Random prompt</button>`}`;
}
function Doodle({ v, r }) {
  if (v.phase === 'reveal') {
    const host = r.hostId === r.you;
    return html`<h3>Chain ${v.rv + 1} of ${v.chains}</h3>
      <div class="chain">${v.chain.map((e, k) => html`<div class="entry" key=${`${v.rv}.${k}`}>
        <div class="by"><${Av} a=${P(e.pid)?.avatar} />${nameOf(e.pid)} ${k === 0 ? 'wrote' : e.kind === 'draw' ? 'drew' : 'guessed'}</div>
        ${e.kind === 'draw' ? html`<${Sketch} strokes=${e.v} />` : html`<p class="bubble"><b>${e.v}</b></p>`}
        ${e.pid !== r.you && html`<button class="like ${e.liked ? 'on' : ''}" aria-pressed=${e.liked} aria-label="Like" onClick=${() => input({ like: `${v.rv}.${k}` })}>👍</button>`}
      </div>`)}</div>
      ${host ? html`<button class="btn primary big" onClick=${() => input({ next: true })}>${v.rv + 1 < v.chains ? 'Next chain →' : 'Finish'}</button>`
        : html`<p class="soft">The host is revealing the chains</p>`}`;
  }
  const step = html`<h3>Step ${v.step + 1}/${v.steps}</h3>`;
  if (!v.me) return html`${step}<p class="soft">Spectating…</p>`;
  if (v.me.submitted) return html`${step}<p class="soft">Waiting for others… ${v.done}/${v.steps}</p>`;
  const key = `${r.code}:${v.step}`;
  return html`${step}${v.phase === 'draw'
    ? html`<${DrawPad} key=${key} skey=${key} prompt=${v.me.prev.v} ends=${v.ends} />`
    : html`<${TextStep} key=${key} v=${v} />`}`;
}

// ── shared bits for text games ──
function Ask({ ph, max = 40, onSend, strip }) {
  const [t, setT] = useState('');
  return html`<form class="row" onSubmit=${e => { e.preventDefault(); t.trim() && onSend(t, () => setT('')); }}>
    <input value=${t} maxlength=${max} placeholder=${ph} aria-label=${ph} autocomplete="off" autocapitalize="off" spellcheck="false"
      onInput=${e => setT(strip ? strip(e.target.value) : e.target.value)} />
    <button class="btn primary">Send</button></form>`;
}
const PickPlayer = ({ ids, sel, onPick }) => html`<div class="grid">${ids.map(p => html`<button key=${p} class=${sel === p ? 'sel' : ''}
  aria-pressed=${sel === p} onClick=${() => onPick(p)}><${Av} a=${P(p)?.avatar} /> ${nameOf(p)}</button>`)}</div>`;
const Head = ({ v, children }) => html`<h3>Round ${v.round}/${v.rounds}</h3>${children}`;

// ── Who Said It? ──
function WhoSaid({ v, r }) {
  const me = v.players.includes(r.you);
  const head = html`<${Head} v=${v}><p class="prompt">${v.prompt}</p></${Head}>`;
  if (v.phase === 'answer') return html`${head}
    ${!me || v.wrote ? html`<p class="soft">Answers in: ${v.answered}/${v.players.length}</p>`
      : html`<${Ask} key=${v.round} ph="Your anonymous answer" max=${80} onSend=${t => input({ answer: t })} />`}`;
  const card = html`<p class="small muted">Answer ${v.idx + 1} of ${v.count}</p><blockquote class="quote">${v.answer ?? 'Nobody answered 🤷'}</blockquote>`;
  if (v.phase === 'guess') return html`${head}${card}
    ${v.mine ? html`<p class="soft">This one's yours 🤫 Keep a straight face</p>`
      : me ? html`<p class="soft">Who wrote it? · ${v.guessedCount} guessed</p>
        <${PickPlayer} ids=${v.players.filter(p => p !== r.you)} sel=${v.guessed} onPick=${p => input({ author: p })} />` : null}`;
  // reveal
  return html`${head}${card}${v.author && html`
    <h2>Written by ${nameOf(v.author)}</h2>
    <ul class="rows">${Object.entries(v.guesses).map(([g, t]) => html`<li key=${g}><span class="pname">${nameOf(g)} guessed ${nameOf(t)}</span>
      <span>${t === v.author ? '✅' : '❌'}</span></li>`)}</ul>`}`;
}

// ── Pass the Bomb ──
function Bomb({ v, r }) {
  const mine = v.phase === 'live' && v.holder === r.you;
  useEffect(() => { if (mine) feel('turn', 80); }, [mine, v.count]);
  if (v.phase === 'countdown') return html`<${Head} v=${v}><div class="center"><p class="muted">Category</p><h2 class="prompt">${v.category}</h2>
    <p class="soft">${nameOf(v.holder)} starts with the bomb…</p></div></${Head}>`;
  if (v.phase === 'boom') return html`<${Head} v=${v}><div class="center"><div class="bomb">💥</div>
    <h2>${v.loser === r.you ? 'It blew up on you!' : `BOOM! ${nameOf(v.loser)} was holding it`}</h2>
    <p class="muted">Everyone else +${Math.round(100 / v.rounds)}</p></div></${Head}>`;
  return html`<${Head} v=${v}>
    <p class="muted center-text">Category</p><h2 class="prompt center-text">${v.category}</h2>
    <div class="bomb ${mine ? 'hot' : ''}" aria-hidden="true">💣</div>
    ${mine ? html`<${Ask} key=${v.count} ph=${`Name one: ${v.category}`} max=${30} onSend=${t => input({ word: t })} />`
      : html`<p class="soft"><b>${nameOf(v.holder)}</b> has the bomb!</p>`}
    <div class="chips">${v.said.map(x => html`<span class="chip" key=${x.w}>${x.w}</span>`)}</div>
  </${Head}>`;
}

// ── classics: shared bits ──
const SEAT = ['#3b82f6', '#ef4444', '#22c55e', '#eab308'];
const useTick = ms => { const [, t] = useState(0); useEffect(() => { const i = setInterval(() => t(x => x + 1), ms); return () => clearInterval(i); }, []); };
const turnLine = (v, r, verb = 'move') => (v.turn === r.you ? `Your ${verb}` : `${nameOf(v.turn)}'s ${verb}`);

// ── Tic-Tac-Toe & Four in a Row ──
function Duel({ v, r, id }) {
  const c4 = id === 'four_row', mine = v.phase === 'play' && v.turn === r.you;
  const mark = x => (c4 ? html`<span class="disc" style=${`background:${SEAT[x]}`} />` : html`<span style=${`color:${SEAT[x]}`}>${x ? '◯' : '✕'}</span>`);
  const status = v.phase === 'result' ? (v.line ? `${nameOf(v.players[v.board[v.line[0]]])} wins the round!` : 'Draw!') : turnLine(v, r);
  return html`<h3>${v.rounds > 1 ? `Round ${v.round}/${v.rounds} · ` : ''}${v.players.map((p, i) => html`<span key=${p}>${i ? ' vs ' : ''}${mark(i)} ${nameOf(p)} (${v.score[p]})</span>`)}</h3>
    <p class="soft">${status}</p>
    <div class="board ${c4 ? 'c4' : 'ttt'}">${v.board.map((x, i) => html`<button key=${i} class="cell ${v.line?.includes(i) ? 'win' : ''}"
      disabled=${!mine || (c4 ? v.board[i % 7] !== null : x !== null)} aria-label=${c4 ? `Column ${(i % 7) + 1}` : `Cell ${i + 1}`}
      onClick=${() => input({ at: c4 ? i % 7 : i })}>${x === null ? '' : mark(x)}</button>`)}</div>`;
}

// ── Chess (moves validated on the server; client only shows the legal ones it's sent) ──
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
function ChessBoard({ v, r }) {
  const [sel, setSel] = useState(null);
  useTick(500);
  const flip = v.black === r.you;
  const rows = v.fen.split(' ')[0].split('/').map(row => [...row].flatMap(ch => (/\d/.test(ch) ? Array(+ch).fill(null) : [ch])));
  let squares = rows.flatMap((row, ri) => row.map((p, ci) => ({ sq: 'abcdefgh'[ci] + (8 - ri), p, dark: (ri + ci) % 2 === 1 })));
  if (flip) squares = squares.reverse();
  const targets = (sel && v.moves[sel]) || [];
  const click = sq => {
    if (sel && targets.includes(sq)) { input({ from: sel, to: sq }); setSel(null); }
    else setSel(v.moves[sq] ? sq : null);
  };
  const left = side => Math.max(0, v.clock[side] - (v.phase === 'play' && v.side === side ? now() - v.since : 0));
  const fmt = ms => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
  const bar = side => { const pid = side === 'w' ? v.white : v.black; return html`<div class="clockbar ${v.side === side && v.phase === 'play' ? 'on' : ''}">
    <span>${side === 'w' ? '♔' : '♚'} ${nameOf(pid)}${pid === r.you ? ' (you)' : ''}</span><b>${fmt(left(side))}</b></div>`; };
  const res = v.result;
  return html`${bar(flip ? 'w' : 'b')}
    <div class="chess">${squares.map(({ sq, p, dark }) => html`<button key=${sq} aria-label=${sq + (p ? ` ${p}` : '')} onClick=${() => click(sq)}
      class="sq ${dark ? 'dk' : 'lt'} ${sel === sq ? 'sel' : ''} ${targets.includes(sq) ? 'tgt' : ''} ${v.last && (v.last.from === sq || v.last.to === sq) ? 'last' : ''}">
      ${p && html`<span class="pc ${p === p.toUpperCase() ? 'w' : 'b'}">${GLYPH[p.toLowerCase()]}</span>`}</button>`)}</div>
    ${bar(flip ? 'b' : 'w')}
    <p class="soft">${res ? `${res.winner ? `${nameOf(res.winner)} wins` : 'Draw'} by ${res.why}` : `${turnLine(v, r)}${v.check ? ' — check!' : ''}`}</p>
    ${v.phase === 'play' && v.players.includes(r.you) && html`<button class="link" onClick=${() => confirm('Resign this game?') && input({ resign: true })}>Resign</button>`}`;
}

// ── Emoji Decode ──
function EmojiDecode({ v, r }) {
  const auto = useAuto(), words = v.hint.split(' ');
  const playing = !S.tv && !P(r.you)?.spectator;
  return html`<div class="emoji-game">
    <div class="round-dots" aria-label=${`Puzzle ${v.round} of ${v.rounds}`}>${Array.from({ length: v.rounds }, (_, i) => html`<i key=${i} class=${i < v.round - 1 ? 'done' : i === v.round - 1 ? 'on' : ''} />`)}</div>
    <div class="emoji-card ${v.phase === 'reveal' ? 'revealed' : ''}" key=${v.round}>
      <div class="big-emoji" role="img" aria-label="Emoji puzzle">${v.emoji}</div>
      <div class="hint" aria-label=${v.phase === 'reveal' ? `Answer: ${v.hint}` : 'Answer pattern'}>${words.map((w, k) => html`<span key=${k} class="hword">${[...w].map((ch, i) => html`
        <span key=${i} class="htile ${ch === '_' ? '' : 'shown'}">${ch === '_' ? '' : ch}</span>`)}</span>`)}</div>
      <p class="small muted">${v.phase === 'reveal' ? 'The answer' : v.hint.replace(/[^_]/g, '').length === v.hint.replace(/\s/g, '').length ? 'Hints in a few seconds…' : 'Hint unlocked'}</p>
    </div>
    ${v.phase === 'reveal' ? null : v.solved ? html`<p class="soft">✅ Solved! Waiting for the others…</p>`
      : playing && html`<${Ask} key=${v.round} ph="Type your guess" max=${60} onSend=${(t, clear) => { input({ guess: t }); clear(); }} />`}
    <ol class="solvers" ref=${auto}>${v.solvedBy.map((p, i) => html`<li key=${p}><span>${['🥇', '🥈', '🥉'][i] ?? '✅'}</span><${Av} a=${P(p)?.avatar} />
      <b class="pname">${nameOf(p)}</b><span class="pts">+${[15, 10, 7][i] ?? 5}</span></li>`)}</ol>
  </div>`;
}

// ── Dots & Boxes: an SVG board with fat touch targets and a preview of your line ──
function Dots({ v, r }) {
  const B = v.B, H = (B + 1) * B, U = 100, pad = 24, size = B * U + pad * 2, me = v.players.indexOf(r.you), mine = v.phase === 'play' && v.turn === r.you;
  const [hover, setHover] = useState(null);
  const seg = l => {
    const h = l < H, row = h ? Math.floor(l / B) : Math.floor((l - H) / (B + 1)), col = h ? l % B : (l - H) % (B + 1);
    const x = pad + col * U, y = pad + row * U;
    return h ? [x, y, x + U, y] : [x, y, x, y + U];
  };
  const score = i => v.boxes.filter(b => b === i).length;
  return html`<div class="chips">${v.players.map((p, i) => html`<span key=${p} class="chip ${p === v.turn && v.phase === 'play' ? 'on' : ''}">
      <i class="seat" style=${`background:${SEAT[i]}`} /> ${nameOf(p)} · <b>${score(i)}</b></span>`)}</div>
    <p class="soft">${v.phase === 'result' ? 'All boxes closed!' : mine ? 'Your move: tap a gap between two dots' : `${nameOf(v.turn)} is thinking…`}</p>
    <svg class="dots-board" viewBox=${`0 0 ${size} ${size}`} role="group" aria-label="Dots and boxes board">
      ${v.boxes.map((o, b) => o !== null && html`<g key=${`b${b}`}><rect x=${pad + (b % B) * U + 6} y=${pad + Math.floor(b / B) * U + 6} width=${U - 12} height=${U - 12} rx="10" fill=${SEAT[o]} opacity=".32" />
        <text x=${pad + (b % B) * U + U / 2} y=${pad + Math.floor(b / B) * U + U / 2 + 12} text-anchor="middle" font-size="34" font-weight="800" fill=${SEAT[o]}>${[...nameOf(v.players[o])][0]}</text></g>`)}
      ${v.lines.map((o, l) => { const [x1, y1, x2, y2] = seg(l); return html`<g key=${`l${l}`}>
        ${o === null ? html`<line x1=${x1} y1=${y1} x2=${x2} y2=${y2} class="gap ${hover === l && mine ? 'preview' : ''}" style=${hover === l && mine ? `stroke:${SEAT[me]}` : ''} />`
          : html`<line x1=${x1} y1=${y1} x2=${x2} y2=${y2} class="taken ${v.last === l ? 'last' : ''}" style=${`stroke:${SEAT[o]}`} />`}
        ${o === null && mine && html`<line x1=${x1} y1=${y1} x2=${x2} y2=${y2} class="hit" role="button" aria-label=${`Line ${l + 1}`}
          onPointerEnter=${() => setHover(l)} onPointerLeave=${() => setHover(h => (h === l ? null : h))} onClick=${() => { input({ line: l }); setHover(null); feel('tap', 10); }} />`}</g>`; })}
      ${Array.from({ length: (B + 1) * (B + 1) }, (_, i) => html`<circle key=${`d${i}`} cx=${pad + (i % (B + 1)) * U} cy=${pad + Math.floor(i / (B + 1)) * U} r="9" class="dotpt" />`)}
    </svg>`;
}

// ── playing cards ──
const SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANKN = x => (x === 'T' ? '10' : x);
const PCard = ({ c, sel, ...p }) => html`<button class="pcard ${'HD'.includes(c[1]) ? 'red' : ''} ${sel ? 'sel' : ''}" aria-label=${`${RANKN(c[0])} of ${SUIT[c[1]]}`} aria-pressed=${sel ? 'true' : undefined} ...${p}>
  <span class="corner">${RANKN(c[0])}<i>${SUIT[c[1]]}</i></span><span class="pip">${SUIT[c[1]]}</span></button>`;
const CardBack = ({ n, ...p }) => html`<span class="pcard back" ...${p}>${n != null && html`<b>${n}</b>`}</span>`;
function Seats({ v, r, extra }) {
  const auto = useAuto();
  return html`<div class="seats" ref=${auto}>${v.counts.map(([p, n]) => html`<div key=${p} class="seatbox ${p === v.turn && v.phase !== 'over' ? 'on' : ''}">
    <${Av} a=${P(p)?.avatar} /><b class="pname">${nameOf(p)}${p === r.you ? ' (you)' : ''}</b><span class="small">🂠 ${n}${extra?.(p, n) ?? ''}</span></div>`)}</div>`;
}

// ── Bluff ──
const PLURAL = { A: 'Aces', T: '10s', J: 'Jacks', Q: 'Queens', K: 'Kings' }, plural = x => PLURAL[x] ?? `${x}s`;
function Bluff({ v, r }) {
  const [sel, setSel] = useState([]);
  useEffect(() => setSel([]), [v.turn, v.phase]);
  const mine = v.phase === 'play' && v.turn === r.you, last = v.last, rv = v.reveal, inGame = !!v.hand;
  const toggle = c => setSel(s => (s.includes(c) ? s.filter(x => x !== c) : s.length < 4 ? [...s, c] : s));
  useEffect(() => { if (rv) feel(rv.lie ? 'goal' : 'drop', 40); }, [!!rv]);
  if (v.phase === 'over') return html`<div class="center"><h2>${v.winner === r.you ? 'You win! 🎉' : `${nameOf(v.winner)} emptied their hand!`}</h2></div>`;
  return html`<${Seats} v=${v} r=${r} />
    <div class="felt bluff-felt">
      <div class="pile">${v.pile ? html`${Array.from({ length: Math.min(5, v.pile) }, (_, i) => html`<${CardBack} key=${i} style=${`transform:rotate(${(i - 2) * 6}deg) translate(${i * 2}px, ${-i}px)`} />`)}
        <b class="pile-n">${v.pile}</b>` : html`<span class="muted small">Pile is empty</span>`}</div>
      <div class="claim">
        ${v.phase === 'reveal' ? html`<div class="reveal-cards">${rv.cards.map(c => html`<${PCard} key=${c} c=${c} disabled class=${`pcard ${'HD'.includes(c[1]) ? 'red' : ''} ${c[0] === last.rank ? '' : 'liar'}`} />`)}</div>
            <b class=${rv.lie ? 'lie' : 'truth'}>${rv.lie ? 'LIE! 🤥' : 'TRUTH! 😇'}</b>
            <span>${nameOf(rv.taker)} picks up ${rv.n} card${rv.n === 1 ? '' : 's'}</span>`
          : v.phase === 'call' ? html`<span class="small muted">${nameOf(last.pid)} says</span><b class="claim-big">${last.n} × ${plural(last.rank)}</b>`
          : html`<span class="small muted">Now playing</span><b class="claim-big">${plural(v.rank)}</b>`}
      </div>
    </div>
    ${v.phase === 'call' && inGame && last.pid !== r.you ? html`<button class="btn danger big" onClick=${() => input({ call: true })}>🚨 Bluff! <${Timer} at=${v.deadline} /></button>`
      : v.phase === 'call' ? html`<p class="soft">Anyone calling bluff? <${Timer} at=${v.deadline} /></p>` : null}
    ${v.phase === 'play' && html`<p class="soft">${mine ? `Your turn: play 1–4 cards as ${plural(v.rank)}. Truth optional.` : `${nameOf(v.turn)} is choosing cards…`}</p>`}
    ${mine && html`<button class="btn primary big" disabled=${!sel.length} onClick=${() => input({ play: sel })}>Play ${sel.length || ''} as ${plural(v.rank)}${sel.length && sel.some(c => c[0] !== v.rank) ? ' 🤫' : ''}</button>`}
    ${v.hand && html`<div class="hand">${v.hand.map(c => html`<${PCard} key=${c} c=${c} sel=${sel.includes(c)} disabled=${!mine} onClick=${() => toggle(c)} />`)}</div>`}
    <p class="small muted center-text">Ranks go A, 2, 3 … K, then round again. Call “Bluff!” on a lie and the liar takes the pile; call wrong and it's yours.</p>`;
}

// ── Color Clash ──
const CC = { R: '#ef4444', Y: '#f5b800', G: '#16a34a', B: '#2563eb' }, CCN = { R: 'Red', Y: 'Yellow', G: 'Green', B: 'Blue' };
const ccSym = c => (c[0] === 'W' ? (c[1] === '4' ? '+4' : '✦') : { S: '⊘', R: '⇄', D: '+2' }[c[1]] ?? c[1]);
const ccName = c => (c[0] === 'W' ? (c[1] === '4' ? 'Wild draw four' : 'Wild') : `${CCN[c[0]]} ${{ S: 'skip', R: 'reverse', D: 'draw two' }[c[1]] ?? c[1]}`);
const ClashCard = ({ c, tint, sel, ...p }) => html`<button class="ccard ${c[0] === 'W' ? 'wild' : ''} ${sel ? 'sel' : ''}" style=${`--cc:${CC[tint ?? c[0]] ?? '#111827'}`} aria-label=${ccName(c)} ...${p}>
  <span class="cc-corner">${ccSym(c)}</span><span class="cc-oval"><b>${ccSym(c)}</b></span><span class="cc-corner br">${ccSym(c)}</span></button>`;
function Clash({ v, r }) {
  const [wild, setWild] = useState(null), [shout, setShout] = useState(false);
  const mine = v.phase === 'play' && v.turn === r.you, hand = v.hand ?? [];
  const can = c => c[0] === 'W' || c[0] === v.color || c[1] === v.top[1];
  const play = (c, color) => { input({ play: c, color, last: shout || undefined }); setShout(false); setWild(null); feel('tap', 15); };
  useEffect(() => setShout(false), [v.turn]);
  if (v.phase === 'over') return html`<div class="center"><h2>${v.winner === r.you ? 'You win! 🎉' : `${nameOf(v.winner)} wins!`}</h2></div>`;
  return html`<div class="opps">${v.counts.filter(([p]) => p !== r.you).map(([p, n]) => html`<div key=${p} class="opp ${p === v.turn ? 'on' : ''}">
      <span class="opp-name"><${Av} a=${P(p)?.avatar} /> <b>${nameOf(p)}</b> <span class="small">${n === 1 ? '⚠️ LAST CARD' : `${n} cards`}</span></span>
      <span class="fan">${Array.from({ length: Math.min(n, 14) }, (_, i) => html`<i key=${i} class="mini-back" />`)}${n > 14 ? html`<b class="small"> +${n - 14}</b>` : null}</span></div>`)}</div>
    <div class="felt clash-felt">
      <button class="pcard back deck" disabled=${!mine || v.drew} onClick=${() => input({ draw: true })} aria-label="Draw a card"><b>${v.deck}</b></button>
      <div class="clash-top" style=${`--glow:${CC[v.color]}`}><${ClashCard} c=${v.top} tint=${v.top[0] === 'W' ? v.color : undefined} disabled /></div>
      <div class="felt-info"><div class="dir ${v.dir < 0 ? 'rev' : ''}">↻</div><div class="small">Colour</div><b style=${`color:${CC[v.color]}`}>${CCN[v.color]}</b></div>
    </div>
    ${v.unsaid && v.unsaid !== r.you && v.hand && html`<button class="btn danger big" onClick=${() => input({ catch: v.unsaid })}>🙊 ${nameOf(v.unsaid)} forgot “last card”! Catch (+2)</button>`}
    <p class="soft">${mine ? (v.drew ? 'Play the card you drew, or pass' : 'Your turn: match the colour or symbol, or draw') : `${nameOf(v.turn)} is playing…`}</p>
    ${wild ? html`<div class="row center-row">${Object.keys(CC).map(k => html`<button key=${k} class="btn colorbtn" style=${`background:${CC[k]}`} aria-label=${`Choose ${CCN[k]}`} onClick=${() => play(wild, k)}>${CCN[k]}</button>`)}
        <button class="link" onClick=${() => setWild(null)}>Cancel</button></div>`
      : mine && html`<div class="row center-row">
        ${!v.drew && html`<button class="btn" onClick=${() => input({ draw: true })}>Draw</button>`}
        ${v.drew && html`<button class="btn" onClick=${() => input({ pass: true })}>Pass</button>`}
        ${hand.length === 2 && html`<button class="btn ${shout ? 'primary' : ''}" aria-pressed=${shout} onClick=${() => { setShout(!shout); feel('turn', 20); }}>📣 Last card!</button>`}</div>`}
    ${v.hand && html`<div class="hand clash-hand">${hand.map((c, i) => html`<${ClashCard} key=${c + i} c=${c} disabled=${!mine || !can(c)}
      onClick=${() => (c[0] === 'W' ? setWild(c) : play(c))} />`)}</div>`}
    <p class="small muted center-text">⊘ skip · ⇄ reverse · +2 next draws two · ✦ wild · +4 wild and next draws four. Down to 2 cards? Tap “Last card!” before you play, or get caught.</p>`;
}

// ── Minesweeper: left-click dig, right-click flag, click a number to clear around it; long-press flags on touch ──
function Mines({ v, r }) {
  const [flagMode, setFlagMode] = useState(false), press = useRef(null);
  const live = v.cells && !v.done && v.phase === 'play';
  const act = (i, flag) => {
    if (!live) return;
    const c = v.cells[i];
    if (c !== null) return c > 0 && input({ chord: i }); // numbers: chord
    if (flag) { input({ flag: i }); feel('tap', 12); return; }
    if (!v.flags.includes(i)) input({ open: i });
  };
  const down = (e, i) => {
    if (e.button !== 0) return;
    press.current = { i, t: setTimeout(() => { press.current && (press.current.long = true); act(i, true); buzz(35); }, 420) };
  };
  const lift = (e, i) => {
    const p = press.current;
    press.current = null;
    if (!p || p.i !== i) return;
    clearTimeout(p.t);
    if (!p.long) act(i, flagMode);
  };
  const cancel = () => { if (press.current) { clearTimeout(press.current.t); press.current = null; } };
  const face = v.done === 'boom' ? '😵' : v.done === 'clear' ? '😎' : v.phase === 'result' ? '🏁' : '🙂';
  const others = v.others.length > 0 && html`<div class="mine-race">${v.others.map(o => html`<div key=${o.pid} class="mine-row"><span class="pname">${nameOf(o.pid)}</span>
      <span class="bar"><i style=${`width:${o.pct}%`} /></span><span>${o.done === 'boom' ? '💥' : o.done === 'clear' ? '✅' : `${o.pct}%`}</span></div>`)}</div>`;
  if (!v.cells) return html`<p class="soft">Watching the race…</p>${others}`;
  return html`<div class="ms">
    <div class="ms-bar"><span class="lcd" title="Mines left">💣 ${String(Math.max(0, v.mines - v.flags.length)).padStart(3, '0')}</span>
      <span class="ms-face" aria-label="Status">${face}</span>
      <button class="btn ms-mode ${flagMode ? 'primary' : ''}" aria-pressed=${flagMode} onClick=${() => setFlagMode(!flagMode)}>${flagMode ? '🚩 Flag' : '⛏️ Dig'}</button></div>
    <div class="ms-grid" style=${`grid-template-columns:repeat(${v.W}, 1fr)`} onContextMenu=${e => e.preventDefault()} onPointerLeave=${cancel}>${v.cells.map((c, i) => html`<button key=${i}
      class="mc ${c === null ? '' : 'open'} ${c > 0 ? `n${c}` : ''} ${v.hit === i ? 'hit' : ''} ${c === 'm' ? 'mine' : ''}"
      aria-label=${c === null ? (v.flags.includes(i) ? 'Flagged square' : 'Hidden square') : c === 'm' ? 'Mine' : `${c || 'Empty'}`}
      onPointerDown=${e => down(e, i)} onPointerUp=${e => lift(e, i)} onPointerCancel=${cancel}
      onContextMenu=${e => { e.preventDefault(); cancel(); act(i, true); }} onAuxClick=${e => e.button === 1 && act(i, false)}>
      ${c === 'm' || v.hit === i ? '💣' : c > 0 ? c : c === null && v.flags.includes(i) ? '🚩' : ''}</button>`)}</div>
    <p class="soft">${v.done === 'boom' ? 'Boom! 💥 Watch the others finish…' : v.done === 'clear' ? 'Cleared! 🎉' : v.phase === 'result' ? 'Round over' : 'First to clear every safe square wins'}</p>
    ${others}
    <p class="small muted center-text">Click to dig · right-click or long-press to flag · click a number whose flags are all placed to open around it.</p>
  </div>`;
}

// ── arcade: physics runs here, the server only takes the best score (and caps how fast it can grow) ──
const seeded = seed => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const useBest = () => { const b = useRef(0); return n => { if (n > b.current) { b.current = n; input({ score: n }); } }; };
// canvas sized for the device pixel ratio, drawing in a fixed W×H space
function useCanvas(W, H, setup) {
  const ref = useRef();
  useEffect(() => {
    // the bitmap matches the size on screen (not the W×H drawing space), so big boards stay cheap to redraw
    const cv = ref.current, x = cv.getContext('2d');
    const fit = () => {
      const px = Math.min(2, devicePixelRatio || 1), w = Math.max(1, Math.round((cv.getBoundingClientRect().width || W) * px)), h = Math.round((w * H) / W);
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      x.setTransform(w / W, 0, 0, h / H, 0, 0);
    };
    fit();
    addEventListener('resize', fit);
    const at = e => { const b = cv.getBoundingClientRect(); return [((e.clientX - b.left) * W) / b.width, ((e.clientY - b.top) * H) / b.height]; };
    const off = setup(cv, x, at);
    return () => { removeEventListener('resize', fit); off?.(); };
  }, []);
  return ref;
}
const HOWTO = {
  keepy: 'Tap anywhere (or press Space) while the ball is in the kick zone. Tap left of the ball to send it right. Longest streak wins.',
  bin_toss: 'Tap once to lock your aim, tap again to set the power. On a phone you can also flick. Mind the wind.',
  sweet_spot: 'Tap when the needle is in the green zone. Each hit makes it smaller and faster.',
};
function Arcade({ v, r, id }) {
  const order = [...v.players].sort((a, b) => v.best[b] - v.best[a]);
  const board = html`<div class="chips">${order.map((p, i) => html`<span key=${p} class="chip ${p === r.you ? 'on' : ''}">${i === 0 && v.best[p] ? '👑 ' : ''}${nameOf(p)} · <b>${v.best[p]}</b></span>`)}</div>`;
  if (v.phase === 'ready') return html`<div class="center"><div class="big-count"><${Timer} at=${v.deadline} /></div><p class="soft">${HOWTO[id]}</p></div>`;
  if (v.phase === 'result') return html`<h2 class="center-text">Time's up!</h2>${board}`;
  const Game = { keepy: Keepy, bin_toss: BinToss, sweet_spot: SweetSpot }[id];
  return html`${v.players.includes(r.you) ? html`<${Game} key=${v.start} v=${v} />` : html`<p class="soft">Watching…</p>`}${board}`;
}
function ballArt(x, R, rot) {
  x.save(); x.rotate(rot);
  x.fillStyle = '#fff'; x.beginPath(); x.arc(0, 0, R, 0, 7); x.fill();
  x.fillStyle = '#1f2937';
  const pent = (cx, cy, s) => { x.beginPath(); for (let k = 0; k < 5; k++) { const a = (k * 2 * Math.PI) / 5 - Math.PI / 2; x.lineTo(cx + s * Math.cos(a), cy + s * Math.sin(a)); } x.fill(); };
  pent(0, 0, R * 0.36);
  for (let k = 0; k < 5; k++) { const a = (k * 2 * Math.PI) / 5 - Math.PI / 2; pent(Math.cos(a) * R * 0.86, Math.sin(a) * R * 0.86, R * 0.24); }
  x.restore();
  x.strokeStyle = '#0003'; x.lineWidth = 2; x.beginPath(); x.arc(0, 0, R, 0, 7); x.stroke();
}
function SweetSpot({ v }) {
  const report = useBest(), needle = useRef(), zoneEl = useRef();
  const [lvl, setLvl] = useState(0), [best, setBest] = useState(0), [msg, setMsg] = useState('');
  const s = useRef(null);
  if (!s.current) { const rnd = seeded(v.seed); s.current = { rnd, pos: 0, dir: 1, speed: 0.55, w: 0.26, z: 0.37, dead: 0, lvl: 0, best: 0 }; }
  useEffect(() => {
    let raf, last = performance.now();
    const loop = t => {
      const st = s.current, dt = Math.min(0.033, (t - last) / 1000);
      last = t;
      if (!st.dead) { st.pos += st.dir * st.speed * dt; if (st.pos > 1 || st.pos < 0) { st.dir *= -1; st.pos = Math.max(0, Math.min(1, st.pos)); } }
      if (needle.current) needle.current.style.left = `${st.pos * 100}%`;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const tap = () => {
    const st = s.current;
    if (st.dead) return;
    if (st.pos >= st.z && st.pos <= st.z + st.w) {
      st.lvl++; st.w = Math.max(0.035, st.w * 0.86); st.speed *= 1.07; st.z = st.rnd() * (1 - st.w);
      if (st.lvl > st.best) { st.best = st.lvl; report(st.best); setBest(st.best); }
      setLvl(st.lvl); setMsg(''); feel('tap', 15);
    } else {
      st.dead = 1; setMsg('Missed! Starting over…'); feel('drop', 120);
      setTimeout(() => { Object.assign(st, { dead: 0, lvl: 0, w: 0.26, speed: 0.55, z: 0.37 }); setLvl(0); setMsg(''); }, 900);
    }
  };
  useEffect(() => {
    const k = e => { if (e.code === 'Space' && !e.repeat) { e.preventDefault(); tap(); } };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);
  const st = s.current;
  return html`<div class="sweet" onPointerDown=${tap} role="button" aria-label="Tap to stop the needle">
    <div class="big-count">${lvl}</div><p class="muted">Best ${best}</p>
    <div class="track"><div class="zone" ref=${zoneEl} style=${`left:${st.z * 100}%;width:${st.w * 100}%`} /><div class="needle" ref=${needle} /></div>
    <p class="soft">${msg || 'Tap anywhere (or Space) when the needle is in the green'}</p>
  </div>`;
}

// Keepy Uppy: no aiming at a moving ball. Click/tap ANYWHERE while the ball is in the kick zone; where you tap
// (left or right of the ball) sets the direction. Keyboard: Space / ↑ straight, ← → angled.
function Keepy() {
  const report = useBest(), W = 360, H = 560, R = 36, ZONE = 300, FLOOR = H - 26;
  const ref = useCanvas(W, H, (cv, x, at) => {
    const s = { bx: W / 2, by: FLOOR - R, vx: 0, vy: 0, rot: 0, spin: 0, n: 0, best: 0, dead: 0, live: false, msg: '', msgAt: 0, flash: 0 };
    const kick = side => { // side: -1 … 1, where the ball should go
      if (s.dead) return;
      if (s.live && s.by < ZONE) { s.msg = 'Wait for it…'; s.msgAt = performance.now(); return; }
      Object.assign(s, { vy: -830 - Math.random() * 60, vx: side * 230 + (Math.random() - 0.5) * 40, spin: side * 8, live: true, flash: performance.now() });
      s.n++;
      if (s.n > s.best) { s.best = s.n; report(s.best); }
      feel('tap', 15);
    };
    const tap = e => { const [px] = at(e); kick(Math.max(-1, Math.min(1, (s.bx - px) / 90))); };
    const keys = e => {
      const side = { Space: 0, ArrowUp: 0, KeyW: 0, ArrowLeft: -0.8, KeyA: -0.8, ArrowRight: 0.8, KeyD: 0.8 }[e.code];
      if (side === undefined || e.repeat) return;
      e.preventDefault();
      kick(side);
    };
    cv.addEventListener('pointerdown', tap);
    addEventListener('keydown', keys);
    let raf, last = performance.now();
    const loop = t => {
      const dt = Math.min(0.033, (t - last) / 1000), g = 1350 * (1 + Math.min(0.5, s.n * 0.012));
      last = t;
      if (s.live && !s.dead) {
        s.vy += g * dt; s.bx += s.vx * dt; s.by += s.vy * dt; s.rot += s.spin * dt;
        if (s.bx < R || s.bx > W - R) { s.bx = Math.max(R, Math.min(W - R, s.bx)); s.vx *= -0.8; s.spin *= -1; }
        if (s.by < R) { s.by = R; s.vy = Math.abs(s.vy) * 0.4; }
        if (s.by > FLOOR - R) { s.by = FLOOR - R; s.dead = t; s.msg = s.n ? `Dropped at ${s.n}` : ''; s.msgAt = t; feel('drop', 120); }
      }
      if (s.dead && t - s.dead > 1000) Object.assign(s, { bx: W / 2, by: FLOOR - R, vx: 0, vy: 0, rot: 0, n: 0, dead: 0, live: false });
      // stadium night sky, floodlight glow, striped pitch
      const sky = x.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, '#0b1a33'); sky.addColorStop(0.55, '#123b2a'); sky.addColorStop(1, '#0d2e1f');
      x.fillStyle = sky; x.fillRect(0, 0, W, H);
      const lamp = x.createRadialGradient(W / 2, -40, 10, W / 2, -40, 340);
      lamp.addColorStop(0, '#ffffff30'); lamp.addColorStop(1, '#ffffff00');
      x.fillStyle = lamp; x.fillRect(0, 0, W, H);
      for (let i = 0; i < 6; i++) { x.fillStyle = i % 2 ? '#1d7a45' : '#1a6e3e'; x.fillRect(0, ZONE + i * ((FLOOR - ZONE) / 6), W, (FLOOR - ZONE) / 6); }
      x.fillStyle = '#0f4d2b'; x.fillRect(0, FLOOR, W, H - FLOOR);
      const ready = !s.dead && (!s.live || s.by >= ZONE);
      x.fillStyle = ready ? '#ffd23f22' : '#ffffff08'; x.fillRect(0, ZONE, W, FLOOR - ZONE);
      x.setLineDash([10, 8]); x.strokeStyle = ready ? '#ffd23fcc' : '#ffffff40'; x.lineWidth = 3;
      x.beginPath(); x.moveTo(0, ZONE); x.lineTo(W, ZONE); x.stroke(); x.setLineDash([]);
      x.fillStyle = ready ? '#ffd23f' : '#ffffff70'; x.font = '700 13px system-ui'; x.textAlign = 'center';
      x.fillText(ready ? 'KICK ZONE · TAP ANYWHERE' : 'KICK ZONE', W / 2, ZONE + 20);
      x.fillStyle = '#fff'; x.font = '800 84px "Bricolage Grotesque", system-ui'; x.globalAlpha = 0.92; x.fillText(String(s.n), W / 2, 112); x.globalAlpha = 1;
      x.font = '600 15px system-ui'; x.fillStyle = '#ffffffaa';
      x.fillText(s.msg && t - s.msgAt < 900 ? s.msg : s.live ? `Best ${s.best}` : `Tap to kick off · best ${s.best}`, W / 2, 142);
      x.fillStyle = '#0007'; x.beginPath(); x.ellipse(s.bx, FLOOR + 4, R * (0.45 + (s.by / H) * 0.55), 7, 0, 0, 7); x.fill();
      if (t - s.flash < 160) { x.fillStyle = '#ffd23f55'; x.beginPath(); x.arc(s.bx, s.by, R + 16, 0, 7); x.fill(); }
      x.save(); x.translate(s.bx, s.by); ballArt(x, R, s.rot); x.restore();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); cv.removeEventListener('pointerdown', tap); removeEventListener('keydown', keys); };
  });
  return html`<canvas ref=${ref} class="arena" aria-label="Keepy Uppy: tap anywhere when the ball is in the kick zone" />`;
}

// Bin Toss: two taps (aim, then power) so it works on trackpads and keyboards; a flick still throws on touch.
function BinToss({ v }) {
  const report = useBest(), W = 360, H = 560, HOR = 150, NEAR = H - 40;
  const ref = useCanvas(W, H, (cv, x, at) => {
    const rnd = seeded(v.seed);
    const next = made => ({ wind: Math.round((rnd() * 2 - 1) * 30) / 10, bin: { x: (rnd() * 2 - 1) * 0.55, z: Math.min(0.88, 0.45 + made * 0.04 + rnd() * 0.12) } });
    const s = { ...next(0), made: 0, streak: 0, stage: 'aim', t0: performance.now(), aim: 0, power: 0, fly: null, msg: '', msgAt: 0, start: null };
    // floor perspective: depth z 0 (your feet) → 1 (back wall)
    const P3 = (wx, z, h = 0) => { const k = 1 - z * 0.62, y = NEAR - z * (NEAR - HOR); return [W / 2 + wx * W * 0.46 * k, y - h * k, k]; };
    const throwIt = (aim, power) => {
      const z = 0.12 + power * 0.95, xLand = Math.tan(aim) * z * 0.9 + s.wind * 0.06 * z;
      s.fly = { t0: performance.now(), aim, z, xLand };
      s.stage = 'fly';
      feel('tap', 15);
    };
    const press = () => {
      const t = performance.now();
      if (s.stage === 'aim') { s.aim = Math.sin((t - s.t0) / 520) * 0.62; s.stage = 'power'; s.t0 = t; }
      else if (s.stage === 'power') { s.power = (1 - Math.cos((t - s.t0) / 430)) / 2; throwIt(s.aim, s.power); }
    };
    const down = e => { s.start = [...at(e), e.pointerType]; };
    const upE = e => {
      const st = s.start;
      s.start = null;
      if (!st) return;
      const [px, py] = at(e), dx = px - st[0], dy = py - st[1];
      if (st[2] !== 'mouse' && dy < -40 && s.stage !== 'fly') return throwIt(Math.atan2(dx, -dy) * 0.9, Math.min(1, -dy / 330)); // flick
      if (Math.hypot(dx, dy) < 20) press();
    };
    const keys = e => { if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat) { e.preventDefault(); press(); } };
    cv.addEventListener('pointerdown', down); cv.addEventListener('pointerup', upE); addEventListener('keydown', keys);
    let raf;
    const loop = t => {
      // back wall with a window, floor in perspective
      x.fillStyle = '#e9e3d7'; x.fillRect(0, 0, W, HOR);
      x.fillStyle = '#9cc7e8'; x.fillRect(W / 2 - 70, 26, 140, 82); x.strokeStyle = '#f8f5ee'; x.lineWidth = 6; x.strokeRect(W / 2 - 70, 26, 140, 82);
      x.beginPath(); x.moveTo(W / 2, 26); x.lineTo(W / 2, 108); x.stroke();
      x.fillStyle = '#d7cdb8'; x.fillRect(0, HOR - 8, W, 8);
      const floor = x.createLinearGradient(0, HOR, 0, H);
      floor.addColorStop(0, '#b98a5a'); floor.addColorStop(1, '#d9a873');
      x.fillStyle = floor; x.fillRect(0, HOR, W, H - HOR);
      x.strokeStyle = '#00000018'; x.lineWidth = 1.5;
      for (let i = -6; i <= 6; i++) { const [ax, ay] = P3(i * 0.22, 0), [bx, by] = P3(i * 0.22, 1); x.beginPath(); x.moveTo(ax, ay); x.lineTo(bx, by); x.stroke(); }
      // wind: a little flag that leans and flutters
      const wl = s.wind;
      x.strokeStyle = '#475569'; x.lineWidth = 3; x.beginPath(); x.moveTo(30, 40); x.lineTo(30, 100); x.stroke();
      x.fillStyle = wl === 0 ? '#94a3b8' : '#ef4444'; x.beginPath(); x.moveTo(30, 42);
      const fl = Math.abs(wl) * 10 + 8, flap = Math.sin(t / 120) * 4 * Math.min(1, Math.abs(wl));
      x.lineTo(30 + Math.sign(wl || 1) * fl, 50 + flap); x.lineTo(30, 58); x.fill();
      x.fillStyle = '#334155'; x.font = '700 13px system-ui'; x.textAlign = 'left';
      x.fillText(`Wind ${wl === 0 ? 'calm' : `${wl < 0 ? '←' : '→'} ${Math.abs(wl).toFixed(1)}`}`, 44, 104);
      // bin: a perspective cylinder
      const [bx, by, bk] = P3(s.bin.x, s.bin.z), rw = 44 * bk, bh = 64 * bk;
      x.fillStyle = '#0003'; x.beginPath(); x.ellipse(bx + 6 * bk, by + 2, rw * 1.1, rw * 0.35, 0, 0, 7); x.fill();
      x.fillStyle = '#334155'; x.beginPath(); x.moveTo(bx - rw, by - bh); x.lineTo(bx + rw, by - bh); x.lineTo(bx + rw * 0.82, by); x.lineTo(bx - rw * 0.82, by); x.fill();
      x.fillStyle = '#475569'; for (let i = -2; i <= 2; i++) x.fillRect(bx + i * rw * 0.33 - 1, by - bh + 6, 2, bh - 8);
      x.fillStyle = '#0f172a'; x.beginPath(); x.ellipse(bx, by - bh, rw, rw * 0.32, 0, 0, 7); x.fill();
      x.strokeStyle = '#94a3b8'; x.lineWidth = 3 * bk; x.stroke();
      // the ball: on the floor at your feet, or flying
      let [px, py, pk] = P3(0, 0.02, 40), hShadow = null;
      if (s.fly) {
        const f = s.fly, k = Math.min(1, (t - f.t0) / 900), z = 0.02 + (f.z - 0.02) * k, wx = f.xLand * k + s.wind * 0.02 * k * k, hgt = 40 + Math.sin(k * Math.PI) * 230 * (0.4 + f.z * 0.6);
        [px, py, pk] = P3(wx, z, hgt); hShadow = P3(wx, z);
        if (k >= 1) {
          const dx = Math.abs(wx - s.bin.x), dz = Math.abs(f.z - s.bin.z), inBin = dx < 0.1 && dz < 0.07, rim = !inBin && dx < 0.15 && dz < 0.1;
          if (inBin) { s.made++; s.streak++; report(s.made); feel('goal', 40); } else s.streak = 0;
          Object.assign(s, { msg: inBin ? (s.streak > 2 ? `Swish ×${s.streak}!` : 'Swish!') : rim ? 'Off the rim!' : f.z < s.bin.z ? 'Too short' : f.z > s.bin.z + 0.07 ? 'Too long' : 'Wide!', msgAt: t, fly: null, stage: 'aim', t0: t }, next(s.made));
        }
      }
      if (hShadow) { x.fillStyle = '#0003'; x.beginPath(); x.ellipse(hShadow[0], hShadow[1], 16 * hShadow[2], 5 * hShadow[2], 0, 0, 7); x.fill(); }
      const pr = 17 * pk, paper = x.createRadialGradient(px - pr / 3, py - pr / 3, 2, px, py, pr);
      paper.addColorStop(0, '#ffffff'); paper.addColorStop(1, '#cbd5e1');
      x.fillStyle = paper; x.beginPath(); x.arc(px, py, pr, 0, 7); x.fill();
      x.strokeStyle = '#94a3b8'; x.lineWidth = 1.2; x.beginPath();
      x.moveTo(px - pr * 0.5, py - pr * 0.2); x.lineTo(px + pr * 0.3, py + pr * 0.1); x.moveTo(px - pr * 0.1, py + pr * 0.5); x.lineTo(px + pr * 0.2, py - pr * 0.5); x.stroke();
      // aim arrow and power bar
      if (s.stage === 'aim' || s.stage === 'power') {
        const a = s.stage === 'aim' ? Math.sin((t - s.t0) / 520) * 0.62 : s.aim, len = 120;
        x.save(); x.translate(px, py); x.rotate(a);
        x.strokeStyle = s.stage === 'aim' ? '#ffd23f' : '#ffffffaa'; x.lineWidth = 6; x.lineCap = 'round';
        x.beginPath(); x.moveTo(0, -pr - 6); x.lineTo(0, -pr - len); x.stroke();
        x.fillStyle = x.strokeStyle; x.beginPath(); x.moveTo(-12, -pr - len + 6); x.lineTo(12, -pr - len + 6); x.lineTo(0, -pr - len - 14); x.fill();
        x.restore();
      }
      if (s.stage === 'power') {
        const p = (1 - Math.cos((t - s.t0) / 430)) / 2;
        x.fillStyle = '#0f172acc'; x.fillRect(W - 34, HOR + 20, 18, 300);
        const g = x.createLinearGradient(0, HOR + 320, 0, HOR + 20); g.addColorStop(0, '#22c55e'); g.addColorStop(0.6, '#eab308'); g.addColorStop(1, '#ef4444');
        x.fillStyle = g; x.fillRect(W - 31, HOR + 317 - p * 294, 12, p * 294);
      }
      x.textAlign = 'center';
      x.fillStyle = '#1f2937'; x.font = '800 44px "Bricolage Grotesque", system-ui'; x.fillText(String(s.made), W - 50, 60);
      x.font = '600 12px system-ui'; x.fillText('in the bin', W - 50, 78);
      if (s.msg && t - s.msgAt < 1100) { x.fillStyle = s.msg.startsWith('Swish') ? '#15803d' : '#b91c1c'; x.font = '800 32px "Bricolage Grotesque", system-ui'; x.fillText(s.msg, W / 2, HOR + 60); }
      x.fillStyle = '#3f2a14'; x.font = '600 14px system-ui';
      x.fillText(s.stage === 'aim' ? 'Tap (or Space) to lock your aim' : s.stage === 'power' ? 'Tap again to set the power' : '', W / 2, H - 12);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); cv.removeEventListener('pointerdown', down); cv.removeEventListener('pointerup', upE); removeEventListener('keydown', keys); };
  });
  return html`<canvas ref=${ref} class="arena" aria-label="Bin Toss: tap to aim, tap again for power" />`;
}

// ── Penalty Shootout: six zones, a keeper who dives, a ball that flies ──
const ZONE_POS = [[17, 24], [50, 24], [83, 24], [17, 70], [50, 70], [83, 70]];
const PEN_MSG = { goal: 'GOAL! ⚽', saved: 'SAVED! 🧤', over: 'OVER THE BAR! 😬' };
function Penalty({ v, r }) {
  const role = v.shooter === r.you ? 'shoot' : v.keeper === r.you ? 'keep' : null, last = v.log.at(-1);
  const [picked, setPicked] = useState(null);
  useEffect(() => setPicked(null), [v.kick]);
  useEffect(() => { if (v.phase === 'kick' && last) feel(last.result === 'goal' ? 'goal' : 'drop', last.result === 'goal' ? 60 : 30); }, [v.kick]);
  const kicking = v.phase === 'kick' && last;
  const dots = p => html`<span class="kicks">${v.log.filter(k => k.shooter === p).map((k, i) => html`<i key=${i} class=${k.result === 'goal' ? 'g' : 'x'} />`)}</span>`;
  const [a, b] = v.players, canPick = v.phase === 'aim' && role && !v.chosen;
  const [kx, ky] = kicking ? ZONE_POS[last.dive] : [50, 70], [bx, by] = kicking ? ZONE_POS[last.zone] : [50, 70];
  return html`<div class="pen-score">
      <span>${nameOf(a)} ${dots(a)}</span><b>${v.goals[a]} – ${v.goals[b]}</b><span>${dots(b)} ${nameOf(b)}</span></div>
    <p class="soft">${v.phase === 'over' ? (v.goals[a] === v.goals[b] ? 'A draw!' : `${nameOf(v.goals[a] > v.goals[b] ? a : b)} wins the shootout!`)
      : kicking ? `${nameOf(last.shooter)} ${last.result === 'goal' ? 'scores!' : last.result === 'saved' ? 'is denied!' : 'blazes it over!'}`
      : v.chosen ? 'Locked in. Waiting…' : role === 'shoot' ? '⚽ You shoot! Pick a spot' : role === 'keep' ? '🧤 You keep! Pick where to dive' : `${nameOf(v.shooter)} vs ${nameOf(v.keeper)}`}</p>
    <div class="pen-stage">
      <div class="crowd" aria-hidden="true" />
      <div class="goal2">
        ${ZONE_POS.map(([x, y], z) => html`<button key=${z} class="zone2 ${picked === z ? 'picked' : ''} ${role === 'keep' ? 'keep' : ''}" style=${`left:${x}%;top:${y}%`}
          aria-label=${`${role === 'keep' ? 'Dive to' : 'Shoot at'} zone ${z + 1}`} disabled=${!canPick} onClick=${() => { setPicked(z); input({ zone: z }); feel('tap', 15); }}>
          ${picked === z ? (role === 'keep' ? '🧤' : '🎯') : ''}</button>`)}
        <div key=${`k${v.kick}`} class="keeper ${kicking ? 'dive' : ''}" style=${`--kx:${kx}%;--ky:${ky}%;--kr:${kicking ? (kx - 50) * 1.2 : 0}deg`}><i /></div>
        <div key=${`b${v.kick}`} class="ball2 ${kicking ? 'fly' : ''}" style=${`--bx:${bx}%;--by:${kicking && last.result === 'over' ? -18 : by}%`}>⚽</div>
        ${kicking && html`<div key=${`m${v.kick}`} class="pen-msg ${last.result}">${PEN_MSG[last.result]}</div>`}
      </div>
      <div class="spot" aria-hidden="true" />
    </div>
    <p class="small muted center-text">Top corners are harder to save, but you might put it over the bar.</p>`;
}

// ── live games: frames carry the server's clock; we play them back a beat behind, so motion stays smooth
// even when the network delivers frames in clumps ──
const FB = [], LAT = [];
let playLag = 0, playAt = 0;
const onFrame = m => {
  LAT.push(Date.now() - m.s); // network delay + clock offset; only the spread matters
  if (LAT.length > 50) LAT.shift();
  FB.push({ t: m.s, f: m.f });
  if (FB.length > 80) FB.shift();
};
const resetFrames = () => { FB.length = LAT.length = 0; playAt = 0; };
const GAP = { hockey: 34, sumo: 50, snake: 125, paint: 67, kickabout: 50, volley: 50, land: 125, hill: 50, tag: 50, coins: 50, trails: 100, redlight: 100, tug: 100, type_race: 200 }; // ms between server frames
// Play frames back far enough behind that ~95% of them have arrived: a slow phone network hides behind the buffer
// instead of freezing the picture. The delay adapts gently every half second.
function framePair(gap) {
  const n = Date.now();
  if (!FB.length) return null;
  if (n - playAt > 500 && LAT.length) {
    const s = [...LAT].sort((p, q) => p - q), want = s[Math.floor(s.length * 0.95)] + gap;
    playLag = playAt ? playLag + (want - playLag) * 0.35 : want;
    playAt = n;
  }
  const t = n - playLag, j = FB.findIndex(x => x.t >= t);
  if (j < 0) return { a: FB.at(-1).f, b: FB.at(-1).f, k: 1 };
  if (j === 0) return { a: FB[0].f, b: FB[0].f, k: 1 };
  const A = FB[j - 1], B = FB[j];
  return { a: A.f, b: B.f, k: (t - A.t) / (B.t - A.t || 1) };
}
const mix = (a, b, k) => (typeof b === 'number' ? (typeof a === 'number' ? a + (b - a) * k : b)
  : Array.isArray(b) ? b.map((x, i) => mix(a?.[i], x, k))
  : b && typeof b === 'object' ? Object.fromEntries(Object.entries(b).map(([key, x]) => [key, mix(a?.[key], x, k)])) : b);
const frameNow = delay => { const p = framePair(delay); return p && mix(p.a, p.b, p.k); };
let steerAt = 0, steerNext, steerTimer; // continuous steering: at most ~22 messages a second
const steer = o => {
  steerNext = o;
  steerTimer ??= setTimeout(() => { steerTimer = null; steerAt = performance.now(); input(steerNext); }, Math.max(0, 45 - (performance.now() - steerAt)));
};
const SEATS = ['#38bdf8', '#f472b6', '#ffd23f', '#34d399', '#a78bfa', '#fb923c', '#f87171', '#e5e7eb'];
const KEYDIR = { ArrowUp: 0, KeyW: 0, ArrowRight: 1, KeyD: 1, ArrowDown: 2, KeyS: 2, ArrowLeft: 3, KeyA: 3 };
// drag-anywhere joystick + WASD/arrows + Space for the action; `map` turns a screen vector into a world one
function joystick(cv, at, { me, action, map = v => v, size = 110 }) {
  const j = { o: null, v: [0, 0] }, held = new Set();
  const push = act => {
    if (me < 0) return;
    const [x, y] = map(j.v);
    act ? input({ x, y, [action]: true }) : steer({ x: +x.toFixed(2), y: +y.toFixed(2) });
  };
  j.fire = () => { push(true); feel('tap', 20); };
  const down = e => { j.o = at(e); j.v = [0, 0]; cv.setPointerCapture?.(e.pointerId); };
  const move = e => {
    if (!j.o) return;
    const [px, py] = at(e), dx = px - j.o[0], dy = py - j.o[1], l = Math.hypot(dx, dy), k = Math.min(1, l / size) / (l || 1);
    j.v = [dx * k, dy * k]; push();
  };
  const lift = () => { j.o = null; j.v = [0, 0]; push(); };
  const keys = e => {
    if (e.code === 'Space') { if (e.type === 'keydown' && !e.repeat) j.fire(); return e.preventDefault(); }
    if (!(e.code in KEYDIR)) return;
    e.preventDefault();
    e.type === 'keydown' ? held.add(KEYDIR[e.code]) : held.delete(KEYDIR[e.code]);
    const sx = held.has(1) - held.has(3), sy = held.has(2) - held.has(0), l = Math.hypot(sx, sy) || 1;
    j.v = [sx / l, sy / l]; push();
  };
  cv.addEventListener('pointerdown', down); cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', lift); cv.addEventListener('pointercancel', lift);
  addEventListener('keydown', keys); addEventListener('keyup', keys);
  j.draw = (x, scale = 1) => {
    if (!j.o) return;
    x.lineWidth = 4 * scale; x.strokeStyle = '#ffffff80'; x.beginPath(); x.arc(j.o[0], j.o[1], size, 0, 7); x.stroke();
    x.fillStyle = '#ffffff80'; x.beginPath(); x.arc(j.o[0] + j.v[0] * size, j.o[1] + j.v[1] * size, size * 0.36, 0, 7); x.fill();
  };
  j.off = () => {
    removeEventListener('keydown', keys); removeEventListener('keyup', keys);
    cv.removeEventListener('pointerdown', down); cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', lift); cv.removeEventListener('pointercancel', lift);
  };
  return j;
}
const avatarOf = (ids, i) => EMOJI[(P(ids[i])?.avatar ?? i) % 20];
function disc(x, px, py, rad, color, emoji, { me, glow, label } = {}) { // flat and cheap: phones redraw these 60 times a second
  if (glow) { x.fillStyle = '#ffffff55'; x.beginPath(); x.arc(px, py, rad * 1.4, 0, 7); x.fill(); }
  x.fillStyle = '#0004'; x.beginPath(); x.arc(px + rad * 0.12, py + rad * 0.2, rad, 0, 7); x.fill();
  x.fillStyle = color; x.beginPath(); x.arc(px, py, rad, 0, 7); x.fill();
  if (me) { x.lineWidth = rad * 0.16; x.strokeStyle = '#fff'; x.stroke(); }
  x.textAlign = 'center'; x.textBaseline = 'middle'; x.font = `${Math.round(rad * 1.05)}px system-ui`; x.fillText(emoji, px, py + rad * 0.06);
  if (label) { x.font = `700 ${Math.round(rad * 0.48)}px system-ui`; x.fillStyle = '#fff'; x.fillText(label, px, py + rad * 1.55); }
  x.textBaseline = 'alphabetic';
}
const LIVE_HELP = {
  hockey: 'Drag your mallet (or just move the mouse). Your goal is at the bottom. First to 7 wins.',
  sumo: 'Drag anywhere to steer, 💨 to dash. Laptop: WASD or arrows, Space to dash. Stay in the ring!',
  snake: 'Swipe, use the arrows or WASD. Eat to grow. Last snake slithering wins the round.',
  land: 'Leave your land, draw a loop and come home to claim everything inside. Cross a trail to knock its owner out; don’t touch your own.',
  paint: 'Roll over the floor to paint it. Drag to steer, 💨 to dash into people. Most floor in 60 s wins.',
  volley: 'Phones side by side make one court. When the ball is on your screen, flick it up and over the net. Don’t let it land on your side.',
  kickabout: 'Drag to run, ⚽ (or Space) to kick: the ball goes where you’re pushing. You always attack upwards.',
  hill: 'Get into the glowing zone and stay there alone. Crowded? Whoever is closest to the middle scores at half speed. 💨 to shove.',
  tag: 'The 😈 is IT. Bump someone to pass it on; least time as IT wins. 💨 dashes.',
  coins: 'Grab coins (gold ones are worth 5). Dash into someone and they spill 3 coins.',
  trails: 'Swipe or use the arrows. Your trail is a wall for everyone. Last rider wins the round.',
};
// a background drawn once and reused every frame
function backdrop(W, H, paint) { const c = document.createElement('canvas'); c.width = W; c.height = H; paint(c.getContext('2d')); return c; }
const swipe = (cv, at, go, min = 24) => { // turn as soon as the finger has moved far enough, then keep tracking
  let o = null;
  const down = e => { o = at(e); cv.setPointerCapture?.(e.pointerId); };
  const move = e => {
    if (!o) return;
    const [px, py] = at(e), dx = px - o[0], dy = py - o[1];
    if (Math.max(Math.abs(dx), Math.abs(dy)) < min) return;
    go(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0);
    o = [px, py];
  };
  const lift = () => (o = null);
  const keys = e => { if (e.code in KEYDIR) { e.preventDefault(); if (!e.repeat) go(KEYDIR[e.code]); } };
  cv.addEventListener('pointerdown', down); cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', lift);
  addEventListener('keydown', keys);
  return () => { removeEventListener('keydown', keys); cv.removeEventListener('pointerdown', down); cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', lift); };
};
const DPad = ({ go }) => html`<div class="pad">${[['▲', 0, 'up'], ['◀', 3, 'left'], ['▼', 2, 'down'], ['▶', 1, 'right']].map(([g, d, n]) => html`
  <button key=${d} class="btn d${d}" aria-label=${`Turn ${n}`} onPointerDown=${e => { e.preventDefault(); go(d); }}>${g}</button>`)}</div>`;
// grid movers slide smoothly from cell to cell: a cell that moved by one is eased, anything else (respawn, wrap) jumps
const slide = (a, b, k, n) => {
  const bx = b % n, by = Math.floor(b / n);
  if (a == null || a < 0) return [bx, by];
  const ax = a % n, ay = Math.floor(a / n);
  return Math.abs(ax - bx) + Math.abs(ay - by) === 1 ? [ax + (bx - ax) * k, ay + (by - ay) * k] : [bx, by];
};
function Live({ v, r, id }) {
  const me = v.players.indexOf(r.you), Game = { hockey: Hockey, sumo: Sumo, snake: Snake, land: Land, paint: Paint, kickabout: Kickabout, volley: Volley, hill: ArenaPlay, tag: ArenaPlay, coins: ArenaPlay, trails: Trails }[id];
  const [top, bot] = me === 1 ? [v.players[0], v.players[1]] : [v.players[1], v.players[0]]; // hockey: you're always at the bottom
  const hWin = id === 'hockey' && (v.goals[top] === v.goals[bot] ? null : v.goals[top] > v.goals[bot] ? top : bot);
  const myTeam = v.team?.[me] ?? 0, kWin = (id === 'kickabout' || id === 'volley') && (v.goals[0] === v.goals[1] ? null : v.goals[0] > v.goals[1] ? 0 : 1);
  const banner = v.phase === 'ready' ? html`<span>${v.round ? `Round ${v.round} of ${v.rounds}` : 'Get ready'}</span><span class="big-count"><${Timer} at=${v.deadline} /></span>`
    : v.phase === 'gap' ? (v.winner ? `${nameOf(v.winner)} takes round ${v.round}!` : 'Nobody made it!')
    : v.phase === 'over' ? (id === 'hockey' ? (hWin ? `${nameOf(hWin)} wins!` : 'A draw!') : id === 'kickabout' || id === 'volley' ? (kWin == null ? 'Full time: a draw!' : `Full time: ${TEAMS[kWin].name} win!`)
      : ['paint', 'land', 'hill', 'tag', 'coins'].includes(id) ? 'Time! Counting…' : v.winner ? `${nameOf(v.winner)} wins it!` : 'Game over!')
    : null;
  useEffect(() => { if (v.phase === 'gap' || v.phase === 'over') feel(v.winner === r.you || hWin === r.you || (kWin != null && kWin === myTeam && me >= 0) ? 'win' : 'drop', 60); }, [v.phase]);
  useEffect(() => { if (v.goals && v.phase === 'play') feel('goal', 50); }, [JSON.stringify(v.goals)]);
  const hud = id === 'hockey' ? html`<div class="pen-score"><span>${nameOf(top)}</span><b>${v.goals[top]} – ${v.goals[bot]}</b><span>${nameOf(bot)}</span></div>`
    : id === 'kickabout' || id === 'volley' ? html`<div class="pen-score foot"><span style=${`color:${TEAMS[0].color}`}>● ${TEAMS[0].name}</span><b>${v.goals[0]} – ${v.goals[1]}</b><span style=${`color:${TEAMS[1].color}`}>${TEAMS[1].name} ●</span></div>
        <div class="chips">${v.players.map((p, i) => html`<span key=${p} class="chip ${p === r.you ? 'on' : ''}"><i class="seat" style=${`background:${TEAMS[v.team[i]].color}`} /> ${nameOf(p)}</span>`)}</div>`
    : ['paint', 'land', 'hill', 'tag', 'coins'].includes(id) ? html`<div class="chips">${v.players.map((p, i) => html`<span key=${p} class="chip ${p === r.you ? 'on' : ''}"><i class="seat" style=${`background:${SEATS[i]}`} /> ${nameOf(p)}</span>`)}</div>`
    : html`<div class="chips">${v.players.map((p, i) => html`<span key=${p} class="chip ${p === r.you ? 'on' : ''}"><i class="seat" style=${`background:${SEATS[i]}`} /> ${nameOf(p)} · ${'🏆'.repeat(v.wins[p]) || 0}</span>`)}</div>`;
  return html`<div class="live">${hud}
    <div class="live-stage"><${Game} key=${id} v=${v} me=${me} id=${id} />${banner && html`<div class="live-banner">${banner}</div>`}</div>
    ${me >= 0 && html`<p class="small muted center-text">${LIVE_HELP[id]}</p>`}
  </div>`;
}

// Air hockey: plain table, no frills, runs smooth
function Hockey({ me }) {
  const ref = useCanvas(600, 1000, (cv, x, at) => {
    const T = ([px, py]) => (me === 1 ? [600 - px, 1000 - py] : [px, py]); // table ⇄ screen (its own inverse)
    const half = ([px, py]) => [Math.max(46, Math.min(554, px)), me === 0 ? Math.max(546, Math.min(954, py)) : Math.max(46, Math.min(454, py))];
    const bg = backdrop(600, 1000, b => {
      b.fillStyle = '#eef6fc'; b.fillRect(0, 0, 600, 1000);
      b.lineWidth = 6; b.strokeStyle = '#ef444466'; b.beginPath(); b.moveTo(0, 500); b.lineTo(600, 500); b.stroke();
      b.beginPath(); b.arc(300, 500, 90, 0, 7); b.stroke();
      b.strokeStyle = '#3b82f655';
      for (const gy of [0, 1000]) { b.beginPath(); b.arc(300, gy, 150, 0, 7); b.stroke(); b.fillStyle = '#0f172a'; b.fillRect(185, gy - 14, 230, 28); }
    });
    let mine = null;
    const move = e => { if (me < 0) return; mine = half(T(at(e))); steer({ x: Math.round(mine[0]), y: Math.round(mine[1]) }); };
    cv.addEventListener('pointerdown', move);
    cv.addEventListener('pointermove', move);
    let raf;
    const loop = () => {
      x.drawImage(bg, 0, 0, 600, 1000);
      const p = framePair(GAP.hockey), f = p && mix(p.a, p.b, p.k);
      if (f) {
        const [kx, ky] = T(f.k);
        x.fillStyle = '#111827'; x.beginPath(); x.arc(kx, ky, 28, 0, 7); x.fill();
        f.m.forEach((m, i) => {
          const [mx, my] = T(i === me && mine ? mine : m), c = i === 0 ? '#ef4444' : '#2563eb'; // your own mallet follows your finger, no lag
          x.fillStyle = c; x.beginPath(); x.arc(mx, my, 46, 0, 7); x.fill();
          x.fillStyle = '#ffffff66'; x.beginPath(); x.arc(mx, my, 24, 0, 7); x.fill();
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); cv.removeEventListener('pointerdown', move); cv.removeEventListener('pointermove', move); };
  });
  return html`<canvas ref=${ref} class="arena tall" aria-label="Air hockey table: drag to move your mallet" />`;
}

// Sumo: the original look, plus name tags, a dash cooldown ring and a splash when someone falls in
function Sumo({ v, me }) {
  const ids = useRef(v.players), dash = useRef(), btn = useRef();
  const ref = useCanvas(1000, 1000, (cv, x, at) => {
    const j = joystick(cv, at, { me, action: 'dash' });
    dash.current = j.fire;
    const bg = backdrop(1000, 1000, b => {
      const lava = b.createRadialGradient(500, 500, 200, 500, 500, 720);
      lava.addColorStop(0, '#f97316'); lava.addColorStop(1, '#7c2d12');
      b.fillStyle = lava; b.fillRect(0, 0, 1000, 1000);
    });
    const splash = [], was = [];
    let raf;
    const loop = t => {
      x.drawImage(bg, 0, 0, 1000, 1000);
      const p = framePair(GAP.sumo), f = p && mix(p.a, p.b, p.k);
      if (f) {
        x.fillStyle = '#f5e6c8'; x.beginPath(); x.arc(500, 500, f.ring, 0, 7); x.fill();
        x.lineWidth = 12; x.strokeStyle = f.ring < 440 ? `rgba(239,68,68,${0.55 + Math.sin(t / 150) * 0.3})` : '#fff7'; x.stroke();
        x.lineWidth = 3; x.strokeStyle = '#c2a77455'; x.beginPath(); x.arc(500, 500, f.ring * 0.55, 0, 7); x.stroke();
        f.b.forEach(([bx, by, out], i) => {
          const o = out > 0.5;
          if (o && !was[i]) for (let k = 0; k < 14; k++) { const a = Math.random() * 7, s = 4 + Math.random() * 8; splash.push({ x: bx, y: by, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1, c: SEATS[i] }); }
          was[i] = o;
        });
        for (const s of splash) { s.x += s.vx; s.y += s.vy; s.life -= 0.03; x.globalAlpha = Math.max(0, s.life); x.fillStyle = s.c; x.beginPath(); x.arc(s.x, s.y, 9, 0, 7); x.fill(); }
        x.globalAlpha = 1;
        while (splash.length && splash[0].life <= 0) splash.shift();
        f.b.forEach(([bx, by, out, dashing, ready], i) => {
          if (out > 0.5) return;
          disc(x, bx, by, 40, SEATS[i], avatarOf(ids.current, i), { me: i === me, glow: dashing > 0.5, label: nameOf(ids.current[i]).slice(0, 10) });
          if (i === me) {
            btn.current?.classList.toggle('cooling', ready < 0.5);
            if (ready < 0.5) { x.strokeStyle = '#fffa'; x.lineWidth = 6; x.beginPath(); x.arc(bx, by, 52, 0, 7); x.stroke(); }
          }
        });
      }
      j.draw(x);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); j.off(); };
  });
  return html`<canvas ref=${ref} class="arena sq" aria-label="Sumo ring: drag to steer" />
    ${me >= 0 && html`<button ref=${btn} class="btn primary dash" onPointerDown=${() => dash.current?.()}>💨 Dash</button>`}`;
}

// Snake Battle: classic grid snakes, sliding smoothly between cells
const SN = 32;
function Snake({ me }) {
  const go = d => { if (me >= 0) { input({ d }); feel('tap', 8); } };
  const ref = useCanvas(640, 640, (cv, x, at) => {
    const C = 640 / SN, off = swipe(cv, at, go);
    const bg = backdrop(640, 640, b => {
      b.fillStyle = '#0b1220'; b.fillRect(0, 0, 640, 640);
      b.fillStyle = '#111b30';
      for (let i = 0; i < SN * SN; i++) if ((i + Math.floor(i / SN)) % 2) b.fillRect((i % SN) * C, Math.floor(i / SN) * C, C, C);
    });
    let raf;
    const loop = () => {
      x.drawImage(bg, 0, 0, 640, 640);
      const p = framePair(GAP.snake);
      if (p) {
        for (const c of p.b.food) { // apples
          const fx = (c % SN) * C + C / 2, fy = Math.floor(c / SN) * C + C / 2;
          x.fillStyle = '#ef4444'; x.beginPath(); x.arc(fx, fy + 1, C * 0.36, 0, 7); x.fill();
          x.fillStyle = '#22c55e'; x.fillRect(fx, fy - C * 0.45, C * 0.2, C * 0.18);
        }
        x.lineCap = x.lineJoin = 'round';
        p.b.sn.forEach((body, i) => {
          const pts = body.filter(c => c >= 0).map((c, k) => slide(p.a.sn[i]?.[k], c, p.k, SN)).map(([cx, cy]) => [cx * C + C / 2, cy * C + C / 2]);
          if (!pts.length) return;
          const path = () => { x.beginPath(); pts.forEach(([px, py], k) => (k ? x.lineTo(px, py) : x.moveTo(px, py))); };
          path(); x.strokeStyle = '#0009'; x.lineWidth = C * 0.86; x.stroke();
          path(); x.strokeStyle = SEATS[i]; x.lineWidth = C * 0.7; x.stroke();
          const [hx, hy] = pts[0], [nx, ny] = pts[1] ?? [hx - 1, hy], l = Math.hypot(hx - nx, hy - ny) || 1, ux = (hx - nx) / l, uy = (hy - ny) / l;
          x.fillStyle = SEATS[i]; x.beginPath(); x.arc(hx, hy, C * 0.5, 0, 7); x.fill();
          if (i === me) { x.lineWidth = 3; x.strokeStyle = '#fff'; x.stroke(); }
          for (const sgn of [1, -1]) { // eyes look where it's going
            const ex = hx + ux * C * 0.12 - uy * sgn * C * 0.22, ey = hy + uy * C * 0.12 + ux * sgn * C * 0.22;
            x.fillStyle = '#fff'; x.beginPath(); x.arc(ex, ey, C * 0.15, 0, 7); x.fill();
            x.fillStyle = '#000'; x.beginPath(); x.arc(ex + ux * C * 0.06, ey + uy * C * 0.06, C * 0.07, 0, 7); x.fill();
          }
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); off(); };
  });
  return html`<canvas ref=${ref} class="arena sq" aria-label="Snake grid: swipe to turn" />${me >= 0 && html`<${DPad} go=${go} />`}`;
}

// Land Grab
const LN = 36;
function Land({ v, me }) {
  const ids = useRef(v.players);
  const go = d => { if (me >= 0) { input({ d }); feel('tap', 8); } };
  const ref = useCanvas(720, 770, (cv, x, at) => {
    const C = 720 / LN, off = swipe(cv, at, go);
    const bg = backdrop(720, 720, b => {
      b.fillStyle = '#f1f5f9'; b.fillRect(0, 0, 720, 720);
      b.fillStyle = '#e2e8f0';
      for (let i = 0; i < LN * LN; i++) if ((i + Math.floor(i / LN)) % 2) b.fillRect((i % LN) * C, Math.floor(i / LN) * C, C, C);
    });
    let raf, counted = null, counts = [];
    const loop = () => {
      x.fillStyle = '#111827'; x.fillRect(0, 0, 720, 50);
      x.drawImage(bg, 0, 50, 720, 720);
      const p = framePair(GAP.land);
      if (p) {
        const f = p.b;
        if (counted !== f) { counted = f; counts = ids.current.map((_, i) => { let n = 0; for (const ch of f.g) n += ch === String(i + 1); return n; }); }
        let x0 = 10; // who owns how much
        counts.forEach((n, i) => { const w = (700 * n) / (LN * LN); x.fillStyle = SEATS[i]; x.fillRect(x0, 14, w, 22); x0 += w; });
        x.save(); x.translate(0, 50);
        for (let c = 0; c < LN * LN; c++) {
          const o = f.g.charCodeAt(c) - 48;
          if (o > 0) { x.fillStyle = SEATS[o - 1]; x.fillRect((c % LN) * C, Math.floor(c / LN) * C, C + 0.5, C + 0.5); }
        }
        f.p.forEach((pl, i) => { // trails: a fainter stripe of your colour
          if (!pl.length) return;
          x.fillStyle = SEATS[i] + '88';
          for (let k = 3; k < pl.length; k++) x.fillRect((pl[k] % LN) * C + C * 0.2, Math.floor(pl[k] / LN) * C + C * 0.2, C * 0.6, C * 0.6);
        });
        f.p.forEach((pl, i) => { // heads slide between cells
          if (!pl.length) return;
          const a = p.a.p[i], [hx, hy] = slide(a?.length ? a[1] * LN + a[0] : null, pl[1] * LN + pl[0], p.k, LN);
          const px = hx * C + C / 2, py = hy * C + C / 2;
          x.fillStyle = '#0006'; x.fillRect(px - C * 0.55 + 2, py - C * 0.55 + 3, C * 1.1, C * 1.1);
          x.fillStyle = SEATS[i]; x.fillRect(px - C * 0.55, py - C * 0.55, C * 1.1, C * 1.1);
          x.lineWidth = i === me ? 3 : 1.5; x.strokeStyle = i === me ? '#fff' : '#0008'; x.strokeRect(px - C * 0.55, py - C * 0.55, C * 1.1, C * 1.1);
          x.font = `${Math.round(C * 0.85)}px system-ui`; x.textAlign = 'center'; x.textBaseline = 'middle';
          x.fillText(avatarOf(ids.current, i), px, py + 1); x.textBaseline = 'alphabetic';
        });
        x.restore();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); off(); };
  });
  return html`<canvas ref=${ref} class="arena land-cv" aria-label="Land Grab board: swipe to turn" />${me >= 0 && html`<${DPad} go=${go} />`}`;
}

// Paint Grab: flat and simple
const PGN = 30;
function Paint({ v, me }) {
  const ids = useRef(v.players), dash = useRef();
  const ref = useCanvas(1000, 1060, (cv, x, at) => {
    const j = joystick(cv, at, { me, action: 'dash' });
    dash.current = j.fire;
    let raf, counted = null, counts = [];
    const loop = () => {
      x.fillStyle = '#111827'; x.fillRect(0, 0, 1000, 60);
      x.fillStyle = '#e5e7eb'; x.fillRect(0, 60, 1000, 1000);
      const p = framePair(GAP.paint), raw = p?.b;
      if (raw) {
        if (counted !== raw) { counted = raw; counts = ids.current.map((_, i) => { let n = 0; for (const ch of raw.g) n += ch === String(i + 1); return n; }); }
        let x0 = 20;
        counts.forEach((n, i) => { const w = (960 * n) / (PGN * PGN); x.fillStyle = SEATS[i]; x.fillRect(x0, 16, w, 28); x0 += w; });
        const cell = 1000 / PGN;
        x.save(); x.translate(0, 60);
        for (let i = 0; i < PGN * PGN; i++) {
          const o = raw.g.charCodeAt(i) - 48;
          if (o > 0) { x.fillStyle = SEATS[o - 1]; x.fillRect((i % PGN) * cell, Math.floor(i / PGN) * cell, cell + 0.5, cell + 0.5); }
        }
        const f = mix(p.a, p.b, p.k);
        f.b.forEach(([bx, by, dashing], i) => disc(x, bx, by, 30, SEATS[i], avatarOf(ids.current, i), { me: i === me, glow: dashing > 0.5 }));
        x.restore();
      }
      j.draw(x);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); j.off(); };
  });
  return html`<canvas ref=${ref} class="arena paint-cv" aria-label="Paint arena: drag to roll" />
    ${me >= 0 && html`<button class="btn primary dash" onPointerDown=${() => dash.current?.()}>💨 Dash</button>`}`;
}

// Kickabout. On a phone the pitch turns upright and you always attack upwards; on a TV it lies flat.
const TEAMS = [{ name: 'Blue', color: '#3b82f6' }, { name: 'Red', color: '#ef4444' }], FW = 1600, FH = 1000;
function Kickabout({ v, me }) {
  const ids = useRef(v.players), team = me >= 0 ? v.team[me] : 0, kick = useRef();
  const upright = me >= 0 && matchMedia('(orientation: portrait)').matches;
  const [cw, ch] = upright ? [FH + 80, FW + 80] : [FW + 80, FH + 80];
  const ref = useCanvas(cw, ch, (cv, x, at) => {
    // world → screen; your team always attacks up (upright) / right (flat)
    const W2S = upright ? (team === 0 ? ([wx, wy]) => [wy + 40, FW - wx + 40] : ([wx, wy]) => [FH - wy + 40, wx + 40]) : ([wx, wy]) => [wx + 40, wy + 40];
    const map = upright ? (team === 0 ? ([sx, sy]) => [-sy, sx] : ([sx, sy]) => [sy, -sx]) : v2 => v2;
    const j = joystick(cv, at, { me, action: 'kick', map, size: 120 });
    kick.current = j.fire;
    const bg = backdrop(cw, ch, b => {
      b.fillStyle = '#166534'; b.fillRect(0, 0, cw, ch);
      for (let i = 0; i < 10; i++) {
        b.fillStyle = i % 2 ? '#1f8f4e' : '#1b8246';
        const [ax, ay] = W2S([(i * FW) / 10, 0]), [bx, by] = W2S([((i + 1) * FW) / 10, FH]);
        b.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      }
      const line = (p1, p2) => { const [ax, ay] = W2S(p1), [bx, by] = W2S(p2); b.beginPath(); b.moveTo(ax, ay); b.lineTo(bx, by); b.stroke(); };
      b.strokeStyle = '#ffffffcc'; b.lineWidth = 6;
      line([0, 0], [FW, 0]); line([FW, 0], [FW, FH]); line([FW, FH], [0, FH]); line([0, FH], [0, 0]); line([FW / 2, 0], [FW / 2, FH]);
      const [cx, cy] = W2S([FW / 2, FH / 2]); b.beginPath(); b.arc(cx, cy, 130, 0, 7); b.stroke();
      for (const gx of [0, FW]) { const d = gx ? -1 : 1; line([gx, 260], [gx + d * 240, 260]); line([gx + d * 240, 260], [gx + d * 240, 740]); line([gx + d * 240, 740], [gx, 740]); }
      for (const [gx, t2] of [[0, 0], [FW, 1]]) {
        const d = gx ? 1 : -1, [ax, ay] = W2S([gx, 360]), [bx, by] = W2S([gx + d * 36, 640]);
        b.fillStyle = TEAMS[t2].color + '77'; b.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
        b.strokeStyle = '#fff'; b.lineWidth = 5; b.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      }
    });
    let raf;
    const loop = t => {
      x.drawImage(bg, 0, 0, cw, ch);
      const p = framePair(GAP.kickabout), f = p && mix(p.a, p.b, p.k);
      if (f) {
        f.p.forEach((pp, i) => { const [px, py] = W2S(pp); disc(x, px, py, 38, TEAMS[v.team[i]].color, avatarOf(ids.current, i), { me: i === me }); });
        const [bx, by] = W2S(f.k);
        x.save(); x.translate(bx, by); ballArt(x, 24, t / 200); x.restore();
      }
      j.draw(x);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); j.off(); };
  });
  return html`<canvas ref=${ref} class=${`arena ${upright ? 'pitch-up' : 'pitch'}`} aria-label="Football pitch: drag to run" />
    ${me >= 0 && html`<button class="btn primary dash" onPointerDown=${() => kick.current?.()}>⚽ Kick</button>`}`;
}

// Table Volley: every phone draws its own slice of one long court. Lay them side by side in the order shown.
const VSW = 600, VSH = 1000, VNET = 600;
function Volley({ v, me }) {
  const n = v.players.length, L = n * VSW, whole = me < 0, x0 = whole ? 0 : me * VSW, W = whole ? L : VSW;
  const ref = useCanvas(W, VSH, (cv, x, at) => {
    const bg = backdrop(W, VSH, b => {
      const sky = b.createLinearGradient(0, 0, 0, VSH); sky.addColorStop(0, '#38bdf8'); sky.addColorStop(1, '#bae6fd');
      b.fillStyle = sky; b.fillRect(0, 0, W, VSH);
      b.fillStyle = '#fde68a'; b.fillRect(0, VSH - 60, W, 60); // sand
      for (let i = 0; i < n; i++) { // whose side is whose
        const sx = i * VSW - x0; if (sx + VSW < 0 || sx > W) continue;
        b.fillStyle = TEAMS[v.team[i]].color + '22'; b.fillRect(sx, VSH - 60, VSW, 60);
        b.fillStyle = '#0f172a55'; b.font = '800 160px system-ui'; b.textAlign = 'center'; b.fillText(String(i + 1), sx + VSW / 2, 260);
        b.font = '700 40px system-ui'; b.fillText(nameOf(v.players[i]).slice(0, 12), sx + VSW / 2, 320);
      }
      const nx = L / 2 - x0; // the net, if it's on this screen
      if (nx > -20 && nx < W + 20) {
        b.fillStyle = '#334155'; b.fillRect(nx - 8, VNET, 16, VSH - VNET);
        b.strokeStyle = '#ffffffcc'; b.lineWidth = 2;
        for (let y = VNET; y < VSH - 60; y += 22) { b.beginPath(); b.moveTo(nx - 8, y); b.lineTo(nx + 8, y); b.stroke(); }
        b.fillStyle = '#fff'; b.fillRect(nx - 12, VNET - 10, 24, 14);
      }
    });
    let start = null;
    const down = e => { const [px, py] = at(e); start = [px + x0, py, performance.now()]; cv.setPointerCapture?.(e.pointerId); };
    const lift = e => {
      if (!start || me < 0) return (start = null);
      const [px, py] = at(e), dt = Math.max(40, performance.now() - start[2]) / 1000;
      const vx = Math.max(-2200, Math.min(2200, (px + x0 - start[0]) / dt * 1.3)), vy = Math.max(-2600, Math.min(2600, (py - start[1]) / dt * 1.3));
      input({ x: Math.round(start[0]), y: Math.round(start[1]), vx: Math.round(vx), vy: Math.round(vy) });
      feel('tap', 15); start = null;
    };
    cv.addEventListener('pointerdown', down); cv.addEventListener('pointerup', lift);
    let raf;
    const loop = t => {
      x.drawImage(bg, 0, 0, W, VSH);
      const p = framePair(GAP.volley), f = p && mix(p.a, p.b, p.k);
      if (f) {
        const bx = f.k[0] - x0, by = f.k[1];
        x.fillStyle = '#0003'; x.beginPath(); x.ellipse(bx, VSH - 50, 30 * (0.5 + by / VSH / 2), 8, 0, 0, 7); x.fill();
        if (bx > -40 && bx < W + 40) {
          x.fillStyle = '#fff'; x.beginPath(); x.arc(bx, by, 36, 0, 7); x.fill();
          x.strokeStyle = '#f59e0b'; x.lineWidth = 5; x.beginPath(); x.arc(bx, by, 36, t / 300, t / 300 + 2); x.stroke();
          x.strokeStyle = '#2563eb'; x.beginPath(); x.arc(bx, by, 36, t / 300 + 3, t / 300 + 5); x.stroke();
        } else if (!whole) { // off this screen: an arrow points to where it is
          x.fillStyle = '#0f172acc'; x.font = '800 70px system-ui'; x.textAlign = 'center';
          x.fillText(bx < 0 ? '◀' : '▶', bx < 0 ? 50 : W - 50, Math.max(80, Math.min(VSH - 100, by)));
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); cv.removeEventListener('pointerdown', down); cv.removeEventListener('pointerup', lift); };
  });
  return html`<canvas ref=${ref} class=${`arena ${whole ? 'court' : 'tall'}`} aria-label="Volleyball court slice: flick the ball" />
    ${v.phase === 'ready' && html`<p class="soft">📱 Lay the phones side by side, left to right: ${v.players.map((p, i) => `${i + 1}. ${nameOf(p)}`).join('  ')}</p>`}`;
}

// ── more live games ──
// King of the Hill, Bumper Tag and Coin Rush share one arena: joystick, dash, a score strip on top
const FLOOR = { hill: '#1e293b', tag: '#14532d', coins: '#312e81' }, UNIT = { hill: 's', tag: 's IT', coins: '🪙' };
function ArenaPlay({ v, me, id }) {
  const ids = useRef(v.players), dash = useRef(), btn = useRef();
  const ref = useCanvas(1000, 1070, (cv, x, at) => {
    const j = joystick(cv, at, { me, action: 'dash' });
    dash.current = j.fire;
    const bg = backdrop(1000, 1000, b => {
      b.fillStyle = FLOOR[id]; b.fillRect(0, 0, 1000, 1000);
      b.strokeStyle = '#ffffff10'; b.lineWidth = 2;
      for (let k = 100; k < 1000; k += 100) { b.beginPath(); b.moveTo(k, 0); b.lineTo(k, 1000); b.moveTo(0, k); b.lineTo(1000, k); b.stroke(); }
      b.strokeStyle = '#ffffff40'; b.lineWidth = 8; b.strokeRect(4, 4, 992, 992);
    });
    let raf;
    const loop = t => {
      const p = framePair(GAP[id]), raw = p?.b, f = p && mix(p.a, p.b, p.k);
      x.fillStyle = '#0b0d12'; x.fillRect(0, 0, 1000, 70);
      x.drawImage(bg, 0, 70, 1000, 1000);
      if (raw) {
        const n = ids.current.length, w = 1000 / n; // score strip
        raw.sc.forEach((sc, i) => {
          x.fillStyle = i === me ? '#ffffff22' : '#ffffff0a'; x.fillRect(i * w + 4, 8, w - 8, 54);
          x.fillStyle = SEATS[i]; x.beginPath(); x.arc(i * w + 26, 35, 11, 0, 7); x.fill();
          x.fillStyle = id === 'tag' && raw.it === i ? '#f87171' : '#fff'; x.font = `800 ${n > 5 ? 22 : 28}px system-ui`; x.textAlign = 'left';
          x.fillText(id === 'coins' ? String(sc) : sc.toFixed(1), i * w + 44, 45);
        });
        x.save(); x.translate(0, 70);
        if (id === 'hill') {
          if (raw.nz) { x.setLineDash([16, 12]); x.strokeStyle = '#ffd23f99'; x.lineWidth = 6; x.beginPath(); x.arc(raw.nz[0], raw.nz[1], 150, 0, 7); x.stroke(); x.setLineDash([]); }
          const held = raw.h >= 0 ? SEATS[raw.h] : '#ffd23f';
          x.fillStyle = held + '33'; x.beginPath(); x.arc(raw.z[0], raw.z[1], 150, 0, 7); x.fill();
          x.lineWidth = 8; x.strokeStyle = raw.cr ? `rgba(239,68,68,${0.55 + Math.sin(t / 120) * 0.35})` : held; x.stroke();
          x.font = '800 30px system-ui'; x.textAlign = 'center'; x.fillStyle = '#ffffffcc';
          x.fillText(raw.cr ? 'CROWDED · half points' : raw.h >= 0 ? '👑' : 'GET IN', raw.z[0], raw.z[1] - 162);
        }
        if (id === 'coins') for (let k = 0; k < raw.c.length; k += 3) {
          const big = raw.c[k + 2] > 1, cr = big ? 22 : 14;
          x.fillStyle = '#b45309'; x.beginPath(); x.arc(raw.c[k], raw.c[k + 1] + 3, cr, 0, 7); x.fill();
          x.fillStyle = big ? '#fde047' : '#facc15'; x.beginPath(); x.arc(raw.c[k], raw.c[k + 1], cr, 0, 7); x.fill();
          if (big) { x.fillStyle = '#92400e'; x.font = '800 22px system-ui'; x.textAlign = 'center'; x.fillText('5', raw.c[k], raw.c[k + 1] + 8); }
        }
        f.b.forEach(([bx, by, dashing, ready], i) => {
          const it = id === 'tag' && raw.it === i, stunned = raw.st?.[i];
          if (it) { x.fillStyle = `rgba(239,68,68,${0.35 + Math.sin(t / 110) * 0.2})`; x.beginPath(); x.arc(bx, by, 58, 0, 7); x.fill(); }
          if (stunned) x.globalAlpha = 0.5;
          disc(x, bx, by, 34, SEATS[i], it ? '😈' : avatarOf(ids.current, i), { me: i === me, glow: dashing > 0.5, label: it ? 'IT!' : nameOf(ids.current[i]).slice(0, 9) });
          x.globalAlpha = 1;
          if (i === me) btn.current?.classList.toggle('cooling', ready < 0.5);
        });
        x.restore();
      }
      j.draw(x);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); j.off(); };
  });
  return html`<canvas ref=${ref} class="arena arena-cv" aria-label="Arena: drag to move" />
    ${me >= 0 && html`<button ref=${btn} class="btn primary dash" onPointerDown=${() => dash.current?.()}>💨 Dash</button>`}`;
}

// Light Trails
const TN = 40;
function Trails({ v, me }) {
  const go = d => { if (me >= 0) { input({ d }); feel('tap', 8); } };
  const ref = useCanvas(800, 800, (cv, x, at) => {
    const C = 800 / TN, off = swipe(cv, at, go);
    const bg = backdrop(800, 800, b => {
      b.fillStyle = '#050816'; b.fillRect(0, 0, 800, 800);
      b.strokeStyle = '#1e293b'; b.lineWidth = 1;
      for (let k = 0; k <= 800; k += C) { b.beginPath(); b.moveTo(k, 0); b.lineTo(k, 800); b.moveTo(0, k); b.lineTo(800, k); b.stroke(); }
    });
    let raf;
    const loop = () => {
      x.drawImage(bg, 0, 0, 800, 800);
      const p = framePair(GAP.trails);
      if (p) {
        const f = p.b;
        for (let c = 0; c < TN * TN; c++) {
          const o = f.g.charCodeAt(c) - 48;
          if (o > 0) { x.fillStyle = SEATS[o - 1]; x.fillRect((c % TN) * C + 2, Math.floor(c / TN) * C + 2, C - 4, C - 4); }
        }
        f.r.forEach((rd, i) => {
          if (!rd.length) return;
          const a = p.a.r[i], [hx, hy] = slide(a?.length ? a[1] * TN + a[0] : null, rd[1] * TN + rd[0], p.k, TN);
          const px = hx * C + C / 2, py = hy * C + C / 2;
          x.fillStyle = '#fff'; x.beginPath(); x.arc(px, py, C * 0.62, 0, 7); x.fill();
          x.fillStyle = SEATS[i]; x.beginPath(); x.arc(px, py, C * 0.42, 0, 7); x.fill();
          if (i === me) { x.strokeStyle = '#fff'; x.lineWidth = 3; x.beginPath(); x.arc(px, py, C * 0.95, 0, 7); x.stroke(); }
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); off(); };
  });
  return html`<canvas ref=${ref} class="arena sq" aria-label="Light Trails grid: swipe to turn" />${me >= 0 && html`<${DPad} go=${go} />`}`;
}

// Red Light, Green Light
const LIGHT = { green: ['GO!', 'Hold to run'], yellow: ['SLOW…', 'Red is coming'], red: ['STOP!', 'Let go or get caught'] };
function RedLight({ v, r }) {
  const me = v.players.indexOf(r.you), lanes = useRef([]), held = useRef(false), [down, setDown] = useState(false);
  const run = on => {
    if (me < 0 || (on && v.phase !== 'play') || held.current === on) return;
    held.current = on; setDown(on); input({ run: on });
  };
  useEffect(() => {
    const k = e => { if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) run(e.type === 'keydown'); } };
    addEventListener('keydown', k); addEventListener('keyup', k);
    let raf;
    const loop = () => {
      const f = frameNow(GAP.redlight);
      if (f) lanes.current.forEach((el, i) => { if (!el) return; el.style.setProperty('--p', f.p[i]); el.classList.toggle('caught', !!f.c[i]); });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); removeEventListener('keydown', k); removeEventListener('keyup', k); };
  }, []);
  useEffect(() => { if (v.light === 'red') feel('drop', 60); else if (v.light === 'green') feel('go', 30); }, [v.light]);
  const order = Object.keys(v.fin).sort((a, b) => v.fin[a] - v.fin[b]), [big, small] = LIGHT[v.light];
  return html`<div class="rl">
    <div class="rl-head ${v.light}"><div class="rl-lamps" aria-hidden="true"><i class="r" /><i class="y" /><i class="g" /></div>
      <div><b class="rl-big">${v.phase === 'ready' ? 'Get ready…' : big}</b><span class="small">${v.phase === 'ready' ? 'Hold the button when it turns green' : small}</span></div></div>
    <div class="rl-track">${v.players.map((p, i) => html`<div key=${p} class="rl-lane ${p === r.you ? 'me' : ''}" ref=${el => (lanes.current[i] = el)}>
      <span class="lane-name">${nameOf(p)}</span><span class="runner">${EMOJI[(P(p)?.avatar ?? i) % 20]}</span>
      ${p in v.fin && html`<span class="medal">${['🥇', '🥈', '🥉'][order.indexOf(p)] ?? '🏁'}</span>`}</div>`)}</div>
    ${me >= 0 && !(r.you in v.fin) && html`<button class="rl-btn ${down ? 'down' : ''} ${v.light}" onPointerDown=${e => { e.preventDefault(); run(true); }}
      onPointerUp=${() => run(false)} onPointerLeave=${() => run(false)} onPointerCancel=${() => run(false)} onContextMenu=${e => e.preventDefault()}>
      ${down ? 'RUNNING…' : 'HOLD TO RUN'}<small>or hold Space</small></button>`}
    ${r.you in v.fin && html`<p class="soft">🏁 You made it in ${(v.fin[r.you] / 1000).toFixed(1)} s</p>`}
  </div>`;
}

// Tug of War
function Tug({ v, r }) {
  const me = v.players.indexOf(r.you), team = me >= 0 ? v.team[me] : -1, rope = useRef(), rate = useRef(), pend = useRef(0), [taps, setTaps] = useState(0);
  const tap = () => { if (me < 0 || v.phase !== 'play') return; pend.current++; setTaps(n => n + 1); buzz(4); };
  useEffect(() => {
    const flush = setInterval(() => { if (pend.current) { input({ t: Math.min(6, pend.current) }); pend.current = 0; } }, 100);
    const k = e => { if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat) { e.preventDefault(); tap(); } };
    addEventListener('keydown', k);
    let raf;
    const loop = () => {
      const f = frameNow(GAP.tug);
      if (f && rope.current) { rope.current.style.setProperty('--r', f.r); rate.current.textContent = `${f.t[0]} vs ${f.t[1]} pulls/s`; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { clearInterval(flush); removeEventListener('keydown', k); cancelAnimationFrame(raf); };
  }, [v.phase]);
  const side = t => html`<div class="tug-team" style=${`--c:${TEAMS[t].color}`}><b>${TEAMS[t].name}</b>
    <span class="small">${v.players.filter((p, i) => v.team[i] === t).map(nameOf).join(', ')}</span></div>`;
  return html`<div class="tug">
    <div class="tug-teams">${side(0)}<span class="muted">vs</span>${side(1)}</div>
    <div class="tug-rope" ref=${rope}><span class="end l" /><span class="end r" /><i class="rope" /><span class="flag">🚩</span></div>
    <p class="small muted center-text" ref=${rate}>…</p>
    ${v.phase === 'ready' && html`<div class="center"><div class="big-count"><${Timer} at=${v.deadline} /></div></div>`}
    ${v.phase === 'over' && html`<h2 class="center-text">${v.winner == null ? 'Dead even!' : `${TEAMS[v.winner].name} win the tug!`}</h2>`}
    ${me >= 0 && v.phase === 'play' && html`<button class="tug-btn" style=${`--c:${TEAMS[team].color}`} onPointerDown=${e => { e.preventDefault(); tap(); }}>
      PULL!<small>${taps} taps · you're ${TEAMS[team].name} (${team ? '→' : '←'})</small></button>`}
  </div>`;
}

// Type Race
function TypeRace({ v, r }) {
  const me = v.players.indexOf(r.you), text = v.text, [pos, setPos] = useState(0), [word, setWord] = useState(''), field = useRef(), lanes = useRef([]);
  const play = v.phase === 'play' && me >= 0 && !(r.you in v.fin);
  const end = text.indexOf(' ', pos) < 0 ? text.length : text.indexOf(' ', pos) + 1, target = text.slice(pos, end);
  const ok = target.startsWith(word), typed = pos + (ok ? word.length : 0);
  useEffect(() => { if (play) field.current?.focus(); }, [play]);
  useEffect(() => { if (play && ok) steer({ p: typed }); }, [typed]);
  useEffect(() => { // cars move from the live frames without re-rendering the page
    let raf;
    const loop = () => {
      const f = frameNow(GAP.type_race);
      if (f) lanes.current.forEach((el, i) => {
        if (!el) return;
        el.style.setProperty('--p', Math.min(1, f.p[i] / v.len));
        el.querySelector(".wpm").textContent = `${Math.round(f.w[i])} wpm`;
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const onInput = e => {
    const val = e.target.value;
    if (val === target || (end === text.length && val === target)) { setPos(end); setWord(''); e.target.value = ''; feel('tap', 6); return; }
    setWord(val);
  };
  const order = Object.keys(v.fin).sort((a, b) => v.fin[a] - v.fin[b]);
  return html`<div class="race">
    <div class="track-wrap">${v.players.map((p, i) => html`<div key=${p} class="lane ${p === r.you ? 'me' : ''}" ref=${el => (lanes.current[i] = el)}>
      <span class="lane-name">${nameOf(p)}</span><span class="car" style=${`--c:${SEATS[i % 8]}`}>🏎️</span>
      <span class="wpm">0 wpm</span>${p in v.fin && html`<span class="medal">${['🥇', '🥈', '🥉'][order.indexOf(p)] ?? '🏁'}</span>`}</div>`)}</div>
    ${v.phase === 'ready' ? html`<div class="center"><div class="big-count"><${Timer} at=${v.deadline} /></div><p class="soft">Get your fingers ready…</p></div>` : null}
    ${me >= 0 && v.phase !== 'ready' && html`<p class="passage" aria-label="Passage">
      <span class="done">${text.slice(0, pos)}</span><span class="cur ${ok ? '' : 'bad'}"><span class="done">${ok ? word : ''}</span>${target.slice(ok ? word.length : 0)}</span><span class="rest">${text.slice(end)}</span></p>
      ${play ? html`<input ref=${field} class="type-in ${ok ? '' : 'bad'}" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Type the highlighted word"
          placeholder="Type the highlighted word…" onInput=${onInput} onPaste=${e => e.preventDefault()} />`
        : r.you in v.fin ? html`<p class="soft">🏁 Finished in ${(v.fin[r.you] / 1000).toFixed(1)} s</p>` : null}`}
    ${v.phase === 'over' && html`<p class="soft">Race over!</p>`}
  </div>`;
}

// ── TV: a laptop or TV shows the room big; phones stay the controllers ──
function TvHome() {
  const [code, setCode] = useState('');
  return html`<main class="home">
    <header class="hero">${LOGO}<h1 class="logo">Back<span>Bench</span> TV</h1>
      <p class="tagline">Put the room on a big screen. Everyone plays on their phone.</p></header>
    <form class="panel" onSubmit=${e => { e.preventDefault(); code.length === 4 && enter(code); }}>
      <h3>Room code to show</h3>
      <div class="row"><input class="code" value=${code} maxlength="4" placeholder="CODE" aria-label="Room code" autocapitalize="characters" autocomplete="off"
        onInput=${e => { const v = e.target.value.toUpperCase().replace(/[^A-HJ-NP-Z]/g, ''); e.target.value = v; setCode(v); }} />
      <button class="btn primary" disabled=${code.length !== 4}>Show</button></div></form>
    <a class="link center-text" href="/">← Play on this device instead</a>
  </main>`;
}
function TvLobby({ r }) {
  const sel = r.games.find(g => g.id === r.gameId);
  return html`<main class="tv-lobby">
    <section class="panel tv-join">
      <p class="muted">Join on your phone at <b class="mono">${location.host}</b></p>
      <div class="code-tiles huge" aria-label=${`Room code ${r.code}`}>${[...r.code].map((c, i) => html`<span key=${i}>${c}</span>`)}</div>
      <${QRImg} link=${`${location.origin}/r/${r.code}`} />
      <p class="small muted">or scan to jump straight in</p>
    </section>
    <section class="col">
      <h2>${r.players.length} player${r.players.length === 1 ? '' : 's'} on the bench</h2>
      <div class="tv-players">${r.players.map(p => html`<div key=${p.id} class="tv-p ${p.status}"><${Av} a=${p.avatar} />
        <b>${p.name}${p.id === r.hostId ? ' 👑' : ''}</b>${!p.bot && html`<span class="lv">Lv ${p.lv}</span>`}<span class="muted">${p.score}</span></div>`)}</div>
      <div class="panel"><span class="small muted">Up next</span><h2 class="title">${sel.icon} ${sel.name}</h2><p class="muted">${sel.desc}</p></div>
      ${r.crew && html`<p class="muted">🏆 Playing for <b>${r.crew.name}</b></p>`}
    </section>
  </main>`;
}

// ── profile: XP, levels and badges, kept on this device ──
const ACH = [
  ['first_win', '🥇', 'First win', 'Win any game'],
  ['streak3', '🔥', 'Hat-trick', 'Win 3 games in a row'],
  ['games10', '🎮', 'Regular', 'Play 10 games'],
  ['games50', '🏅', 'Veteran', 'Play 50 games'],
  ['explorer', '🧭', 'Explorer', 'Play 10 different games'],
  ['all', '🌈', 'Completionist', 'Play every game'],
  ['chess_bot', '♟️', 'Grandmaster', 'Beat a computer at chess'],
  ['live_win', '⚡', 'Quick hands', 'Win a live game'],
  ['crowd', '🎉', 'Party animal', 'Play a game with 6+ players'],
  ['crew', '🏆', 'Crew member', 'Play a game for a crew'],
  ['night', '🌙', 'Night owl', 'Finish a Game Night'],
  ['night_champ', '👑', 'Ruler of the night', 'Win a Game Night'],
];
const prof = () => {
  const d = { xp: 0, games: 0, wins: 0, streak: 0, best: 0, by: {}, names: {}, ach: [], seen: [] };
  try { return { ...d, ...JSON.parse(get('prof', '{}')) }; } catch { return d; }
};
const lvOf = xp => Math.floor(Math.sqrt(xp / 40)) + 1; // level L starts at 40·(L−1)² XP
const xpSpan = L => [40 * (L - 1) ** 2, 40 * L ** 2];
const saveProf = (p, before, gain, fresh) => {
  put('prof', JSON.stringify(p));
  if (lvOf(p.xp) !== before) send('set_lv', { lv: lvOf(p.xp) });
  return { gain, before, after: lvOf(p.xp), fresh, xp: p.xp };
};
function record(r) { // once per finished game (results can re-render or reload)
  const res = r.result, me = r.you, p = prof();
  if (!(me in res.points) || p.seen.includes(res.at)) return null;
  p.seen = [...p.seen, res.at].slice(-40);
  const won = res.winnerIds.includes(me), n = Object.keys(res.points).length, g = r.games.find(x => x.id === res.gameId);
  const place = Object.values(res.points).filter(x => x > res.points[me]).length, before = lvOf(p.xp);
  const gain = 20 + (won ? 30 : 0) + Math.max(0, 3 - place) * 5 + (n >= 4 ? 10 : 0);
  p.xp += gain; p.games++;
  if (won) { p.wins++; p.streak++; p.best = Math.max(p.best, p.streak); } else p.streak = 0;
  const by = (p.by[res.gameId] ||= [0, 0]);
  by[0]++; by[1] += won ? 1 : 0;
  p.names[res.gameId] = `${g.icon} ${g.name}`;
  const fresh = [];
  const unlock = (ok, id) => ok && !p.ach.includes(id) && p.ach.push(id) && fresh.push(id);
  unlock(won, 'first_win'); unlock(p.streak >= 3, 'streak3'); unlock(p.games >= 10, 'games10'); unlock(p.games >= 50, 'games50');
  unlock(Object.keys(p.by).length >= 10, 'explorer'); unlock(r.games.every(x => p.by[x.id]), 'all');
  unlock(won && res.gameId === 'chess' && Object.keys(res.points).some(id => P(id)?.bot), 'chess_bot');
  unlock(won && g.live, 'live_win'); unlock(n >= 6, 'crowd'); unlock(!!r.crew, 'crew');
  return saveProf(p, before, gain, fresh);
}
function recordNight(r, champs) {
  const p = prof(), key = `n${r.night.at}`, champ = champs.includes(r.you);
  if (!(r.you in r.night.pts) || p.seen.includes(key)) return null;
  p.seen = [...p.seen, key].slice(-40);
  const before = lvOf(p.xp), gain = champ ? 120 : 50, fresh = [];
  p.xp += gain;
  for (const id of champ ? ['night', 'night_champ'] : ['night']) if (!p.ach.includes(id)) { p.ach.push(id); fresh.push(id); }
  return saveProf(p, before, gain, fresh);
}
function XpGain({ rec }) {
  const [lo, hi] = xpSpan(rec.after);
  useEffect(() => { if (rec.after > rec.before || rec.fresh.length) feel('win', 30); }, []);
  return html`<div class="panel xp">
    <div class="xp-head"><b>+${rec.gain} XP</b>${rec.after > rec.before ? html`<b class="up">Level up! Lv ${rec.after}</b>` : html`<span class="small muted">Lv ${rec.after} · ${hi - rec.xp} XP to go</span>`}</div>
    <div class="xpbar"><i style=${`width:${Math.round((100 * (rec.xp - lo)) / (hi - lo))}%`} /></div>
    ${rec.fresh.map(id => { const a = ACH.find(x => x[0] === id); return html`<div key=${id} class="unlock">${a[1]} Badge unlocked: <b>${a[2]}</b></div>`; })}
  </div>`;
}
function Profile() {
  const p = prof(), L = lvOf(p.xp), [lo, hi] = xpSpan(L);
  const fav = Object.entries(p.by).sort((a, b) => b[1][0] - a[1][0])[0];
  return html`<main>
    <button class="link back" onClick=${() => up({ screen: null })}>← Home</button>
    <div class="prof-head"><${Av} a=${S.av} /><div><h1 class="title">${S.name || 'You'}</h1><div class="muted">Level ${L} · ${p.xp} XP</div></div></div>
    <div class="xpbar"><i style=${`width:${Math.round((100 * (p.xp - lo)) / (hi - lo))}%`} /></div>
    <p class="small muted">${hi - p.xp} XP to level ${L + 1}. Every game gives XP; wins, podiums and bigger rooms give more.</p>
    <div class="stats">${[['Games', p.games], ['Wins', p.wins], ['Win rate', p.games ? `${Math.round((100 * p.wins) / p.games)}%` : '–'], ['Best streak', p.best]].map(([k, v]) => html`
      <div key=${k}><b>${v}</b><span class="small muted">${k}</span></div>`)}</div>
    ${fav && html`<p class="soft">Most played: ${p.names[fav[0]] ?? fav[0]} · ${fav[1][0]} game${fav[1][0] === 1 ? '' : 's'}, ${fav[1][1]} win${fav[1][1] === 1 ? '' : 's'}</p>`}
    <h3>Badges · ${p.ach.length}/${ACH.length}</h3>
    <div class="badges">${ACH.map(([id, icon, name, how]) => html`<div key=${id} class="badge ${p.ach.includes(id) ? '' : 'locked'}">
      <span class="bicon">${icon}</span><b>${name}</b><span class="small muted">${how}</span></div>`)}</div>
    <button class="btn primary big" onClick=${shareCard}>Share my card</button>
    <p class="small muted center-text">Your progress lives on this device only. No account needed.</p>
  </main>`;
}
async function shareCard() {
  const p = prof(), L = lvOf(p.xp), cv = document.createElement('canvas'), x = cv.getContext('2d'), W = (cv.width = 1080), H = (cv.height = 1350);
  await document.fonts?.load('800 80px "Bricolage Grotesque"').catch(() => {});
  const bg = x.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#2b1f63'); bg.addColorStop(1, '#0b0d12');
  x.fillStyle = bg; x.fillRect(0, 0, W, H);
  x.textAlign = 'center'; x.fillStyle = '#ffd23f'; x.font = '800 64px "Bricolage Grotesque", system-ui'; x.fillText('BackBench', W / 2, 130);
  x.fillStyle = COLORS[Math.floor(S.av / 20) % 8]; x.beginPath(); x.arc(W / 2, 330, 120, 0, 7); x.fill();
  x.font = '130px system-ui'; x.textBaseline = 'middle'; x.fillText(EMOJI[S.av % 20], W / 2, 340); x.textBaseline = 'alphabetic';
  x.fillStyle = '#fff'; x.font = '800 92px "Bricolage Grotesque", system-ui'; x.fillText(S.name || 'Player', W / 2, 560);
  x.fillStyle = '#ffd23f'; x.font = '800 56px "Bricolage Grotesque", system-ui'; x.fillText(`Level ${L}`, W / 2, 640);
  [['Games', p.games], ['Wins', p.wins], ['Best streak', p.best]].forEach(([k, v], i) => {
    const cx = W / 2 + (i - 1) * 300;
    x.fillStyle = '#fff'; x.font = '800 84px "Bricolage Grotesque", system-ui'; x.fillText(String(v), cx, 800);
    x.fillStyle = '#8e96aa'; x.font = '600 34px system-ui'; x.fillText(k, cx, 850);
  });
  x.font = '72px system-ui';
  const got = ACH.filter(a => p.ach.includes(a[0]));
  got.forEach((a, i) => x.fillText(a[1], W / 2 + ((i % 6) - (Math.min(6, got.length) - 1) / 2) * 120, 1010 + Math.floor(i / 6) * 110));
  x.fillStyle = '#8e96aa'; x.font = '600 34px system-ui'; x.fillText(`${location.host} · party games for the last row`, W / 2, H - 60);
  const blob = await new Promise(res => cv.toBlob(res, 'image/png')), file = new File([blob], 'backbench-card.png', { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], text: `I'm level ${L} on BackBench 🎮` }).catch(() => {});
  else { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
}

// ── crews ──
const myCrews = () => { try { return JSON.parse(get('crews', '[]')); } catch { return []; } };
const saveCrew = c => put('crews', JSON.stringify([c, ...myCrews().filter(x => x.code !== c.code)].slice(0, 10)));
function Crews() {
  const [list, setList] = useState(myCrews()), [name, setName] = useState(''), [code, setCode] = useState('');
  if (S.crew) return html`<${CrewBoard} code=${S.crew} onBack=${() => { setList(myCrews()); up({ crew: null }); }} />`;
  const create = async () => {
    const res = await fetch('/api/crews', { method: 'POST', body: JSON.stringify({ name }) }).then(x => x.json()).catch(() => ({}));
    if (!res.code) return toast(res.error || 'Could not create the crew');
    saveCrew(res); up({ crew: res.code });
  };
  return html`<main>
    <button class="link back" onClick=${() => up({ screen: null })}>← Home</button>
    <div><h1 class="title">Crews</h1><p class="muted">Your friend group's permanent leaderboard. Link a crew to a room and every game counts.</p></div>
    ${list.length > 0 && html`<div class="group"><h3>Your crews</h3>${list.map(c => html`<button key=${c.code} class="crew-row" onClick=${() => up({ crew: c.code })}>
      <span class="crest">🏆</span><b>${c.name}</b><span class="mono muted">${c.code}</span></button>`)}</div>`}
    <div class="panel"><h3>Start a crew</h3>
      <form class="row" onSubmit=${e => { e.preventDefault(); name.trim() && create(); }}>
        <input value=${name} maxlength="24" placeholder="Crew name" aria-label="Crew name" onInput=${e => setName(e.target.value)} />
        <button class="btn primary">Create</button></form></div>
    <div class="panel"><h3>Got a crew code?</h3>
      <form class="row" onSubmit=${e => { e.preventDefault(); code.length === 6 && up({ crew: code }); }}>
        <input class="code" value=${code} maxlength="6" placeholder="CREWCD" aria-label="Crew code" autocapitalize="characters"
          onInput=${e => { const x = e.target.value.toUpperCase().replace(/[^A-HJ-NP-Z]/g, ''); e.target.value = x; setCode(x); }} />
        <button class="btn" disabled=${code.length !== 6}>Open</button></form></div>
  </main>`;
}
function CrewBoard({ code, onBack, modal }) {
  const [info, setInfo] = useState(null), [tab, setTab] = useState('weekly');
  useEffect(() => {
    fetch(`/api/crews/${code}`).then(x => x.json()).then(i => { setInfo(i); if (i.exists) saveCrew({ code, name: i.name }); }).catch(() => setInfo({ exists: false }));
  }, [code]);
  const body = !info ? html`<p class="muted">Loading…</p>` : !info.exists ? html`<p class="soft">Crew ${code} not found</p>` : html`
    <div class="room-head"><div><div class="small muted">Crew · <span class="mono">${code}</span></div><h1 class="title">${info.name}</h1></div>
      <button class="btn" onClick=${() => shareText(`Join our BackBench crew "${info.name}" 🏆 code ${code} → ${location.origin}`)}>Share</button></div>
    <div class="tabs" role="tablist">${[['weekly', 'This week'], ['allTime', 'All time'], ['history', 'History']].map(([k, l]) => html`
      <button key=${k} role="tab" aria-selected=${tab === k} class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${l}</button>`)}</div>
    ${tab === 'history' ? (info.history.length ? html`<ul class="rows">${info.history.map((h, i) => {
        const top = Object.entries(h.players).sort((x, y) => y[1].points - x[1].points)[0];
        return html`<li key=${i}><span class="pname"><b>${h.game}</b><br /><span class="small muted">${new Date(h.ended).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} · ${Object.keys(h.players).length} played</span></span>
          <span class="small">🥇 ${top[1].name}</span></li>`;
      })}</ul>` : html`<p class="soft">No games yet. Link this crew in a room's lobby.</p>`)
      : info[tab].length ? html`<ol class="rows">${info[tab].map((p, i) => html`<li key=${p.pid}>
          <span class="rank">${['🥇', '🥈', '🥉'][i] ?? i + 1}</span><${Av} a=${p.avatar} />
          <span class="pname">${p.name}${p.pid === info.champion && tab === 'weekly' ? ' 🏆' : ''}<br /><span class="small muted">${p.wins} win${p.wins === 1 ? "" : "s"} · ${p.games} game${p.games === 1 ? "" : "s"}</span></span>
          <span class="pts">${p.points}</span></li>`)}</ol>`
      : html`<p class="soft">${tab === 'weekly' ? 'Nobody has played this week yet. Resets Monday 00:00 IST.' : 'No games yet.'}</p>`}`;
  return modal ? html`<div class="modal" onClick=${e => e.target === e.currentTarget && onBack()}><div class="sheet tall">${body}<button class="btn" onClick=${onBack}>Close</button></div></div>`
    : html`<main><button class="link back" onClick=${onBack}>← Crews</button>${body}</main>`;
}
function CrewLink({ onClose }) {
  const [code, setCode] = useState('');
  const link = c => { send('set_crew', { code: c }); onClose(); };
  return html`<div class="modal" onClick=${e => e.target === e.currentTarget && onClose()}><div class="sheet">
    <h2>Play for a crew</h2><p class="muted small">Every finished game in this room goes on the crew's leaderboard.</p>
    ${myCrews().map(c => html`<button key=${c.code} class="crew-row" onClick=${() => link(c.code)}><span class="crest">🏆</span><b>${c.name}</b><span class="mono muted">${c.code}</span></button>`)}
    <form class="row" onSubmit=${e => { e.preventDefault(); code.length === 6 && link(code); }}>
      <input class="code" value=${code} maxlength="6" placeholder="CREWCD" aria-label="Crew code"
        onInput=${e => { const x = e.target.value.toUpperCase().replace(/[^A-HJ-NP-Z]/g, ''); e.target.value = x; setCode(x); }} />
      <button class="btn primary" disabled=${code.length !== 6}>Link</button></form>
    <p class="small muted">No crew yet? Create one from the home screen.</p>
    <button class="btn" onClick=${onClose}>Cancel</button></div></div>`;
}

// ── QR (generator loaded only when opened) ──
function QRImg({ link }) {
  const [src, setSrc] = useState(null);
  useEffect(() => { import('/vendor/uqr.js').then(({ renderSVG }) => setSrc(`data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(link, { border: 2 }))}`)); }, [link]);
  return html`<div class="qr">${src ? html`<img src=${src} alt=${`QR code for ${link}`} />` : 'Loading…'}</div>`;
}
function QR({ onClose }) {
  return html`<div class="modal" onClick=${e => e.target === e.currentTarget && onClose()}><div class="sheet center-sheet">
    <h2>Scan to join</h2>
    <${QRImg} link=${`${location.origin}/r/${S.room.code}`} />
    <div class="code-tiles">${[...S.room.code].map((c, i) => html`<span key=${i}>${c}</span>`)}</div>
    <button class="btn" onClick=${onClose}>Done</button></div></div>`;
}

// ── feel: confetti, optional sounds ──
let actx;
const NOTES = { tap: [880], turn: [523, 784], go: [988], win: [523, 659, 784, 1047], end: [440, 392], drop: [196], goal: [659, 880] };
function sfx(k) {
  if (!S.sound || !NOTES[k]) return;
  try {
    actx ||= new AudioContext();
    NOTES[k].forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + i * 0.09;
      o.type = 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 0.18);
    });
  } catch {}
}
const feel = (k, ms = 40) => { buzz(ms); sfx(k); };
function confetti() {
  import('/vendor/confetti.js').then(({ default: fire }) => {
    const base = { disableForReducedMotion: true, zIndex: 60, colors: ['#ffd23f', '#38bdf8', '#f472b6', '#34d399', '#a78bfa', '#fb923c'], particleCount: 90, spread: 70, startVelocity: 55 };
    fire({ ...base, angle: 60, origin: { x: 0, y: 0.8 } });
    fire({ ...base, angle: 120, origin: { x: 1, y: 0.8 } });
    setTimeout(() => fire({ ...base, particleCount: 60, spread: 120, origin: { x: 0.5, y: 0.35 } }), 250);
  }).catch(() => {});
}
// smooth add/remove/reorder for lists (lazy-loaded, 3 KB)
const useAuto = () => {
  const ref = useRef();
  useEffect(() => { if (ref.current) import('/vendor/auto-animate.js').then(m => m.default(ref.current, { duration: 320 })).catch(() => {}); }, []);
  return ref;
};

// ── settings & boss screen ──
function Settings() {
  const close = () => up({ settings: false });
  return html`<div class="modal" onClick=${e => e.target === e.currentTarget && close()}><div class="sheet" role="dialog" aria-label="Settings">
    <h2>Settings</h2>
    <label class="setting">Theme
      <select value=${S.theme} onChange=${e => { put('theme', e.target.value); document.documentElement.dataset.theme = e.target.value; up({ theme: e.target.value }); }}>
        <option value="dark">Dark</option><option value="dim">Dim (class mode)</option><option value="light">Light</option>
      </select></label>
    <label class="setting"><input type="checkbox" checked=${S.haptics} onChange=${e => { put('haptics', e.target.checked ? 1 : 0); up({ haptics: e.target.checked }); }} /> Vibration</label>
    <label class="setting"><input type="checkbox" checked=${S.sound} onChange=${e => { put('sound', e.target.checked ? 1 : 0); up({ sound: e.target.checked }); e.target.checked && sfx('turn'); }} /> Sound effects</label>
    ${S.install ? html`<button class="btn" onClick=${install}>📲 Install BackBench</button>`
      : /iPhone|iPad/.test(navigator.userAgent) && !navigator.standalone && html`<p class="small muted">📲 To install: tap Share → Add to Home Screen.</p>`}
    <p class="small muted">Sound is off by default. Tap 📖, two-finger tap or press Esc to hide the game behind lecture notes; triple-tap the notes title (or Esc) to come back. On a laptop, Space taps in Tap Duel.</p>
    <p class="small muted"><b>Privacy:</b> no accounts, emails or trackers. Your nickname and a random ID live on your phone. Rooms — including drawings and clues — are deleted within 3 hours.</p>
    <button class="btn" onClick=${close}>Done</button>
  </div></div>`;
}
function Boss() {
  const taps = useRef([]);
  const tap = () => {
    const t = Date.now();
    taps.current = [...taps.current.filter(x => t - x < 800), t];
    if (taps.current.length >= 3) up({ boss: false });
  };
  return html`<article class="notes">
    <h1 onClick=${tap}>Unit 3 — Normalisation</h1>
    <p><i>DBMS · Lecture 14 · Revision notes</i></p>
    <h2>1. Why normalise?</h2>
    <p>Normalisation organises relations to reduce redundancy and avoid insertion, update and deletion anomalies. Each normal form adds a stricter condition on functional dependencies (FDs).</p>
    <h2>2. First Normal Form (1NF)</h2>
    <p>All attributes hold atomic values; no repeating groups. Example: split <code>phone_numbers</code> into one row per number.</p>
    <h2>3. Second Normal Form (2NF)</h2>
    <p>1NF + no partial dependency: every non-prime attribute depends on the <b>whole</b> candidate key.</p>
    <table><tr><th>StudentID</th><th>CourseID</th><th>CourseName</th></tr><tr><td>101</td><td>CS301</td><td>DBMS</td></tr><tr><td>102</td><td>CS301</td><td>DBMS</td></tr></table>
    <p>CourseName depends only on CourseID → move it to a Course table.</p>
    <h2>4. Third Normal Form (3NF)</h2>
    <p>2NF + no transitive dependency: for every FD X → A, X is a superkey or A is prime.</p>
    <h2>5. BCNF</h2>
    <p>For every non-trivial FD X → Y, X must be a superkey. Stricter than 3NF; decomposition may not preserve all dependencies.</p>
    <h2>6. Practice</h2>
    <p>R(A, B, C, D) with A → B, B → C, C → D. Find the highest normal form and decompose to BCNF. (Hint: candidate key is A.)</p>
    <p>Attribute closure: compute A⁺ by repeatedly applying FDs until no new attributes are added.</p>
  </article>`;
}

// ── boot: auto-rejoin after a refresh ──
document.documentElement.dataset.theme = S.theme;
document.body.classList.toggle('tv', S.tv);
const linked = location.pathname.match(/^\/(r|tv)\/([a-z]{4})$/i)?.[2].toUpperCase();
if (linked && (S.tv || (ss?.getItem('room') === linked && S.name))) enter(linked);
else draw();
