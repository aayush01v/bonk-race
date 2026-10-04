// Latency/loss scenarios for the client netcode (TODO-netcode.md item 4.1).
//
// Extracts the shipped MP netcode from sim-race-webgl.html and runs it —
// unmodified — against a real authoritative 30 Hz sim (bonk/sim.js) behind a
// configurable delivery pipe: one-way delay + jitter + snapshot drop. The RTT
// probe is simulated by feeding netStats.rtt, so the adaptive-delay target sees
// the real one-way latency + arrival jitter. Each scenario asserts a mix of:
//   - adaptive delay converges to cover the line (and shrinks on a good line)
//   - remote frame-to-frame motion stays smooth (no freeze-jump, no explosion)
//   - own-player correction stays bounded
//   - the snapshot stream stays well paced (median gap + delivery ratio)
//   - the countdown (cd) advances in tick-sized steps under load (item 3.2)
const fs = require('fs');
const path = require('path');
const Sim = require('./bonk/sim.js');

const TICK = 1 / 30, STEP = 1 / 60, N_TICKS = 600; // 20 s per scenario
let failures = 0;
const ok = (cond, label) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label);
  if (!cond) failures++;
};

// deterministic RNG so the scenarios (drops, jitter) are reproducible
let rngState = 1234567;
const rng = () => (rngState = (rngState * 1664525 + 1013904223) >>> 0) / 4294967296;

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
    }
  }
  for (const st of s.tiles) { const tl = sim.solids[st.id]; if (tl) { tl.state = st.state; tl.active = st.active; } }
  for (let i = 0; i < s.pickups.length; i++) if (sim.pickups[i]) sim.pickups[i].on = s.pickups[i].on;
}
function resetAll() { resetNet(); lastNetPhase = ''; needHardSnapMe = false; netMineDead = false; netMine = null; }
`;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const NEUTRAL = { mx: 0, mz: 0, jump: false, dive: false, fire: false };

// ── scenario runner ──
// o: { baseLat: one-way delay in ticks, jit: max extra ticks, loss: 0..1,
//      outageFrom/outageTo: ticks whose snapshots are dropped (delivery outage),
//      measureFrom: first tick to count toward the metrics }
// DEBUG_LAT=S2,S4 → print anomaly traces (big cd steps / jumps / own-err) for those scenarios
const DEBUG_LAT = process.env.DEBUG_LAT ? process.env.DEBUG_LAT.split(',') : [];

function runScenario(name, o) {
  rngState = 1234567;
  // measureFrom: first tick counted toward the metrics (default 120 = skip the
  // 3 s countdown + adaptive-delay ramp-up, where brief starvation is expected)
  const { baseLat, jit, loss, outageFrom = -1, outageTo = -1, measureFrom = 120, debug = DEBUG_LAT.includes(name) } = o;

  // virtual performance: the shipped soft-clock alignment eases sim.t toward
  // srvOffset + performance.now(), which is only meaningful when wall time and
  // sim time advance together — so drive a 1:1 virtual clock from the loop.
  let vNowMs = 0;
  const perfMock = { now: () => vNowMs };

  // server (authoritative)
  const SEED = 42424242;
  const srv = Sim.create(SEED);
  srv.addPlayer({ name: 'Me', bot: false, kind: 'zombie', skill: 0 });
  srv.addPlayer({ name: 'Remote', bot: false, kind: 'pumpkin', skill: 0 });
  srv.addPlayer({ name: 'Bot', bot: true, kind: 'ghost', skill: 0.75 });
  srv.humanId = -1;
  srv.begin();
  srv.players[0].ammo = 3; srv.players[1].ammo = 12;

  // client (the code under test — a fresh factory closure per scenario)
  const cl = Sim.create(SEED);
  cl.addPlayer({ name: 'Me', bot: false, kind: 'zombie', skill: 0 });
  cl.addPlayer({ name: 'Remote', bot: false, kind: 'pumpkin', skill: 0 });
  cl.addPlayer({ name: 'Bot', bot: true, kind: 'ghost', skill: 0.75 });
  const ME = 0;
  cl.humanId = ME;
  cl.bid = 1e6;
  cl.players[1]._mpInput = NEUTRAL;
  cl.players[2]._mpInput = NEUTRAL;
  cl.begin();
  cl.players[ME].ammo = 3;

  const factory = new Function('TAU', 'clamp', 'sim', 'me', 'mpHost', 'performance',
    netBlock + '\n' + onStateSrc +
    '\nreturn { applyNet, lerpPair, onState, resetAll, netStats, snapBuf, decodeState, ' +
    'get interpDelay() { return interpDelay; }, get interpTarget() { return interpTarget; } };');
  const api = factory(Math.PI * 2, clamp, cl, ME, null, perfMock);
  api.resetAll();

  // server history (for interpolated references + teleport detection)
  const hist = { t: [], p: [[], [], []] };
  // mirrors mp-server.js broadcastState() exactly (compact fixed-point wire format)
  function snapNow() {
    const S = srv;
    const q2 = v => Math.round(v * 100), q1 = v => Math.round(v * 10);
    return {
      type: 'state',
      t: Math.round(S.t * 1000), raceT: q2(S.raceT), phase: S.phase, cd: q2(S.cd),
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
    if (!H.length || t <= T[0]) return { ...H[0], gap: 0, speed: 0 };
    if (t >= T[T.length - 1]) {  // keep the real interval gap: a respawn on the
      const i = H.length - 1;    // newest tick must still read as a teleport
      return { ...H[i], gap: Math.hypot(H[i].x - H[i - 1].x, H[i].y - H[i - 1].y, H[i].z - H[i - 1].z) };
    }
    let i = 1;
    while (i < T.length - 1 && T[i] < t) i++;
    const k = (t - T[i - 1]) / (T[i] - T[i - 1]);
    return {
      x: H[i - 1].x + (H[i].x - H[i - 1].x) * k,
      y: H[i - 1].y + (H[i].y - H[i - 1].y) * k,
      z: H[i - 1].z + (H[i].z - H[i - 1].z) * k,
      // per-tick displacement: fall→respawn teleports make the linear ref bogus
      gap: Math.hypot(H[i].x - H[i - 1].x, H[i].y - H[i - 1].y, H[i].z - H[i - 1].z),
    };
  }

  // lossy delivery pipe
  const queue = [];  // { at, snap }, ordered by arrival tick
  let sent = 0, delivered = 0;
  function schedule(snap, tick) {
    sent++;
    if (rng() < loss) return;          // dropped packet
    if (tick >= outageFrom && tick <= outageTo) return;  // outage window
    queue.push({ at: tick + baseLat + Math.floor(rng() * (jit + 1)), snap });  // +0..jit ticks
  }

  // run: 30 Hz server + client, one frame per tick
  const myInputDelay = [];
  let simAcc = 0;
  const myErr = [], jumpErr = [], jumpTicks = [];
  let freezeFrames = 0, movingFrames = 0, extrapFrames = 0;
  const arrTimes = [], cdSteps = [];
  let prevRem = null, prevCd = null;

  for (let tick = 1; tick <= N_TICKS; tick++) {
    vNowMs = tick * TICK * 1000;

    // server: my input lands one tick late (models the up-link RTT)
    const myInp = myInputDelay.length ? myInputDelay.shift() : NEUTRAL;
    srv.players[ME]._mpInput = myInp;
    srv.players[1]._mpInput = { mx: 0, mz: 1, jump: false, dive: false, fire: tick >= 120 && tick <= 500 };
    srv.step(TICK, null);
    for (let i = 0; i < 3; i++) hist.p[i].push({ x: srv.players[i].x, y: srv.players[i].y, z: srv.players[i].z });
    hist.t.push(srv.t);
    schedule(snapNow(), tick);

    // simulate the RTT probe answering (mp_pong): one-way = base lat + avg jitter
    if (tick % 30 === 0) api.netStats.rtt = Math.round(2 * (baseLat + jit / 2) * TICK * 1000);

    // client: deliver everything that has arrived, run the shipped frame pipeline
    while (queue.length && queue[0].at <= tick) {
      const wire = queue.shift().snap;
      api.onState(wire);
      delivered++;
      arrTimes.push(wire.t / 1000);  // wire t is ms; pacing is measured in sim seconds
      const sd = api.decodeState(wire);  // decoded cd (seconds), same as the client sees
      if (prevCd !== null) {
        const step = Math.abs(sd.cd - prevCd);
        cdSteps.push(step);
        if (debug && step > 0.2) console.error(`  [cd] tick=${tick} t=${sd.t.toFixed(2)} ${prevCd.toFixed(2)} → ${sd.cd.toFixed(2)}`);
      }
      prevCd = sd.cd;
    }
    const mine = { mx: 0, mz: 1, jump: false, dive: false, fire: tick === 100 };
    myInputDelay.push({ mx: 0, mz: 1, jump: false, dive: false, fire: false });
    const snapsBefore = api.netStats.snaps;
    const remotes = api.applyNet(TICK);
    const snapped = api.netStats.snaps > snapsBefore;  // snap-guard frame (fall/respawn, own hard snap)
    simAcc += TICK;
    let n = 0;
    while (simAcc >= STEP && n < 10) { cl.step(STEP, mine); simAcc -= STEP; n++; }
    for (const r of remotes) { r.p.x = r.x; r.p.y = r.y; r.p.z = r.z; r.p.vx = r.vx; r.p.vy = r.vy; r.p.vz = r.vz; r.p.yaw = r.yaw; }

    // measurements (remotes are rendered interpDelay behind cl.t, so their
    // reference is the server position AT THE RENDER TIME, not "now")
    const pair = api.lerpPair();
    if (pair && pair.ex > 0.016) extrapFrames++;
    if (tick >= measureFrom) {
      for (const id of [1, 2]) {
        const p = cl.players[id];
        if (!prevRem) prevRem = {};
        const ref = srvPosAt(id, cl.t - api.interpDelay);
        if (ref.gap > 4) { prevRem[id] = null; continue; }  // fall/respawn at render time
        if (p.dead > 0) { prevRem[id] = { x: p.x, y: p.y, z: p.z }; continue; }  // falling corpse moves fast by design
        const prev = prevRem[id];
        if (prev && !snapped) {  // snap-guard frames are a separate mechanism; don't mix them into smoothness
          const d = Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z);
          jumpErr.push(d); jumpTicks.push(tick);
          if (debug && d > 1.5) console.error(`  [jump] tick=${tick} id=${id} d=${d.toFixed(2)} refGap=${ref.gap.toFixed(2)} dead=${p.dead} stun=${p.stun.toFixed(2)} phase=${cl.phase}`);
          if (ref.gap > 0.13) {  // remote genuinely moving (>= ~4 u/s) at render time
            movingFrames++;
            if (d < 0.03) {  // a moving remote standing still = starvation freeze
              freezeFrames++;
              if (debug) {
                const L2 = api.lerpPair();
                const pz = s => s && s.players[id] ? s.players[id].z.toFixed(3) : 'na';
                console.error(`  [freeze] tick=${tick} id=${id} d=${d.toFixed(3)} refGap=${ref.gap.toFixed(2)} ex=${L2 ? L2.ex.toFixed(2) : 'na'} k=${L2 ? L2.k.toFixed(2) : 'na'} tNow=${(cl.t - api.interpDelay).toFixed(3)} buf=[${L2 ? L2.a.t.toFixed(3) + '..' + L2.b.t.toFixed(3) : 'na'}] pZ=${p.z.toFixed(3)} aZ=${pz(L2 && L2.a)} bZ=${pz(L2 && L2.b)} pStun=${p.stun.toFixed(2)}`);
              }
            }
          }
        }
        prevRem[id] = { x: p.x, y: p.y, z: p.z };
      }
      if (debug && tick >= 290 && tick <= 400 && tick % 5 === 0) {
        const pc = cl.players[ME], ps = srv.players[ME];
        const p1c = cl.players[1], p1s = srv.players[1];
        console.error(`  [st] tick=${tick} me cl: z=${pc.z.toFixed(2)} vz=${pc.vz.toFixed(2)} stun=${pc.stun.toFixed(2)} bonks=${pc.bonks} falls=${pc.falls} | me srv: z=${ps.z.toFixed(2)} vz=${ps.vz.toFixed(2)} stun=${ps.stun.toFixed(2)} bonks=${ps.bonks} | rem cl: z=${p1c.z.toFixed(2)} dead=${p1c.dead.toFixed(1)} | rem srv: z=${p1s.z.toFixed(2)} dead=${p1s.dead.toFixed(1)}`);
      }
      const refMe = srvPosAt(ME, cl.t);  // own player runs at local "now" (predict + correct)
      if (refMe.gap <= 4 && isFinite(refMe.z)) {
        const e = Math.hypot(cl.players[ME].z - refMe.z);
        myErr.push(e);
        if (debug && e > 2) {
          const p = cl.players[ME];
          console.error(`  [me] tick=${tick} cl.t=${cl.t.toFixed(2)} err=${e.toFixed(2)} clZ=${p.z.toFixed(2)} refZ=${refMe.z.toFixed(2)} dead=${p.dead.toFixed(2)} stun=${p.stun.toFixed(2)} fin=${p.finished} falls=${p.falls} phase=${cl.phase}`);
        }
      }
      else if (!isFinite(cl.players[ME].z)) { console.error(name, ': non-finite own position at tick', tick); process.exit(1); }
    }
  }

  // skip the first 4 s (countdown + adaptive-delay ramp-up) in the metric slices
  const m = {
    name, delay: api.interpDelay, target: api.interpTarget,
    extrap: extrapFrames, moving: movingFrames, freeze: freezeFrames,
    myErr, jumpErr, jumpTicks, arrTimes, cdSteps, sent, delivered,
  };
  return m;
}

const p95 = (a, q) => { const s = a.slice().sort((x, y) => x - y); return s[Math.max(0, ((q * s.length) | 0))] || 0; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const median = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
const arrGapsOf = t => { const g = []; for (let i = 1; i < t.length; i++) g.push(t[i] - t[i - 1]); return g; };

// ══════════════════════════════ S1 — slow internet line ══════════════════════════════
// the "realistic bad connection" from the original scenario: 167 ms one-way,
// ±2 tick jitter, 5% snapshot drop
{
  const m = runScenario('S1', { baseLat: 5, jit: 2, loss: 0.05 });
  const arrGaps = arrGapsOf(m.arrTimes);
  console.log(`S1 slow line (5 ticks one-way, ±2 tick jitter, 5% drop, ${N_TICKS} ticks):`);
  ok(m.delay >= 0.25, `adaptive delay grows to cover the latency (delay ${m.delay.toFixed(2)} s, target ${m.target.toFixed(2)} s)`);
  ok(p95(m.jumpErr, 0.99) < 0.9, `remote motion stays smooth under load (p99 frame jump ${p95(m.jumpErr, 0.99).toFixed(2)} u over ${m.jumpErr.length} frames, max ${m.jumpErr.length ? Math.max(...m.jumpErr).toFixed(2) : '--'} u)`);
  ok(m.moving > 0 && m.freeze / m.moving < 0.02,
    `no starvation freezes while remotes move (${m.freeze}/${m.moving} frames, ${m.extrap} frames extrapolated)`);
  ok(m.myErr.length > 100 && p95(m.myErr, 0.95) < 1.5, `own-player correction bounded (p95 ${p95(m.myErr, 0.95).toFixed(2)} u, mean ${mean(m.myErr).toFixed(2)} u over ${m.myErr.length} frames)`);
  ok(median(arrGaps) > 0.02 && median(arrGaps) < 0.1,
    `snapshot stream stays paced (median arrival gap ${(median(arrGaps) * 1000).toFixed(0)} ms, ${m.arrTimes.length}/${m.sent} delivered)`);
  // countdown sync (item 3.2): cd is applied per-arrival; each step stays small
  ok(m.cdSteps.length > 10 && p95(m.cdSteps, 0.95) <= 0.07,
    `countdown advances in tick-sized steps under load (p95 step ${(p95(m.cdSteps, 0.95) * 1000).toFixed(0)} ms of ${(m.cdSteps.length) * 30 / 1000}s stream)`);
}

// ═══════════════════════════ S2 — low-latency baseline ═══════════════════════════
// LAN-ish line: 33 ms one-way, ±1 tick, no loss. The adaptive delay must
// SHRINK back toward its floor — a permanently high delay on a good line is
// as wrong as no delay on a bad one. (Target = 0.15 base + one-way + 0.5×jitter
// ≈ 0.22 s for this line, vs 0.38 s on S1's slow line.)
{
  const m = runScenario('S2', { baseLat: 1, jit: 1, loss: 0 });
  console.log(`S2 low-latency baseline (1 tick one-way, ±1 tick jitter, no loss, ${N_TICKS} ticks):`);
  ok(m.delay <= 0.25, `delay shrinks toward the floor on a good line (delay ${m.delay.toFixed(2)} s, target ${m.target.toFixed(2)} s, S1 was 0.38 s)`);
  ok(p95(m.jumpErr, 0.99) < 0.5, `remote motion smooth (p99 frame jump ${p95(m.jumpErr, 0.99).toFixed(2)} u, max ${m.jumpErr.length ? Math.max(...m.jumpErr).toFixed(2) : '--'} u)`);
  ok(m.moving > 0 && m.freeze / m.moving < 0.015, `no starvation freezes (${m.freeze}/${m.moving} frames)`);
  ok(m.myErr.length > 100 && p95(m.myErr, 0.95) < 1.0, `own-player correction tight (p95 ${p95(m.myErr, 0.95).toFixed(2)} u, mean ${mean(m.myErr).toFixed(2)} u)`);
}

// ═══════════════════════════ S3 — extreme slow line ═══════════════════════════
// "Slow 3G"-class: 400 ms one-way, ±4 tick jitter, 10% loss. The adaptive
// delay saturates at its 0.4 s cap and starvation is frequent — the
// extrapolation cap (EXTRAP_MAX) is what keeps the frame-to-frame motion
// bounded instead of freezing-and-jumping.
{
  const m = runScenario('S3', { baseLat: 12, jit: 4, loss: 0.10 });
  const arrGaps = arrGapsOf(m.arrTimes);
  console.log(`S3 extreme line (12 ticks one-way, ±4 tick jitter, 10% drop, ${N_TICKS} ticks):`);
  ok(m.delay >= 0.38, `delay saturates at the cap to cover the line (delay ${m.delay.toFixed(2)} s, target ${m.target.toFixed(2)} s, cap 0.40 s)`);
  ok(p95(m.jumpErr, 0.99) < 1.5, `remote motion still bounded at the cap (p99 frame jump ${p95(m.jumpErr, 0.99).toFixed(2)} u, max ${m.jumpErr.length ? Math.max(...m.jumpErr).toFixed(2) : '--'} u)`);
  ok(m.moving > 0 && m.freeze / m.moving < 0.05,
    `freezes stay rare despite heavy starvation (${m.freeze}/${m.moving} frames, ${m.extrap} frames extrapolated)`);
  ok(m.myErr.length > 100 && p95(m.myErr, 0.95) < 2.0, `own-player correction bounded under stale samples (p95 ${p95(m.myErr, 0.95).toFixed(2)} u, mean ${mean(m.myErr).toFixed(2)} u)`);
  ok(median(arrGaps) > 0.02, `snapshot stream delivers (median arrival gap ${(median(arrGaps) * 1000).toFixed(0)} ms, ${m.arrTimes.length}/${m.sent} delivered)`);
}

// ═══════════════════════════ S4 — 1 s delivery outage ═══════════════════════════
// Same line as S1 but the pipe drops every snapshot for 1 s mid-race
// (router stall / interface blip). What must NOT happen: unbounded
// extrapolation (remote flying away), own player rubber-banding past the
// snap guard, or slow/uneven recovery. What IS expected: the remote freezes
// at the EXTRAP_MAX cap during the outage (better than wrong), one bounded
// snap when the stream resumes (the snap guard handles anything the server
// did unseen — in this run remote-1 falls and respawns during the outage),
// own prediction diverges locally (stale crumble state) but stays under the
// 8 u snap guard and the correction converges once samples flow again.
// (jumpErr excludes snap-guard frames — that mechanism is asserted separately
// in S1/S2 where a known fall→respawn happens.)
{
  const OUT = { from: 300, to: 390 };  // 10 s → 13 s of the run
  const m = runScenario('S4', { baseLat: 5, jit: 2, loss: 0, outageFrom: OUT.from, outageTo: OUT.to, measureFrom: 0 });
  // non-snap frame jumps during the outage + the 4 s recovery window
  const window = m.jumpTicks.map((t, i) => t >= OUT.from && t <= OUT.to + 120 ? m.jumpErr[i] : null).filter(v => v !== null);
  const post = m.jumpTicks.map((t, i) => t > OUT.to + 120 ? m.jumpErr[i] : null).filter(v => v !== null);
  const errTail = m.myErr.slice(-90);  // last 3 s: well after recovery
  console.log(`S4 one-second outage (5 ticks one-way, ${OUT.from * TICK}s–${(OUT.to * TICK).toFixed(0)}s dropped, ${N_TICKS} ticks):`);
  ok(window.length > 10 && Math.max(...window) < 10,
    `no instant teleport on resume (max non-snap frame step ${window.length ? Math.max(...window).toFixed(2) : '--'} u over ${window.length} frames — the catch-up ease splits the gap over ~150 ms)`);
  ok(post.length > 10 && p95(post, 0.99) < 0.9,
    `motion is smooth again after recovery (post-outage p99 frame jump ${p95(post, 0.99).toFixed(2)} u over ${post.length} frames)`);
  ok(m.myErr.length > 100 && p95(m.myErr, 0.95) < 8.0, `own prediction diverges locally but stays under the snap guard (p95 ${p95(m.myErr, 0.95).toFixed(2)} u — a local fall/respawn on stale crumble state; mean ${mean(m.myErr).toFixed(2)} u)`);
  ok(errTail.length > 50 && p95(errTail, 0.95) < 1.0, `correction converges after recovery (last-3s p95 ${p95(errTail, 0.95).toFixed(2)} u)`);
  ok(m.delay >= 0.25, `delay back to cover the line after recovery (delay ${m.delay.toFixed(2)} s, target ${m.target.toFixed(2)} s)`);
}

console.log('\n' + (failures === 0 ? 'LATENCY/LOSS: ALL PASS' : `LATENCY/LOSS: ${failures} FAILURE(S)`));
process.exit(failures === 0 ? 0 : 1);
