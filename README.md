# BackBench

Party games for friends on their phones: open link → type code → play. 31 games (14 of them real-time), computer opponents, Game Nights, a big-screen TV view, crew leaderboards, XP and badges, installable. Spec: the PRD.

One Cloudflare Worker serves both the static client and the API. Each room is a Durable Object with WebSocket hibernation, and each crew is a SQLite-backed Durable Object. The client has no build step: plain ES modules, a vendored 13 KB Preact+htm bundle, and three small libraries loaded only when needed: a QR encoder, auto-animate (list motion) and canvas-confetti.

```
src/worker.js    HTTP routes + Room Durable Object (join, reconnect, host controls, timers, bots, crew posting)
src/crew.js      Crew Durable Object (SQLite): members, weekly/all-time scores, last 50 games
src/games.js     party games: Tap Duel, Imposter Word, Doodle Telephone, Who Said It?, Pass the Bomb, Emoji Decode
src/classics.js  Chess (rules via chess.js + a small 2-ply engine), Four in a Row, Tic-Tac-Toe, Dots & Boxes, Minesweeper
src/cards.js     Bluff and Color Clash (hidden hands, computer players)
src/arcade.js    touch-physics sports: Keepy Uppy, Penalty Shootout, Bin Toss, Sweet Spot
src/live.js      real-time games simulated on the server: Air Hockey, Sumo Bumpers, Snake Battle, Land Grab, Paint Grab, Kickabout, Type Race
src/live2.js     more real-time games: King of the Hill, Bumper Tag, Coin Rush, Light Trails, Red Light Green Light, Tug of War
src/content.js   word pairs, prompts, categories, emoji puzzles, Type Race passages, clean filter
public/          index.html (all styles), app.js (whole client), sw.js (offline shell), manifest, icons, self-hosted font
test/            node --test unit tests for game logic, bots and scoring
```

```bash
npm install      # also copies preact+htm and uqr into public/vendor
npm run dev      # http://localhost:8787
npm test
npm run deploy   # needs `npx wrangler login` once
```

Real-time games set `rt` (ticks per second) and add `tick(ctx, state, dt)` and `frame(state)`. While one runs, the room ticks it and sends each frame to every socket. Player input only changes steering, which costs no snapshot and no storage write. The game sets `state.dirty` when something worth a snapshot happens, such as a goal or a knock-out. Bots in those games steer inside `tick()` using `ctx.bots`.

Other modes:
- **Game Night:** the host queues 2–10 games. They run back to back, and each game awards placement points (10/7/5/3/1).
- **TV view:** open `/tv/CODE` on a laptop or TV. It watches the room without being a player.
- **XP, levels and badges:** stored in `localStorage` on each device. Only the level number is shared with the room.

Adding a game means adding a module to `GAMES`, `CLASSICS`, `ARCADE`, `LIVE` or `LIVE2` plus a component in `public/app.js`. Give the module a `bot(ctx, state, pid)` function and computer players can join it. The lobby groups games by player count from each game's `min`/`max`.
