// One SQLite-backed Durable Object per crew: members, weekly/all-time scores, last 50 games.
import { DurableObject } from 'cloudflare:workers';
import { weekOf } from './games.js';

export class Crew extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS members(pid TEXT PRIMARY KEY, name TEXT, avatar INT, joined INT);
      CREATE TABLE IF NOT EXISTS results(id INTEGER PRIMARY KEY AUTOINCREMENT, game TEXT, room TEXT, ended INT, players TEXT);
      CREATE TABLE IF NOT EXISTS scores(week INT, pid TEXT, points INT, wins INT, games INT, PRIMARY KEY(week, pid));`);
  }

  meta(k) { return this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0]?.v ?? null; }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/init') {
      if (this.meta('name')) return new Response('taken', { status: 409 });
      this.sql.exec('INSERT INTO meta VALUES (?, ?), (?, ?)', 'name', await req.text(), 'code', url.searchParams.get('code'));
      return new Response('ok');
    }
    if (!this.meta('name')) return Response.json({ exists: false });
    if (url.pathname === '/result') {
      const { gameId, room, players } = await req.json(), now = Date.now(), week = weekOf(now);
      this.sql.exec('INSERT INTO results(game, room, ended, players) VALUES (?, ?, ?, ?)', gameId, room, now, JSON.stringify(players));
      this.sql.exec('DELETE FROM results WHERE id <= (SELECT id FROM results ORDER BY id DESC LIMIT 1 OFFSET 50)');
      for (const [pid, p] of Object.entries(players)) {
        this.sql.exec(`INSERT INTO members VALUES (?, ?, ?, ?) ON CONFLICT(pid) DO UPDATE SET name = excluded.name, avatar = excluded.avatar`, pid, p.name, p.avatar, now);
        this.sql.exec(`INSERT INTO scores VALUES (?, ?, ?, ?, 1) ON CONFLICT(week, pid) DO UPDATE
          SET points = points + excluded.points, wins = wins + excluded.wins, games = games + 1`, week, pid, p.points, p.win ? 1 : 0);
      }
      return Response.json({ champion: this.champion() });
    }
    return Response.json(this.info());
  }

  champion() {
    const top = this.sql.exec('SELECT pid, points FROM scores WHERE week = ? ORDER BY points DESC LIMIT 1', weekOf(Date.now())).toArray()[0];
    return top?.points > 0 ? top.pid : null;
  }

  info() {
    const board = where => this.sql.exec(`SELECT s.pid, m.name, m.avatar, SUM(s.points) AS points, SUM(s.wins) AS wins, SUM(s.games) AS games
      FROM scores s JOIN members m ON m.pid = s.pid ${where} GROUP BY s.pid ORDER BY points DESC LIMIT 50`, ...(where ? [weekOf(Date.now())] : [])).toArray();
    return {
      exists: true, name: this.meta('name'), code: this.meta('code'), champion: this.champion(),
      weekly: board('WHERE s.week = ?'), allTime: board(''),
      history: this.sql.exec('SELECT game, room, ended, players FROM results ORDER BY id DESC LIMIT 50').toArray().map(h => ({ ...h, players: JSON.parse(h.players) })),
    };
  }
}
