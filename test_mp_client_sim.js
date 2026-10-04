// Client netcode logic test.
//
// Extracts the shipped MP netcode from sim-race-webgl.html (INTERP_DELAY block:
// snapBuf/lerpPair/applyNet/sendMPInput + resetNet) and runs it — unmodified —
// against a real authoritative 30 Hz sim (bonk/sim.js) that quantizes and
// delivers snapshots with one-tick latency. Verifies:
//   1. remotes track the server's interpolated position (no 15-20 Hz velocity decay)
//   2. the own player stays corrected within a small error band
//   3. remote bullets are rebuilt by id and track the server
//   4. own bullets survive the per-frame bullet rebuild when the server hasn't seen them yet
const fs = require('fs');
const path = require('path');
const Sim = require('./bonk/sim.js');

const TICK = 1 / 30, STEP = 1 / 60, N_TICKS = 450; // 15 s
let failures = 0;
const ok = (cond, label) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label);
  if (!cond) failures++;
};
// ── extract the shipped client netcode ──
const html = fs.readFileSync(path.join(__dirname, 'sim-race-webgl.html'), 'utf8');
const start = html.indexOf('const INTERP_DELAY');
const end = html.indexOf('/* ---------------- per-frame update');
if (start < 0 || end < 0 || end <= start) {
  console.error('could not locate the MP netcode section in sim-race-webgl.html');
  process.exit(1);
}
const netBlock = html.slice(start, end);

// the mp_state arrival handler, verbatim from the window 'message' branch in
// sim-race-webgl.html (minus the DOM event plumbing).
// decodeState comes from the extracted netcode block, so the test exercises the
// shipped decoder; snapNow() below emits the compact wire format.
const onStateSrc = `
function onState(raw) {
  const s = decodeState(raw);
  const now = performance.now();
  if (netStats.lastStateNow) netStats.gaps.push(now - netStats.lastStateNow);
  if (netStats.gaps.length > 60) netStats.gaps.shift();
  netStats.lastStateNow = now;
  snapBuf.push(s);
  // time-based cap: keep enough history for the adaptive delay instead of a
  // fixed packet count, so extra buffer becomes headroom under latency
  while (snapBuf.length > 2 && s.t - snapBuf[0].t > BUF_AGE) snapBuf.shift();
  // soft clock alignment: record the smoothed server/client clock offset;
  // applyNet() eases sim.t toward it instead of hard-snapping the whole scene
  const off = s.t - now / 1000;
  srvOffset = srvOffset === null ? off : srvOffset + (off - srvOffset) * 0.1;
  updateDelayTarget();
  sim.phase = s.phase; sim.cd = s.cd; sim.finishCount = s.finishCount;
  if (s.phase !== lastNetPhase) { lastNetPhase = s.phase; needHardSnapMe = true; }
  for (let i = 0; i < s.players.length; i++) {
    const p = sim.players[i], sp = s.players[i];
    if (!p || !sp) continue;
    p.stun = sp.stun; p.diveT = sp.diveT; p.dead = sp.dead; p.protect = sp.protect;
    p.ammo = sp.ammo; p.cp = sp.cp; p.finished = sp.finished; p.finishT = sp.finishT;
    p.place = sp.place; p.falls = sp.falls; p.bonks = sp.bonks;
    if (i === me) {
      const dead = sp.dead > 0;
      if (dead !== netMineDead) { netMineDead = dead; needHardSnapMe = true; }
      netMine = { x: sp.x, y: sp.y, z: sp.z, yaw: sp.yaw, vx: sp.vx, vy: sp.vy, vz: sp.vz, ground: sp.ground, t: s.t };
    }
  }
  for (const st of s.tiles) {
    const tl = sim.solids[st.id];
    if (tl) { tl.state = st.state; tl.active = st.active; }
  }
  for (let i = 0; i < s.pickups.length; i++) if (sim.pickups[i]) sim.pickups[i].on = s.pickups[i].on;
}
function resetAll() { resetNet(); lastNetPhase = ''; needHardSnapMe = false; netMineDead = false; netMine = null; }
`;

// eval the shipped block + glue in a scope with the deps the page provides.
// performance is a VIRTUAL clock that advances in lockstep with sim time: the
// shipped soft-clock alignment (applyNet) eases sim.t toward
// srvOffset + performance.now(), which is only meaningful when wall time and
// sim time advance together (a real browser). A frozen real clock would make
// the client clock lag the server and inflate every error measured here.
const factory = new Function('TAU', 'clamp', 'sim', 'me', 'mpHost', 'performance',
  netBlock + '\n' + onStateSrc +
  '\nreturn { applyNet, lerpPair, sendMPInput, onState, resetAll, netStats, snapBuf, ' +
  'get interpDelay() { return interpDelay; }, get interpTarget() { return interpTarget; } };');

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const NEUTRAL = { mx: 0, mz: 0, jump: false, dive: false, fire: false };
let vNowMs = 0;                            // virtual wall clock (ms), 1:1 with sim time
const perfMock = { now: () => vNowMs };

// ── server (authoritative) ──
const SEED = 123456789;
const srv = Sim.create(SEED);
srv.addPlayer({ name: 'Me', bot: false, kind: 'zombie', skill: 0 });
srv.addPlayer({ name: 'Remote', bot: false, kind: 'pumpkin', skill: 0 });
srv.addPlayer({ name: 'Bot', bot: true, kind: 'ghost', skill: 0.75 });
srv.humanId = -1;
srv.begin();
// begin() zeroed ammo; both humans need some. The client's own ammo is synced
// down from the server's value on every snapshot, so the server copy matters too.
srv.players[0].ammo = 3;
srv.players[1].ammo = 12;

// ── client (the code under test) ──
const cl = Sim.create(SEED);
cl.addPlayer({ name: 'Me', bot: false, kind: 'zombie', skill: 0 });
cl.addPlayer({ name: 'Remote', bot: false, kind: 'pumpkin', skill: 0 });
cl.addPlayer({ name: 'Bot', bot: true, kind: 'ghost', skill: 0.75 });
const ME = 0;
cl.humanId = ME;
cl.bid = 1e6; // matches the client: local bullet ids stay out of the server's range
cl.players[1]._mpInput = NEUTRAL;
cl.players[2]._mpInput = NEUTRAL;
cl.begin();
cl.players[ME].ammo = 3; // for the local-only shot after the countdown (after begin(): reset() would zero it)

const api = factory(Math.PI * 2, clamp, cl, ME, null, perfMock);
api.resetAll();

// server history for interpolation at the client's render time
const hist = { t: [], p: [[], [], []] };
// mirrors mp-server.js broadcastState() exactly (compact fixed-point wire format)
function snapNow() {
  const S = srv;
  const q2 = v => Math.round(v * 100), q1 = v => Math.round(v * 10);
  return {
    type: 'state',
    t: Math.round(S.t * 1000),
    raceT: q2(S.raceT), phase: S.phase, cd: q2(S.cd),
    finishCount: S.finishCount,
    pl: S.players.map(p => [
      q2(p.x), q2(p.y), q2(p.z), q1(p.vx), q1(p.vy), q1(p.vz), q2(p.yaw),
      p.ground ? p.ground.id : -1,
      q2(p.stun), q2(p.diveT), q2(p.dead), q2(p.protect),
      p.ammo, p.cp, p.finished ? 1 : 0, p.finished ? q2(p.finishT) : 0,
      p.place, p.falls, p.bonks,
    ]),
    tl: S.solids.filter(s => s.kind === 'crumble').map(s => [s.id, s.state, q2(s.cy), s.active ? 1 : 0]),
    bl: S.bullets.map(b => [b.id, q2(b.x), q2(b.y), q2(b.z), q1(b.vx), q1(b.vz), b.owner]),
    pk: S.pickups.map(k => k.on ? 1 : 0),
  };
}
function srvPosAt(id, t) { // linear interpolation in the tick history
  const H = hist.p[id], T = hist.t;
  if (!H.length || t <= T[0]) return { ...H[0], gap: 0 };
  if (t >= T[T.length - 1]) return { ...H[H.length - 1], gap: 0 };
  let i = 1;
  while (i < T.length - 1 && T[i] < t) i++;
  const k = (t - T[i - 1]) / (T[i] - T[i - 1]);
  return {
    x: H[i - 1].x + (H[i].x - H[i - 1].x) * k,
    y: H[i - 1].y + (H[i].y - H[i - 1].y) * k,
    z: H[i - 1].z + (H[i].z - H[i - 1].z) * k,
    vz: H[i - 1].vz + (H[i].vz - H[i - 1].vz) * k,
    // per-tick displacement of the interval: a fall→respawn teleport makes the
    // linear ref meaningless (it "tracks" the jump), so callers can skip it
    gap: Math.hypot(H[i].x - H[i - 1].x, H[i].y - H[i - 1].y, H[i].z - H[i - 1].z),
  };
}

// run the race: 30 Hz server tick, state broadcast every tick (shipped
// STATE_EVERY = 1), client frame per tick with 1-tick delivery latency
const myInputDelay = []; // my local input, applied to the server one tick late
let pending = null;
const remoteErr = [], myErr = [], bulletErr = [];
let vzDecayFrames = 0, vzFrames = 0;
let ownBulletAliveWhileServerBlind = false;
let simAcc = 0;

for (let tick = 1; tick <= N_TICKS; tick++) {
  vNowMs = tick * TICK * 1000;  // virtual wall clock tracks sim time (1 s sim = 1 s wall)
  // server: apply inputs (mine one tick late — models RTT), tick, maybe broadcast
  const myInp = myInputDelay.length ? myInputDelay.shift() : NEUTRAL;
  srv.players[ME]._mpInput = myInp;
  // ~20 shots (fireCd 0.3). Bullets die fast on the spinner bars, so a few
  // shots yield too few "server still has it" frames to measure tracking.
  srv.players[1]._mpInput = { mx: 0, mz: 1, jump: false, dive: false, fire: tick >= 100 && tick <= 280 };
  srv.step(TICK, null);
  for (let i = 0; i < 3; i++) hist.p[i].push({ x: srv.players[i].x, y: srv.players[i].y, z: srv.players[i].z, vz: srv.players[i].vz });
  hist.t.push(srv.t);
  pending = snapNow();  // 30 Hz state stream, like the shipped server

  // client frame: deliver the snapshot that left on the previous tick
  if (pending) { api.onState(pending); pending = null; }

  // local input (prediction): forward always; one local-only shot after the
  // countdown (tick 95: cd is 3 s = 90 ticks) — the server never sees it,
  // modeling an input the server hasn't acknowledged yet
  const mine = { mx: 0, mz: 1, jump: false, dive: false, fire: tick === 95 };
  myInputDelay.push(tick === 95 ? { ...mine, fire: false } : mine);

  const remotes = api.applyNet(TICK);
  simAcc += TICK;
  let n = 0;
  while (simAcc >= STEP && n < 5) { cl.step(STEP, mine); simAcc -= STEP; n++; }
  // the client re-applies the remote interpolation after the local step
  for (const r of remotes) { r.p.x = r.x; r.p.y = r.y; r.p.z = r.z; r.p.vx = r.vx; r.p.vy = r.vy; r.p.vz = r.vz; r.p.yaw = r.yaw; }

  // ── measurements (render time = cl.t - interpDelay, the live adaptive delay) ──
  const tI = cl.t - api.interpDelay;
  for (const id of [1, 2]) {
    const ref = srvPosAt(id, tI);
    if (ref.gap > 4) continue; // fall→respawn teleport: client snaps, ref is bogus
    const p = cl.players[id];
    remoteErr.push(Math.hypot(p.x - ref.x, p.y - ref.y, p.z - ref.z));
    if (cl.t > 4.0 && ref.vz > 5) { vzFrames++; if (p.vz < 2.5) vzDecayFrames++; } // steady running only
  }
  const refMe = srvPosAt(ME, cl.t);
  if (refMe.gap <= 4) myErr.push(Math.hypot(cl.players[ME].z - refMe.z));
  for (const b of cl.bullets) {
    if (b.owner === ME) {
      const onServer = srv.bullets.some(sb => Math.abs(sb.x - b.x) < 0.01 && Math.abs(sb.z - b.z) < 0.01);
      if (!onServer) ownBulletAliveWhileServerBlind = true;
    } else {
      const ref = srv.bullets.find(sb => sb.id === b.id);
      if (ref) {
        // back-propagate the server bullet to the client's render time (tI); bullets
        // fly at constant speed until they hit, so this is the true reference
        const rx = ref.x - ref.vx * (cl.t - tI), rz = ref.z - ref.vz * (cl.t - tI);
        bulletErr.push(Math.hypot(b.x - rx, b.z - rz));
      }
    }
  }
  if (!isFinite(remoteErr[remoteErr.length - 1]) || !isFinite(myErr[myErr.length - 1])) {
    console.error('non-finite position at tick', tick);
    process.exit(1);
  }
}

const p95 = (a, q) => { const s = a.slice().sort((x, y) => x - y); return s[Math.max(0, ((q * s.length) | 0))] || 0; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

console.log('client netcode vs authoritative sim (15 s, 1-tick input delay, 1-tick delivery):');
ok(p95(remoteErr, 0.95) < 0.6, `remotes track server interpolation (p95 err ${p95(remoteErr, 0.95).toFixed(2)} u, mean ${mean(remoteErr).toFixed(2)} u over ${remoteErr.length} frames)`);
ok(vzDecayFrames === 0, `no remote velocity decay: ${vzDecayFrames}/${vzFrames} frames with server vz>5 u/s but client vz<2.5`);
ok(p95(myErr, 0.95) < 1.0, `own-player correction bounded (p95 ${p95(myErr, 0.95).toFixed(2)} u, mean ${mean(myErr).toFixed(2)} u)`);
ok(bulletErr.length > 10 && p95(bulletErr, 0.95) < 1.0, `remote bullets rebuilt by id track server (${bulletErr.length} samples, p95 ${bulletErr.length ? p95(bulletErr, 0.95).toFixed(2) : '--'} u)`);
ok(ownBulletAliveWhileServerBlind, 'own local bullet survives rebuild while server hasn\'t seen it');
const bufWin = api.snapBuf.length > 1 ? api.snapBuf[api.snapBuf.length - 1].t - api.snapBuf[0].t : 0;
ok(bufWin > 0.9 && bufWin <= 1.05,
  `snapshot buffer holds the ~1 s time window (shipped BUF_AGE; ${bufWin.toFixed(2)} s, ${api.snapBuf.length} samples)`);

console.log('\n' + (failures === 0 ? 'CLIENT NETCODE: ALL PASS' : `CLIENT NETCODE: ${failures} FAILURE(S)`));
process.exit(failures === 0 ? 0 : 1);
