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
const STATE_RATE = 20;           // state broadcasts/sec
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
    this.stateIv = null;
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
    this.clients.delete(playerId);
    console.log(`[Room ${this.code}] player left, ${this.clients.size} remain`);

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
    if (this.stateIv) clearInterval(this.stateIv);
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

    // start ticking
    if (this.tickIv) clearInterval(this.tickIv);
    if (this.stateIv) clearInterval(this.stateIv);

    const tickDt = 1 / TICK_RATE;
    this.tickIv = setInterval(() => this.tick(tickDt), tickDt * 1000);
    this.stateIv = setInterval(() => this.broadcastState(), 1000 / STATE_RATE);

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

    // step the sim — we override the input routing
    const origStep = () => {
      const simDt = Math.min(dt, 1 / 20);
      const n = Math.max(1, Math.ceil(simDt / (1 / 60))), h = simDt / n;
      for (let i = 0; i < n; i++) {
        this.sim.t += h;
        if (this.sim.phase === 'countdown') {
          this.sim.cd -= h;
          if (this.sim.cd <= 0) {
            this.sim.phase = 'race';
            this.sim.raceT = 0;
            this.sim.ev.push({ t: 'go', id: -1, x: 0, y: 0, z: 0 });
            this.state = 'racing';
          }
        } else if (this.sim.phase === 'race') {
          this.sim.raceT += h;
        }
      }
    };

    // we call S.step with null human input since we handle per-player input in our patched sub
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

    // drain events
    this.sim.ev.length = 0;

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
  }

  broadcastState() {
    if (!this.sim) return;
    const S = this.sim;
    const players = S.players.map(p => ({
      id: p.id, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
      vx: +p.vx.toFixed(1), vy: +p.vy.toFixed(1), vz: +p.vz.toFixed(1),
      yaw: +p.yaw.toFixed(2),
      ground: p.ground ? p.ground.id : -1,
      stun: +p.stun.toFixed(2), diveT: +p.diveT.toFixed(2), dead: +p.dead.toFixed(2),
      protect: +p.protect.toFixed(2), ammo: p.ammo, cp: p.cp,
      finished: p.finished, finishT: p.finished ? +p.finishT.toFixed(2) : 0,
      place: p.place, falls: p.falls, bonks: p.bonks,
    }));

    // crumble tile states
    const tiles = [];
    for (const s of S.solids) {
      if (s.kind === 'crumble') {
        tiles.push({ id: s.id, state: s.state, cy: +s.cy.toFixed(2), active: s.active });
      }
    }

    this.broadcast({
      type: 'state',
      t: +S.t.toFixed(3),
      raceT: +S.raceT.toFixed(2),
      phase: S.phase,
      cd: +S.cd.toFixed(2),
      finishCount: S.finishCount,
      players,
      tiles,
      bullets: S.bullets.map(b => ({
        x: +b.x.toFixed(2), y: +b.y.toFixed(2), z: +b.z.toFixed(2),
        vx: +b.vx.toFixed(1), vz: +b.vz.toFixed(1), owner: b.owner,
      })),
      pickups: S.pickups.map(k => ({ on: k.on })),
    });
  }

  endRace() {
    this.state = 'results';
    if (this.tickIv) { clearInterval(this.tickIv); this.tickIv = null; }
    if (this.stateIv) { clearInterval(this.stateIv); this.stateIv = null; }
    this.raceEndTimer = null;

    const ranking = this.sim.ranking().map((p, i) => ({
      rank: i + 1, id: p.id, name: p.name, kind: p.kind, bot: p.bot,
      finished: p.finished, finishT: p.finished ? +p.finishT.toFixed(2) : 0,
      falls: p.falls, bonks: p.bonks,
    }));

    this.broadcast({ type: 'raceEnd', ranking });
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
   PATCH sim.js to accept per-player input
   ─── monkey-patch: override how S.step resolves inputs ───
   We wrap the original step so that non-bot players use their ._mpInput
   ═══════════════════════════════════════════════════════════════════════ */
const _origCreate = Sim.create;
Sim.create = function(seed) {
  const S = _origCreate(seed);
  const origStep = S.step;

  S.step = function(dt, humanInp) {
    // In multiplayer, humanId is -1, so the original code gives all non-bots
    // the EMPTY input. We pre-set each non-bot player's custom input by
    // temporarily setting humanId to that player's id and calling sub
    // per-player. But that's complex. Instead, we make non-bot players
    // temporarily look like bot players with overridden think().
    // 
    // Simplest approach: set each non-bot player to "bot" with a think
    // function that returns their _mpInput.

    // save original bot flags
    const saved = [];
    for (const p of S.players) {
      if (!p.bot && p._mpInput) {
        saved.push({ p, origBot: p.bot, origSkill: p.skill });
        p.bot = true;
        // override the ai object's "think" output by storing input in ai
        p.ai._mpOverride = p._mpInput;
      }
    }

    origStep.call(S, dt, null);

    // restore
    for (const s of saved) {
      s.p.bot = s.origBot;
      delete s.p.ai._mpOverride;
    }
  };

  return S;
};

/* We also need to patch the bot think() function so it checks _mpOverride.
   Since think() is internal to the IIFE, we can't directly patch it.
   Instead, let's take a different approach: we'll patch S.step to route
   inputs by setting S.humanId per-player in each sub-step. */

// Actually, let's use a simpler proven approach: since sim.js line 527 does:
//   const inp = p.id === S.humanId ? humanInp : (p.bot ? think(p, dt) : EMPTY);
// We can loop over human players, calling step once per player with their id.
// But step() steps ALL players. So we need a different strategy.
//
// The cleanest approach: monkey-patch the sim to support a `playerInputs` map.

// Let's reload and re-patch properly:
delete require.cache[require.resolve('./bonk/sim.js')];

// We need to modify sim.js itself to support per-player inputs.
// For now, the server will modify the sim.js source at load time.
// This is done below in a more robust way.

/* ─── Actually, let's use the real approach: modify sim.js sub() ─── */
// We'll load sim.js raw, patch the sub() function, and eval it.

const simSource = fs.readFileSync(path.join(__dirname, 'bonk', 'sim.js'), 'utf8');

// Patch line 527 to check p._mpInput first:
// Original: const inp = p.id === S.humanId ? humanInp : (p.bot ? think(p, dt) : EMPTY);
// Patched:  const inp = p._mpInput ? p._mpInput : (p.id === S.humanId ? humanInp : (p.bot ? think(p, dt) : EMPTY));
const patchedSource = simSource.replace(
  `const inp = p.id === S.humanId ? humanInp : (p.bot ? think(p, dt) : EMPTY);`,
  `const inp = p._mpInput ? p._mpInput : (p.id === S.humanId ? humanInp : (p.bot ? think(p, dt) : EMPTY));`
);

if (patchedSource === simSource) {
  console.warn('⚠ Warning: Could not patch sim.js sub() for per-player input. Multiplayer input routing may not work.');
}

// Eval the patched sim in a sandbox
const SimPatched = (function() {
  const module = { exports: null };
  // The sim exports via: if (typeof module !== 'undefined') module.exports = Sim;
  // And also via: return { create, K: ... } at the end of the IIFE.
  const fn = new Function('module', 'exports', 'require', patchedSource + '\nmodule.exports = Sim;');
  fn(module, {}, require);
  return module.exports;
})();

// Override Sim.create to use patched version
const PatchedCreate = SimPatched.create;


/* ═══════════════════════════════════════════════════════════════════════
   Re-implement Room to use patched sim
   ═══════════════════════════════════════════════════════════════════════ */

// Override the tick to properly route inputs
Room.prototype.tick = function(dt) {
  if (!this.sim || (this.state !== 'countdown' && this.state !== 'racing')) return;

  // set per-player inputs on sim player objects
  for (const c of this.clients.values()) {
    const p = this.sim.players[c.simPlayerId];
    if (p && !p.bot) {
      p._mpInput = {
        mx: c.input.mx, mz: c.input.mz,
        jump: c.input.jump, dive: c.input.dive, fire: c.input.fire
      };
    }
  }

  // step the sim
  this.sim.step(dt, null);

  // clear one-shot inputs and _mpInput refs
  for (const c of this.clients.values()) {
    c.input.jump = false;
    c.input.dive = false;
    const p = this.sim.players[c.simPlayerId];
    if (p) p._mpInput = null;
  }

  // update phase tracking
  if (this.sim.phase === 'race' && this.state === 'countdown') {
    this.state = 'racing';
  }

  // drain events (we broadcast them)
  const events = this.sim.ev.slice();
  this.sim.ev.length = 0;
  if (events.length > 0) {
    this.broadcast({ type: 'events', events: events.map(e => ({
      t: e.t, id: e.id, x: +e.x.toFixed(2), y: +e.y.toFixed(2), z: +e.z.toFixed(2),
      ...(e.power !== undefined ? { power: +e.power.toFixed(1) } : {}),
      ...(e.by !== undefined ? { by: e.by } : {}),
      ...(e.cp !== undefined ? { cp: e.cp } : {}),
      ...(e.place !== undefined ? { place: e.place } : {}),
    }))});
  }

  // check for race end
  if (this.state === 'racing') {
    const humansDone = [...this.clients.values()].every(c => {
      const p = this.sim.players[c.simPlayerId];
      return p && p.finished;
    });
    if (humansDone && !this.raceEndTimer) {
      this.raceEndTimer = setTimeout(() => this.endRace(), 3000);
    }
  }
};

// Override startRace to use patched create
const origStartRace = Room.prototype.startRace;
Room.prototype.startRace = function(playerId) {
  if (playerId !== this.hostId) return;
  if (this.state !== 'lobby' && this.state !== 'results') return;

  this.seed = (Math.random() * 1e9) | 0;
  this.sim = PatchedCreate(this.seed);

  const KINDS = ['zombie', 'pumpkin', 'ghost', 'robot', 'gum', 'banana'];
  let slot = 0;
  for (const c of this.clients.values()) {
    const p = this.sim.addPlayer({ name: c.name, bot: false, kind: c.kind || 'zombie', skill: 0 });
    c.simPlayerId = p.id;
    slot++;
  }

  const botSkills = [0.6, 0.72, 0.82, 0.88, 0.66, 0.78, 0.70, 0.84];
  for (let i = 0; i < this.settings.botCount && slot < MAX_PLAYERS_PER_ROOM; i++, slot++) {
    const kind = KINDS[(slot + i) % KINDS.length];
    this.sim.addPlayer({
      name: 'Bot ' + (i + 1), bot: true, kind,
      skill: this.settings.botSkill * (0.85 + Math.random() * 0.3),
    });
  }

  this.sim.humanId = -1;
  this.sim.begin();
  this.state = 'countdown';

  const roster = this.sim.players.map(p => ({
    id: p.id, name: p.name, kind: p.kind, bot: p.bot
  }));
  for (const c of this.clients.values()) {
    this.send(c, {
      type: 'raceStart', seed: this.seed, you: c.simPlayerId,
      roster, settings: this.settings,
    });
  }

  if (this.tickIv) clearInterval(this.tickIv);
  if (this.stateIv) clearInterval(this.stateIv);
  if (this.raceEndTimer) { clearTimeout(this.raceEndTimer); this.raceEndTimer = null; }

  const tickDt = 1 / TICK_RATE;
  this.tickIv = setInterval(() => this.tick(tickDt), tickDt * 1000);
  this.stateIv = setInterval(() => this.broadcastState(), 1000 / STATE_RATE);

  console.log(`[Room ${this.code}] race started: ${this.sim.players.length} total (${this.clients.size} human, ${this.settings.botCount} bots)`);
};


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
  console.log(`  Tick rate: ${TICK_RATE}/s | State broadcast: ${STATE_RATE}/s`);
  console.log(`  Max rooms: ${MAX_ROOMS} | Max players/room: ${MAX_PLAYERS_PER_ROOM}`);
  console.log('═'.repeat(60));
  console.log('');
});
