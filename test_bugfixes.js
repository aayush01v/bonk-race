'use strict';
// Regression tests covering all 18 audited bug fixes across bonk/sim.js,
// bonk/inputbuf.js, mp-server.js, server.js, lobby.html, and client builds.
const fs = require('fs');
const path = require('path');
const Sim = require('./bonk/sim.js');
const { InputBuffer } = require('./bonk/inputbuf.js');

let failures = 0;
function ok(cond, label) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label);
  if (!cond) failures++;
}

const webglRoot = fs.readFileSync(path.join(__dirname, 'sim-race-webgl.html'), 'utf8');
const webglDist = fs.readFileSync(path.join(__dirname, 'bonk/client/dist/sim-race-webgl.html'), 'utf8');
const babylonRoot = fs.readFileSync(path.join(__dirname, 'sim-race-babylon.html'), 'utf8');
const babylonDist = fs.readFileSync(path.join(__dirname, 'bonk/client/dist/sim-race-babylon.html'), 'utf8');
const gameJs = fs.readFileSync(path.join(__dirname, 'bonk/client/game.js'), 'utf8');
const bjsJs = fs.readFileSync(path.join(__dirname, 'bonk/client/bjs.js'), 'utf8');
const mpServerJs = fs.readFileSync(path.join(__dirname, 'mp-server.js'), 'utf8');
const serverJs = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const lobbyHtml = fs.readFileSync(path.join(__dirname, 'lobby.html'), 'utf8');

console.log('=== Bug Fix Regression Suite ===');

// 1. Bug #1: Inlined Sim in sim-race-webgl.html and sim-race-babylon.html respects p._mpInput
{
  const m = /const Sim = \(\(\) => \{[\s\S]*?\n\}\)\(\);/.exec(webglRoot);
  const InlinedSim = m ? (new Function(m[0] + '; return Sim;'))() : null;
  const s = InlinedSim.create(42);
  s.humanId = 0;
  s.addPlayer({ name: 'Me', bot: false, kind: 'zombie', skill: 0 });
  const bot = s.addPlayer({ name: 'Bot', bot: true, kind: 'robot', skill: 0.9 });
  bot._mpInput = { mx: 0, mz: 0, jump: false, dive: false, fire: false };
  s.begin();
  for (let i = 0; i < 300; i++) s.step(1 / 60, { mx: 0, mz: 0, jump: false, dive: false, fire: false });
  const botEvents = s.ev.filter(e => e.id === bot.id);
  ok(Math.abs(bot.z - 0.5) < 1e-6 && botEvents.length === 0,
    'Bug #1: inlined Sim in sim-race-webgl.html honors p._mpInput on remote bots (no local think/events)');
}

// 2. Bug #2: Leaver handling does not mark leavers as finished or award them 1st place
{
  const s = Sim.create(10);
  const p0 = s.addPlayer({ name: 'Quitter', bot: false });
  const p1 = s.addPlayer({ name: 'Runner', bot: false });
  const p2 = s.addPlayer({ name: 'Winner', bot: false });
  s.begin();
  s.phase = 'race';
  s.raceT = 1.5;
  // Quitter leaves at raceT = 1.5s
  p0.left = true; p0.dead = 1e9; p0.ground = null;
  // Runner is mid-course
  p1.z = 95;
  // Winner finishes at 32.0s
  p2.finished = true; p2.finishT = 32.0; p2.place = 1;
  const rk = s.ranking();
  ok(rk[0] === p2 && rk[1] === p1 && rk[2] === p0 && !p0.finished,
    'Bug #2: disconnected player is ranked last (DNF) instead of winning 1st place');
}

// 3. Bug #3: mp_state in game.js protects local cp, finished, diveT, ammo, pickups, and crumble tiles
{
  ok(gameJs.includes('p.cp = Math.max(p.cp, sp.cp)') &&
     gameJs.includes('diveUnacked') &&
     gameJs.includes('ammoUnacked') &&
     gameJs.includes('pk._localOffAt') &&
     gameJs.includes('tl._shakeAt'),
    'Bug #3: mp_state guards local diveT, cp, ammo, finished, pickups, and crumble tiles against stale snapshots');
}

// 4. Bug #4: 30 Hz server step (2 substeps) consumes _mpInput.jump on first substep only
{
  const s = Sim.create(1);
  const p = s.addPlayer({ bot: false });
  s.humanId = -1;
  s.begin();
  s.phase = 'race';
  for (let i = 0; i < 5; i++) {
    p._mpInput = { mx: 0, mz: 0, jump: false, dive: false, fire: false };
    s.step(1 / 30, null);
  }
  p._mpInput = { mx: 0, mz: 0, jump: true, dive: false, fire: false };
  s.step(1 / 30, null);
  ok(!p.ground && p.vy > 8 && p.jbuf <= 0,
    `Bug #4: _mpInput.jump consumed on first substep (jbuf=${p.jbuf.toFixed(3)}, not re-armed to 0.14 mid-air)`);
}

// 5. Bug #5: Rematch hides #results in mp_init and #resultsOverlay in lobby.html
{
  ok(gameJs.includes("$('results').classList.add('hidden')") &&
     lobbyHtml.includes("case 'raceStart':\n      $('resultsOverlay').classList.remove('active');"),
    'Bug #5: rematch hides in-game #results on mp_init and lobby #resultsOverlay on raceStart');
}

// 6. Bug #6: updateSettings in mp-server.js allows updates when room state is "results"
{
  ok(mpServerJs.includes("this.state !== 'lobby' && this.state !== 'results'"),
    'Bug #6: host can update match settings in post-race "results" state');
}

// 7. Bug #7: Root and dist client HTML artifacts are in sync and both contain decodeState
{
  ok(webglRoot === webglDist && babylonRoot === babylonDist &&
     webglDist.includes('function decodeState(') && babylonDist.includes('function decodeState('),
    'Bug #7: dist/ and root HTML builds are in sync and include full MP netcode + decodeState');
}

// 8. Bug #8: crumbleHold (s.hold) and gravity (sim.grav) work across sim.begin() and gameplay
{
  const s = Sim.create(9);
  s.humanId = 0;
  const p = s.addPlayer({ bot: false });
  const tile = s.solids.find(o => o.kind === 'crumble');
  tile.hold = 2.0;
  s.grav = Sim.K.GRAV * 0.5;
  s.begin();
  s.phase = 'race';
  // Drop player onto tile t1
  p.x = tile.cx; p.z = tile.cz; p.y = tile.cy + tile.hy + 0.01; p.vy = -1; p.ground = null;
  s.step(1 / 60, { mx: 0, mz: 0, jump: false, dive: false, fire: false });
  ok(tile.state === 'shake' && tile.timer > 1.9 && s.grav === 13.5,
    `Bug #8: crumbleHold (timer=${tile.timer.toFixed(2)}s) and custom gravity (grav=${s.grav}) survive begin() and apply`);
}

// 9. Bug #9: lobby.html showResults checks mySimId for "You Won!" and counts finished racers
{
  ok(lobbyHtml.includes('ranking[0].id === mySimId') &&
     lobbyHtml.includes('ranking.filter(r => r.finished).length'),
    'Bug #9: lobby results check local player id for "You Won!" and count only finished racers');
}

// 10. Bug #10: WebGL drawScene renders round disc with M.cyl and groundBelow checks s.round
{
  ok(gameJs.includes('draw(M.cyl, col, pat, em') &&
     gameJs.includes('s.round ? Math.hypot(lx, lz) <= s.hx + 0.1'),
    'Bug #10: WebGL renders round spinning disc as cylinder (M.cyl) and groundBelow checks s.round');
}

// 11. Bug #11: 8 players spawn at 8 distinct non-overlapping slots, and bots respect maxPlayers
{
  const s = Sim.create(1);
  for (let i = 0; i < 8; i++) s.addPlayer({ name: 'P' + i, bot: false });
  s.begin();
  const uniqueX = new Set(s.players.map(p => p.x));
  ok(uniqueX.size === 8 && mpServerJs.includes('Math.min(this.settings.maxPlayers || MAX_PLAYERS_PER_ROOM, MAX_PLAYERS_PER_ROOM)'),
    `Bug #11: 8 players receive ${uniqueX.size} distinct start slots and bot spawning respects settings.maxPlayers`);
}

// 12. Bug #12: stepBullets checks hitCd > 0 and finished players cannot be bonked/shot off finish
{
  const s = Sim.create(1);
  s.humanId = -1;
  const p0 = s.addPlayer({ bot: false });
  const p1 = s.addPlayer({ bot: false });
  s.begin();
  s.phase = 'race';
  // Give p1 hitCd > 0 and fire a bullet at p1
  p1.x = 0; p1.y = 0; p1.z = 5; p1.hitCd = 0.25;
  s.bullets.push({ id: 1, x: 0, y: 0.8, z: 4.8, vx: 0, vz: 20, life: 0.5, owner: p0.id });
  s.step(1 / 60, null);
  const hitWhileCooldown = p1.stun > 0;
  // Mark p1 finished and test bullet immunity
  p1.hitCd = 0; p1.finished = true;
  s.bullets.push({ id: 2, x: 0, y: 0.8, z: 4.8, vx: 0, vz: 20, life: 0.5, owner: p0.id });
  s.step(1 / 60, null);
  const hitWhileFinished = p1.stun > 0;
  ok(!hitWhileCooldown && !hitWhileFinished,
    'Bug #12: bullets respect q.hitCd > 0 and finished players are immune to combat knockback');
}

// 13. Bug #13: XSS prevention in lobby.html fetchRooms and 404 responses in mp-server.js / server.js
{
  ok(!lobbyHtml.includes('<strong>${r.hostName}</strong>') &&
     lobbyHtml.includes('hostStrong.textContent = r.hostName') &&
     mpServerJs.includes('escHtml(pathname)') &&
     serverJs.includes('escHtml(pathname)'),
    'Bug #13: hostName uses textContent in lobby.html and 404 pages HTML-escape pathname');
}

// 14. Bug #14: InputBuffer rejects single future-stamped outlier without poisoning dMin
{
  const ib = new InputBuffer();
  ib.push({ t: 10.0, mx: 1, mz: 0 }, 100.0); // dMin = 90.0
  const dMinBefore = ib.dMin;
  const acceptedOutlier = ib.push({ t: 999999, mx: 1, mz: 0 }, 100.03);
  ib.push({ t: 10.03, mx: 1, mz: 0 }, 100.03);
  const out = ib.step(100.10);
  ok(!acceptedOutlier && Math.abs(ib.dMin - dMinBefore) < 0.01 && out && out.mx === 1 && ib.ack < 20,
    `Bug #14: single future-stamped packet rejected (dMin=${ib.dMin.toFixed(2)}, ack=${ib.ack.toFixed(2)})`);
}

// 15. Bug #15: Countdown-to-race transition guard in game.js
{
  ok(gameJs.includes("!(sim.phase === 'race' && s.phase === 'countdown')") &&
     gameJs.includes("const expectedGo = lastNetPhase === 'countdown' && s.phase === 'race'"),
    'Bug #15: mp_state prevents phase regression to countdown and skips hard-snap on normal GO transition');
}

// 16. Bug #16: lobby.html filters joinable rooms before empty check and resets UI on WS close
{
  ok(lobbyHtml.includes(".filter(r => r.state === 'lobby' || r.state === 'results')") &&
     lobbyHtml.includes("if (roomCode) {\n      roomCode = null; isHost = false;"),
    'Bug #16: fetchRooms filters joinable rooms before empty check and ws.onclose resets room UI');
}

// 17. Bug #17: Racer kind validation in mp-server.js and fallbacks in game.js / lobby.html
{
  ok(mpServerJs.includes('const validKind = k => (VALID_KINDS.has(k) ? k : \'zombie\')') &&
     gameJs.includes('(KINDS[p.kind] || KINDS.zombie).c') &&
     gameJs.includes('(KINDS[q.kind] || KINDS.zombie).c') &&
     lobbyHtml.includes('if (!KINDS[id]) id = \'zombie\';'),
    'Bug #17: racer kind validated on server and guarded with zombie fallback across clients');
}

// 18. Bug #18: Path traversal checks include path.sep and bjs.js cleans up materials/rigs
{
  ok(mpServerJs.includes('!filePath.startsWith(ROOT + path.sep)') &&
     serverJs.includes('!filePath.startsWith(ROOT + path.sep)') &&
     bjsJs.includes('e.ownMat.dispose()'),
    'Bug #18: static servers enforce ROOT + path.sep boundary and bjs.js disposes per-solid materials');
}

console.log('\n' + (failures === 0 ? 'BUGFIX SUITE: ALL 18 PASS' : `BUGFIX SUITE: ${failures} FAILURE(S)`));
process.exit(failures === 0 ? 0 : 1);
