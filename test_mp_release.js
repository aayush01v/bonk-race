// Release / edge test for the own-player correction.
//
// Reproduces the bug reported in analysis.txt: the player runs toward a platform
// edge and releases the stick "with room to spare", but the on-screen character
// keeps sliding forward over the edge and falls. Root cause: applyNet()'s
// "me" correction pulled the local prediction back onto a server sample that
// still carried the *previous* input, so on-screen trailed the true local
// (solo) prediction and the release misjudged the distance to the edge.
//
// Setup: a flat course (start + alley only; every other solid disabled) so Me
// runs in a straight line to a known edge at z = EDGE_Z with a pit beyond it.
// Me (human, slot 0) runs forward; a perception-based policy releases when the
// ON-SCREEN z reaches EDGE_Z - MARGIN. The released input reaches the server
// one uplink later (DELIVERY ticks), exactly like the real line.
//
// Assertions (verified against the SOLO reference, not just the server/corr):
//   1. on-screen tracks the solo sim horizontally (max |Δz| small) — no slide
//   2. releasing with MARGIN of room does NOT throw Me off the edge (no fall)
// The test FAILS on the pre-fix code (Me falls / slides) and PASSES on the fix.
const fs = require('fs');
const path = require('path');
const Sim = require('./bonk/sim.js');

const TICK = 1 / 30, STEP = 1 / 60;
const DELIVERY = 3;        // one-way latency in ticks (uplink == downlink == 3)
const RTT = 2 * DELIVERY;  // round trip in ticks (6 = 200 ms)
const N_TICKS = 420;
const EDGE_Z = 45;         // alley ends here; a pit beyond
// The player releases this far short of the edge, as they would "with room to
// spare". It must exceed the uplink motion (the real body keeps running for one
// uplink after release) + the coast distance, or the authoritative server falls
// regardless of the client — that's network latency, not the correction bug.
// uplink motion = RUN·(DELIVERY·TICK); coast = RUN²/(2·DEC_G).
const MARGIN = 1.5;        // "room to spare" — comfortably clears uplink + coast
const RUN_Z = 7.4;         // Sim.K.RUN
const COAST = RUN_Z * RUN_Z / (2 * 65);              // DEC_G
const UPLINK_MOTION = RUN_Z * DELIVERY * TICK;       // body runs on during the uplink

let failures = 0;
const ok = (cond, label) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label);
  if (!cond) failures++;
};

// ── extract the shipped client netcode (same as test_mp_client_sim.js) ──
const html = fs.readFileSync(path.join(__dirname, 'sim-race-webgl.html'), 'utf8');
const start = html.indexOf('const INTERP_DELAY');
const end = html.indexOf('/* ---------------- per-frame update');
if (start < 0 || end < 0 || end <= start) {
  console.error('could not locate the MP netcode section in sim-race-webgl.html');
  process.exit(1);
}
const netBlock = html.slice(start, end);

const onStateSrc = `
function onState(raw) {
  const s = decodeState(raw);
  const now = performance.now();
  if (netStats.lastStateNow) netStats.gaps.push(now - netStats.lastStateNow);
  if (netStats.gaps.length > 60) netStats.gaps.shift();
  netStats.lastStateNow = now;
  snapBuf.push(s);
  while (snapBuf.length > 2 && s.t - snapBuf[0].t > BUF_AGE) snapBuf.shift();
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
      if (typeof reconcileOwn === 'function') reconcileOwn(s, sp, now / 1000);
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

// performance is a VIRTUAL clock in lockstep with sim time (see client_sim test).
const factory = new Function('TAU', 'Sim', 'clamp', 'sim', 'me', 'mpHost', 'performance',
  netBlock + '\n' + onStateSrc +
  '\nreturn { applyNet, sendMPInput, onState, resetAll, netStats, ownHist };');

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const NEUTRAL = { mx: 0, mz: 0, jump: false, dive: false, fire: false };
const FORWARD = { mx: 0, mz: 1, jump: false, dive: false, fire: false };
let vNowMs = 0;
const perfMock = { now: () => vNowMs };

// ── course shaping: keep only the flat start + alley, disable everything else ──
// Me runs straight down the middle (x = slot 0 = -4.75) to the alley's far end
// (z = 45); beyond that is a pit. Disabling (not removing) keeps solid ids and
// array indices valid so the crumble lookup sim.solids[id] stays intact.
function flatten(S) {
  for (const s of S.solids) s.active = (s.name === 'start' || s.name === 'alley');
}

// ── server (authoritative) ──
const SEED = 987654321;
const srv = Sim.create(SEED);
srv.addPlayer({ name: 'Me', bot: false, kind: 'zombie', skill: 0 });
srv.addPlayer({ name: 'Idle', bot: true, kind: 'pumpkin', skill: 0 });
srv.begin();
flatten(srv);
srv.players[0].ammo = 3;
srv.players[1].ammo = 0;

// ── client (the code under test) ──
const cl = Sim.create(SEED);
cl.addPlayer({ name: 'Me', bot: false, kind: 'zombie', skill: 0 });
cl.addPlayer({ name: 'Idle', bot: true, kind: 'pumpkin', skill: 0 });
const ME = 0;
cl.humanId = ME;
cl.bid = 1e6;
cl.players[1]._mpInput = NEUTRAL;   // remote runs neutral: it stays put
cl.begin();
flatten(cl);
cl.players[ME].ammo = 3;

// ── solo reference: the exact non-MP experience — only Me, no netcode ──
const solo = Sim.create(SEED);
solo.addPlayer({ name: 'Me', bot: false, kind: 'zombie', skill: 0 });
solo.humanId = 0;
solo.begin();
flatten(solo);
solo.players[0].ammo = 3;

// compact wire format, mirrors mp-server.js broadcastState()
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

// fake host + reset
const fakeHost = { postMessage: () => {} };
const api = factory(Math.PI * 2, Sim, clamp, cl, ME, fakeHost, perfMock);
api.resetAll();
api.netStats.rtt = Math.round(RTT * TICK * 1000);  // simulated RTT probe (ms)

// ── run the approach → release → coast ──
const outQ = [];        // { at, snap }
const histInp = [];     // histInp[t] = the local input at tick t (server reads t-DELIVERY)
const track = [];        // per-tick { clZ, soloZ, srvZ, soloGround, clGround }
const gapLog = [];       // per-tick (cl.z - solo.z), NaN once either falls
let released = false, releaseTick = -1;
let soloFell = false, srvFell = false, clFell = false;
let soloFallTick = -1, srvFallTick = -1, clFallTick = -1;
let soloStopZ = null, srvStopZ = null, clStopZ = null;
let maxTrackErr = 0, maxTick = -1;      // overall (includes post-release reconciliation to the server)
let approachErr = 0, approachTick = -1;  // max |Δz| while still running toward the edge (the release decision window)
let simAcc = 0, soloAcc = 0;

for (let tick = 1; tick <= N_TICKS; tick++) {
  vNowMs = tick * TICK * 1000;

  // perception-based input: release when the ON-SCREEN z reaches the margin line,
  // then keep the stick centered (NEUTRAL) — the player lets go and stays let go
  const onScreenZ = cl.players[ME].z;
  let mine = released ? NEUTRAL : FORWARD;
  if (!released && onScreenZ >= EDGE_Z - MARGIN) { released = true; releaseTick = tick; }
  histInp[tick] = mine;

  // server: apply my input as it arrives (one uplink = DELIVERY ticks late), tick
  const srvInp = histInp[tick - DELIVERY] || NEUTRAL;
  srv.players[ME]._mpInput = srvInp;
  srv.players[1]._mpInput = NEUTRAL;
  srv.step(TICK, null);

  outQ.push({ at: tick + DELIVERY, snap: snapNow() });

  // client: deliver everything that has arrived, then shipped update() order
  while (outQ.length && outQ[0].at <= tick) api.onState(outQ.shift().snap);
  api.sendMPInput(mine);
  api.applyNet(TICK);
  simAcc += TICK;
  let n = 0;
  while (simAcc >= STEP && n < 10) { cl.step(STEP, mine); simAcc -= STEP; n++; }
  if (n >= 10) simAcc = 0;
  
  const pm = cl.players[ME];
  if (pm) {
    const w = vNowMs / 1000 + TICK;
    api.ownHist.push({ w, x: pm.x, y: pm.y, z: pm.z, g: !!pm.ground });
    while (api.ownHist.length && api.ownHist[0].w < w - 2.5) api.ownHist.shift();
  }

  // solo reference: identical sim, only Me, same input, no netcode
  soloAcc += TICK;
  let sn = 0;
  while (soloAcc >= STEP && sn < 10) { solo.step(STEP, mine); soloAcc -= STEP; sn++; }

  // ── measurements ──
  const sp = solo.players[0], cp = cl.players[ME], sv = srv.players[ME];
  // perception fidelity: while both are alive on the platform, how far does the
  // on-screen z trail/lead the pure solo prediction? (Stop once either falls —
  // a respawn would blow this up to the whole course length.)
  if (!clFell && !soloFell) {
    const g = Math.abs(cp.z - sp.z);
    if (g > maxTrackErr) { maxTrackErr = g; maxTick = tick; }
    // steady running only: exclude the race-start acceleration transient (the 30 Hz
    // server vs 60 Hz local step don't match perfectly for ~20 ticks after "go" at
    // tick ~90), so measure the approach while both are cruising at full speed
    if (!released && tick >= 110 && sp.vz > 7.0 && sp.ground && cp.ground && g > approachErr) { approachErr = g; approachTick = tick; }
  }
  if (!soloFell && sp.dead > 0) { soloFell = true; soloFallTick = tick; soloStopZ = sp.z; }
  if (!srvFell && sv.dead > 0) { srvFell = true; srvFallTick = tick; srvStopZ = sv.z; }
  if (!clFell && cp.dead > 0) { clFell = true; clFallTick = tick; clStopZ = cp.z; }
  if (!released) track.push({ tick, onScreenZ, soloZ: sp.z, srvZ: sv.z });
  gapLog[tick] = sp.dead > 0 || cp.dead > 0 ? NaN : cp.z - sp.z;
}

// final positions (if nobody fell, where did each stop?)
if (!soloFell) soloStopZ = solo.players[0].z;
if (!srvFell) srvStopZ = srv.players[ME].z;
if (!clFell) clStopZ = cl.players[ME].z;

// how far short of the edge did each stop (positive = safely on the platform)?
const shortOf = z => (z === null ? NaN : EDGE_Z - z);

console.log(`release/edge test (200 ms RTT, ${DELIVERY}-tick uplink, margin ${MARGIN} u before the z=${EDGE_Z} edge;`);
console.log(`  uplink motion ${UPLINK_MOTION.toFixed(2)} u + coast ${COAST.toFixed(2)} u = ${(UPLINK_MOTION + COAST).toFixed(2)} u must fit inside the margin):`);
console.log(`  released at tick ${releaseTick}; on-screen→edge gap when released: ${(released ? EDGE_Z - track[track.length - 1].onScreenZ : NaN).toFixed(2)} u`);
console.log(`  solo  : ${soloFell ? `FELL at tick ${soloFallTick} (z ${soloStopZ?.toFixed(2)})` : `stopped ${shortOf(soloStopZ).toFixed(2)} u short of the edge`}`);
console.log(`  server: ${srvFell ? `FELL at tick ${srvFallTick} (z ${srvStopZ?.toFixed(2)})` : `stopped ${shortOf(srvStopZ).toFixed(2)} u short of the edge`}`);
console.log(`  screen: ${clFell ? `FELL at tick ${clFallTick} (z ${clStopZ?.toFixed(2)})` : `stopped ${shortOf(clStopZ).toFixed(2)} u short of the edge`}`);
console.log(`  on-screen vs solo, approach (release-decision window): ${approachErr.toFixed(3)} u at tick ${approachTick}  ← this is the misjudgment`);
console.log(`  on-screen vs solo, overall (incl. post-release reconciliation to the lagged server): ${maxTrackErr.toFixed(3)} u at tick ${maxTick}`);
{
  const ticks = [95, 105, 120, 150, 180, 210, 240, 268];
  let line = '  gap profile: ';
  for (const t of ticks) line += `t${t}=${isFinite(gapLog[t]) ? gapLog[t].toFixed(2) : '--'} `;
  console.log(line);
}

ok(releaseTick > 0, `the player actually released before reaching the edge (tick ${releaseTick})`);
ok(approachErr < 0.4, `on-screen tracks the solo prediction through the approach — the release-decision window (max |Δz| ${approachErr.toFixed(2)} u; pre-fix the on-screen trailed the pure prediction by ~v·rtt here, so the player released with less true margin than they saw)`);
ok(!srvFell, `releasing ${MARGIN} u short of the edge survives on the authoritative server (${srvFell ? 'server fell — the stale-sample pull threw the player over the edge' : 'server made the landing'})`);
ok(!clFell, `the on-screen player survives too (${clFell ? 'on-screen fell' : 'on-screen landed'})`);

console.log('\n' + (failures === 0 ? 'RELEASE/EDGE: ALL PASS' : `RELEASE/EDGE: ${failures} FAILURE(S)`));
process.exit(failures === 0 ? 0 : 1);
