#!/usr/bin/env node
/**
 * Bonk Race — Multiplayer WebSocket Server
 *
 * Architecture:
 *   - Server-authoritative: the sim runs here, clients send inputs, server broadcasts state.
 *   - Room system: create/join rooms by code, host can configure and start the match.
 *   - Static file serving built-in (no separate server needed).
 *
 * Run:
 *   npm start          (or: node mp-server.js)
 *   PORT=3000 node mp-server.js
 *
 * Requires: ws  (npm install ws)
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');
const url  = require('url');
const crypto = require('crypto');

/* ─── load ws with a helpful error ─── */
let WebSocket, WebSocketServer;
try {
  const ws = require('ws');
  WebSocket = ws; WebSocketServer = ws.Server || ws.WebSocketServer;
} catch (e) {
  console.error('\n  Missing dependency: ws\n  Run:  npm install ws\n');
  process.exit(1);
}

/* ─── load sim.js ─── */
const Sim = require('./bonk/sim.js');

/* ─── config ─── */
const PORT = parseInt(process.env.PORT || '8000', 10);
const HOST = '0.0.0.0';
const ROOT = path.resolve(__dirname);
const TICK_RATE = 30;            // server sim ticks/sec
const STATE_EVERY = 2;           // broadcast state every Nth tick (30/2 = 15 Hz, tick-aligned)
const MAX_ROOMS  = 50;
const MAX_PLAYERS_PER_ROOM = 8;
const ROOM_CODE_LEN = 5;

/* ─── MIME types ─── */
const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.png':'image/png', '.jpg':'image/jpeg', '.gif':'image/gif', '.svg':'image/svg+xml',
  '.ico':'image/x-icon', '.wasm':'application/wasm', '.mp3':'audio/mpeg',
  '.wav':'audio/wav', '.txt':'text/plain; charset=utf-8'
};

/* ─── helpers ─── */
const r100 = v => Math.round(v * 100);  // fixed-point ×100, no toFixed string churn
const r10  = v => Math.round(v * 10);   // fixed-point ×10
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = crypto.randomBytes(ROOM_CODE_LEN);
  for (let i = 0; i < ROOM_CODE_LEN; i++) code += chars[bytes[i] % chars.length];
  return code;
}
function uid() { return crypto.randomBytes(8).toString('hex'); }

/* ═══════════════════════════════════════════════════════════════════════
   ROOM
   ═══════════════════════════════════════════════════════════════════════ */
const rooms = new Map();

class Room {
  constructor(hostClient, opts) {
    this.code = genCode();
    while (rooms.has(this.code)) this.code = genCode();
    this.hostId = hostClient.playerId;
    this.state  = 'lobby';        // lobby | countdown | racing | results
    this.clients = new Map();     // playerId → client
    this.sim    = null;
    this.seed   = (Math.random() * 1e9) | 0;
    this.tickIv = null;
    this.tickCount = 0;
    this.raceEndTimer = null;

    // host-configurable settings
    this.settings = {
      maxPlayers:  opts.maxPlayers  || 6,
      botCount:    opts.botCount    ?? 0,
      botSkill:    opts.botSkill    ?? 0.75,
      spinnerSpeed: opts.spinnerSpeed ?? 1.0,    // multiplier for spinner hazards
      crumbleHold: opts.crumbleHold ?? 1.2,      // seconds before crumble tiles fall
      bounceForce: opts.bounceForce ?? 17.5,     // bounce pad launch force
      gravity:     opts.gravity ?? 1.0,          // gravity multiplier (fun!)
    };

    this.addClient(hostClient);
    rooms.set(this.code, this);
    console.log(`[Room ${this.code}] created by ${hostClient.name}`);
  }

  /* ── client management ── */
  addClient(client) {
    client.roomCode = this.code;
    client.input = { mx: 0, mz: 0, jump: false, dive: false, fire: false };
    client.simPlayerId = -1;
    this.clients.set(client.playerId, client);
    this.broadcastLobby();
  }

  removeClient(playerId) {
    const leaving = this.clients.get(playerId);
    this.clients.delete(playerId);
    console.log(`[Room ${this.code}] player left, ${this.clients.size} remain`);

    // if a race is live, freeze the leaver as finished so their ghost
    // doesn't stand on the track
    if (leaving && this.sim && leaving.simPlayerId >= 0) {
      const p = this.sim.players[leaving.simPlayerId];
      if (p && !p.finished) { p.finished = true; p.finishT = this.sim.raceT; }
    }

    if (this.clients.size === 0) {
      this.destroy();
      return;
    }
    // transfer host
    if (playerId === this.hostId) {
      const next = this.clients.values().next().value;
      if (next) {
        this.hostId = next.playerId;
        this.send(next, { type: 'host', you: true });
        console.log(`[Room ${this.code}] host transferred to ${next.name}`);
      }
    }
    this.broadcastLobby();
  }

  destroy() {
    if (this.tickIv) clearInterval(this.tickIv);
    if (this.raceEndTimer) clearTimeout(this.raceEndTimer);
    rooms.delete(this.code);
    console.log(`[Room ${this.code}] destroyed`);
  }

  /* ── messaging ── */
  send(client, msg) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(msg));
    }
  }
  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const c of this.clients.values()) {
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(s);
    }
  }

  broadcastLobby() {
    const players = [];
    for (const c of this.clients.values()) {
      players.push({ id: c.playerId, name: c.name, kind: c.kind, isHost: c.playerId === this.hostId });
    }
    this.broadcast({
      type: 'lobby',
      code: this.code,
      state: this.state,
      hostId: this.hostId,
      settings: this.settings,
      players,
    });
  }

  /* ── settings update (host only) ── */
  updateSettings(playerId, newSettings) {
    if (playerId !== this.hostId || this.state !== 'lobby') return;
    Object.assign(this.settings, newSettings);
    this.broadcastLobby();
  }

  /* ── kick player (host only) ── */
  kickPlayer(hostId, targetId) {
    if (hostId !== this.hostId || targetId === this.hostId) return;
    const target = this.clients.get(targetId);
    if (target) {
      this.send(target, { type: 'kicked' });
      target.roomCode = null;
      this.removeClient(targetId);
    }
  }

  /* ── start the race (host only) ── */
  startRace(playerId) {
    if (playerId !== this.hostId) return;
    if (this.state !== 'lobby' && this.state !== 'results') return;

    this.seed = (Math.random() * 1e9) | 0;
    this.sim = Sim.create(this.seed);

    if (this.settings) {
      for (const s of this.sim.solids) {
        if (s.kind === 'spin' && this.settings.spinnerSpeed !== undefined) s.om *= this.settings.spinnerSpeed;
        if (s.kind === 'crumble' && this.settings.crumbleHold !== undefined) s.timer = this.settings.crumbleHold;
        if (s.bounce && this.settings.bounceForce !== undefined) s.bounce = this.settings.bounceForce;
      }
    }

    // add human players
    const KINDS = ['zombie', 'pumpkin', 'ghost', 'robot', 'gum', 'banana'];
    let slot = 0;
    for (const c of this.clients.values()) {
      const p = this.sim.addPlayer({ name: c.name, bot: false, kind: c.kind || 'zombie', skill: 0 });
      c.simPlayerId = p.id;
      slot++;
    }

    // add bots
    const botSkills = [0.6, 0.72, 0.82, 0.88, 0.66, 0.78, 0.70, 0.84];
    for (let i = 0; i < this.settings.botCount && slot < MAX_PLAYERS_PER_ROOM; i++, slot++) {
      const kind = KINDS[(slot + i) % KINDS.length];
      this.sim.addPlayer({
        name: 'Bot ' + (i + 1),
        bot: true,
        kind,
        skill: this.settings.botSkill * (0.85 + Math.random() * 0.3),
      });
    }

    // the sim runs all bots internally, we set humanId to -1
    this.sim.humanId = -1;

    this.sim.begin();
    this.state = 'countdown';

    // tell each client their sim player id and the initial roster
    const roster = this.sim.players.map(p => ({
      id: p.id, name: p.name, kind: p.kind, bot: p.bot
    }));
    for (const c of this.clients.values()) {
      this.send(c, {
        type: 'raceStart',
        seed: this.seed,
        you: c.simPlayerId,
        roster,
        settings: this.settings,
      });
    }

    // start ticking — state is broadcast from inside tick() every STATE_EVERY-th
    // tick, so packets are always exactly N sim ticks apart (client can interpolate)
    if (this.tickIv) clearInterval(this.tickIv);
    this.tickCount = 0;

    const tickDt = 1 / TICK_RATE;
    this.tickIv = setInterval(() => this.tick(tickDt), tickDt * 1000);

    console.log(`[Room ${this.code}] race started with ${this.sim.players.length} players (${this.clients.size} human, ${this.settings.botCount} bots)`);
  }

  /* ── sim tick ── */
  tick(dt) {
    if (!this.sim || (this.state !== 'countdown' && this.state !== 'racing')) return;

    // apply per-player inputs
    for (const c of this.clients.values()) {
      const p = this.sim.players[c.simPlayerId];
      if (p && !p.bot) p._mpInput = c.input;
    }

    // we call S.step with null human input since we handle per-player input via _mpInput in sim.js
    this.sim.step(dt, null);

    // update phase tracking
    if (this.sim.phase === 'race' && this.state === 'countdown') {
      this.state = 'racing';
    }

    // clear one-shot inputs
    for (const c of this.clients.values()) {
      c.input.jump = false;
      c.input.dive = false;
    }

    // drain events — relay discrete events (bonk/fall/finish/fire/...) to the
    // other clients so their effects play. Each client's local sim already fires
    // its own + the bots' events, so the client filters these to other humans.
    const evs = this.sim.ev.splice(0);
    if (evs.length) {
      // events carry full-precision floats; clients only place effects at x/y/z,
      // so quantize before the wire (2 decimals is sub-pixel at game scale)
      for (const e of evs) { e.x = Math.round(e.x * 100) / 100; e.y = Math.round(e.y * 100) / 100; e.z = Math.round(e.z * 100) / 100; }
      this.broadcast({ type: 'events', events: evs });
    }

    // check for race end
    if (this.state === 'racing') {
      const allFinished = this.sim.players.every(p => p.finished);
      const humansDone = [...this.clients.values()].every(c => {
        const p = this.sim.players[c.simPlayerId];
        return p && p.finished;
      });

      if (allFinished || humansDone) {
        if (!this.raceEndTimer) {
          this.raceEndTimer = setTimeout(() => this.endRace(), 3000);
        }
      }
    }

    // aligned state broadcast (see startRace): fresh post-tick state, fixed spacing
    if (++this.tickCount % STATE_EVERY === 0) this.broadcastState();
  }

  /*
   * Compact fixed-point state payload (P2): keyless positional arrays, integer
   * scaling instead of toFixed — ~half the bytes of the old per-field objects and
   * no per-field string allocation at 15 Hz. decodeState() in sim-race-webgl.html
   * (and in the tests) reverses it.
   *
   *   t        sim time, ms (×1000)
   *   raceT/cd/finishT  centiseconds (×100)
   *   pl[i]    index = player id:
   *            [x,y,z ×100, vx,vy,vz ×10, yaw ×100, ground,
   *             stun,diveT,dead,protect ×100, ammo, cp, finished(0/1),
   *             finishT ×100, place, falls, bonks]
   *   tl[i]    crumble solid: [id, state, cy ×100, active(0/1)]
   *   bl[i]    bullet: [id, x,y,z ×100, vx,vz ×10, owner]
   *   pk[i]    pickup on (0/1)
   */
  broadcastState() {
    if (!this.sim) return;
    const S = this.sim;
    const pl = [];
    for (const p of S.players) pl.push([
      r100(p.x), r100(p.y), r100(p.z), r10(p.vx), r10(p.vy), r10(p.vz), r100(p.yaw),
      p.ground ? p.ground.id : -1,
      r100(p.stun), r100(p.diveT), r100(p.dead), r100(p.protect),
      p.ammo, p.cp, p.finished ? 1 : 0, p.finished ? r100(p.finishT) : 0,
      p.place, p.falls, p.bonks,
    ]);
    const tl = [];
    for (const s of S.solids) if (s.kind === 'crumble')
      tl.push([s.id, s.state, r100(s.cy), s.active ? 1 : 0]);
    const bl = [];
    for (const b of S.bullets) bl.push([b.id, r100(b.x), r100(b.y), r100(b.z), r10(b.vx), r10(b.vz), b.owner]);

    this.broadcast({
      type: 'state',
      t: Math.round(S.t * 1000),
      raceT: r100(S.raceT),
      phase: S.phase,
      cd: r100(S.cd),
      finishCount: S.finishCount,
      pl, tl, bl,
      pk: S.pickups.map(k => k.on ? 1 : 0),
    });
  }

  endRace() {
    this.state = 'results';
    if (this.tickIv) { clearInterval(this.tickIv); this.tickIv = null; }
    this.raceEndTimer = null;

    const ranking = this.sim.ranking().map((p, i) => ({
      rank: i + 1, id: p.id, name: p.name, kind: p.kind, bot: p.bot,
      finished: p.finished, finishT: p.finished ? +p.finishT.toFixed(2) : 0,
      falls: p.falls, bonks: p.bonks,
    }));

    this.broadcast({ type: 'raceEnd', ranking });
    this.broadcastLobby(); // lobby UI: show results state + re-enable host settings
    console.log(`[Room ${this.code}] race ended`);
  }

  handleInput(playerId, input) {
    const c = this.clients.get(playerId);
    if (!c || c.simPlayerId < 0) return;

    const p = this.sim && this.sim.players[c.simPlayerId];
    if (!p || p.bot) return;

    // update continuous input
    c.input.mx = typeof input.mx === 'number' ? Math.max(-1, Math.min(1, input.mx)) : 0;
    c.input.mz = typeof input.mz === 'number' ? Math.max(-1, Math.min(1, input.mz)) : 0;
    // one-shot flags accumulate until consumed
    if (input.jump) c.input.jump = true;
    if (input.dive) c.input.dive = true;
    c.input.fire = !!input.fire;
  }
}




/* ═══════════════════════════════════════════════════════════════════════
   HTTP STATIC SERVER
   ═══════════════════════════════════════════════════════════════════════ */
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // REST API: list rooms
  if (req.url === '/api/rooms') {
    const list = [];
    for (const [code, room] of rooms) {
      list.push({
        code, state: room.state,
        playerCount: room.clients.size,
        maxPlayers: room.settings.maxPlayers,
        hostName: (() => { for (const c of room.clients.values()) if (c.playerId === room.hostId) return c.name; return '?'; })(),
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  let pathname = decodeURIComponent(url.parse(req.url).pathname);
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  const filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('403'); return; }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h2>404</h2><p>${pathname} not found</p><p><a href="/">Home</a></p>`);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': stats.size });
    fs.createReadStream(filePath).pipe(res);
  });
});


/* ═══════════════════════════════════════════════════════════════════════
   WEBSOCKET SERVER
   ═══════════════════════════════════════════════════════════════════════ */
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  const client = {
    ws,
    playerId: uid(),
    name: 'Player',
    kind: 'zombie',
    roomCode: null,
    input: { mx: 0, mz: 0, jump: false, dive: false, fire: false },
    simPlayerId: -1,
  };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      /* ── identity ── */
      case 'setName':
        client.name = String(msg.name || 'Player').slice(0, 20);
        client.kind = msg.kind || 'zombie';
        ws.send(JSON.stringify({ type: 'welcome', playerId: client.playerId, name: client.name }));
        break;

      /* ── create room ── */
      case 'create':
        if (client.roomCode) break; // already in a room
        if (rooms.size >= MAX_ROOMS) {
          ws.send(JSON.stringify({ type: 'error', msg: 'Server is full, try again later.' }));
          break;
        }
        const room = new Room(client, msg.settings || {});
        ws.send(JSON.stringify({ type: 'joined', code: room.code, you: client.playerId, isHost: true }));
        break;

      /* ── join room ── */
      case 'join': {
        if (client.roomCode) break;
        const code = String(msg.code || '').toUpperCase().trim();
        const r = rooms.get(code);
        if (!r) { ws.send(JSON.stringify({ type: 'error', msg: `Room "${code}" not found.` })); break; }
        if (r.state !== 'lobby' && r.state !== 'results') { ws.send(JSON.stringify({ type: 'error', msg: 'Race in progress, wait for it to finish.' })); break; }
        if (r.clients.size >= r.settings.maxPlayers) { ws.send(JSON.stringify({ type: 'error', msg: 'Room is full.' })); break; }
        r.addClient(client);
        ws.send(JSON.stringify({ type: 'joined', code: r.code, you: client.playerId, isHost: false }));
        break;
      }

      /* ── leave room ── */
      case 'leave': {
        const r = rooms.get(client.roomCode);
        if (r) { r.removeClient(client.playerId); client.roomCode = null; }
        break;
      }

      /* ── host: update settings ── */
      case 'settings': {
        const r = rooms.get(client.roomCode);
        if (r) r.updateSettings(client.playerId, msg.settings || {});
        break;
      }

      /* ── host: kick player ── */
      case 'kick': {
        const r = rooms.get(client.roomCode);
        if (r) r.kickPlayer(client.playerId, msg.targetId);
        break;
      }

      /* ── host: start race ── */
      case 'start': {
        const r = rooms.get(client.roomCode);
        if (r) r.startRace(client.playerId);
        break;
      }

      /* ── player input during race ── */
      case 'input': {
        const r = rooms.get(client.roomCode);
        if (r) r.handleInput(client.playerId, msg);
        break;
      }

      /* ── RTT probe (game iframe pings through the lobby) ── */
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
        break;

      /* ── update character ── */
      case 'kind':
        client.kind = msg.kind || 'zombie';
        const kr = rooms.get(client.roomCode);
        if (kr) kr.broadcastLobby();
        break;
    }
  });

  ws.on('close', () => {
    const r = rooms.get(client.roomCode);
    if (r) r.removeClient(client.playerId);
  });
});


/* ═══════════════════════════════════════════════════════════════════════
   START
   ═══════════════════════════════════════════════════════════════════════ */
httpServer.listen(PORT, HOST, () => {
  const cs = process.env.CODESPACE_NAME;
  console.log('═'.repeat(60));
  console.log('  BONK RACE — MULTIPLAYER SERVER');
  console.log('═'.repeat(60));
  console.log(`  Local:       http://localhost:${PORT}/`);
  console.log(`  Lobby:       http://localhost:${PORT}/lobby.html`);
  console.log(`  WebSocket:   ws://localhost:${PORT}/ws`);
  if (cs) {
    console.log(`  Codespace:   https://${cs}-${PORT}.app.github.dev/`);
    console.log(`  Lobby:       https://${cs}-${PORT}.app.github.dev/lobby.html`);
  }
  console.log('═'.repeat(60));
  console.log(`  Tick rate: ${TICK_RATE}/s | State broadcast: ${TICK_RATE / STATE_EVERY}/s (every ${STATE_EVERY}nd tick)`);
  console.log(`  Max rooms: ${MAX_ROOMS} | Max players/room: ${MAX_PLAYERS_PER_ROOM}`);
  console.log('═'.repeat(60));
  console.log('');
});
