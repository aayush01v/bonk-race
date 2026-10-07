'use strict';
// Full-pipeline regression test for "I released the stick with room to spare, the character kept
// going over the edge, then I got teleported to the checkpoint".
//
// What runs here is the REAL code, not a model of it:
//   - bonk/sim.js (client and server simulations)
//   - bonk/inputbuf.js (the server's input playout buffer + ack, as used by mp-server.js)
//   - the client's own-player functions (reconcileOwn / applyOwnCorrection), extracted from
//     sim-race-webgl.html between the <own-reconcile-fns> markers
// Only the network (latency, jitter, asymmetry) and the 30 Hz tick loop are simulated.
//
// Why it exists: every earlier attempt (stale-sample gates, look-ahead damping, rtt/2 alignment)
// passed the older tests and still dropped the player off edges on a slow line, because those tests
// compared the screen with the server's position at "now" — i.e. they rewarded sitting on a stale
// sample. The checks below compare against what actually happens to the server's body.
//
//   A. release with margin before an edge: neither the screen nor the server body may fall
//   B. after the stop the screen must not lurch forward again
//   C. a real server-side displacement is still absorbed
//   D. jump arcs stay local (no tug while airborne)
//   E. analog steering stays on the solo prediction
const fs = require('fs');
const path = require('path');
const Sim = require('./bonk/sim.js');
const { InputBuffer } = require('./bonk/inputbuf.js');

const html = fs.readFileSync(process.env.CLIENT_HTML || path.join(__dirname, 'sim-race-webgl.html'), 'utf8');   // CLIENT_HTML=… to test another build
const marker = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b); if (i < 0 || j < 0) throw new Error('markers missing: ' + a); return html.slice(i + a.length, j); };
const FNS = marker('// <own-reconcile-fns>', '// </own-reconcile-fns>');
const konst = (name, dflt) => { const m = new RegExp('const ' + name + ' = ([^;]+);').exec(html); return m ? eval(m[1]) : dflt; };
const OWN_DZ = konst('OWN_DZ'), OWN_DV = konst('OWN_DV'), ACK_LEAD = konst('ACK_LEAD'), OWN_HIST_S = konst('OWN_HIST_S');
if ([OWN_DZ, OWN_DV, ACK_LEAD, OWN_HIST_S].some(v => typeof v !== 'number')) throw new Error('reconcile constants not found in sim-race-webgl.html');

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapA = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const SIM_STEP = 1 / 60;
const rng = seed => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const mk = () => { const s = Sim.create(7); s.addPlayer({ name: 'me', bot: false, kind: 'zombie', skill: 0 }); s.humanId = 0; s.begin(); return s; };

/** one 60 fps client + 30 Hz server over a simulated link; returns per-frame traces */
function run({ U = 0.1, D = 0.1, jitU = 0, jitD = 0, script, tEnd = 8, seed = 1, shove = null, correct = true }) {
  const R = rng(seed);
  const srv = mk(), cli = mk(), solo = mk();
  const sp = srv.players[0], cp = cli.players[0], op = solo.players[0];
  const upQ = [], downQ = []; let lastUp = 0, lastDown = 0;
  const owd = (base, jit) => Math.max(0.001, base + (R() * 2 - 1) * jit);
  const ib = new InputBuffer(), CLOCK_OFF = 5000.123;   // the server clock need not match the client's

  // client state (names mirror sim-race-webgl.html; FNS below closes over them)
  const sim = cli;
  let netMine = null, needHardSnapMe = false, srvOffset = null, rttEst = -1;
  const netStats = { rtt: -1, corr: 0, snaps: 0 };
  const ownHist = [], ownPend = { x: 0, y: 0, z: 0 }, ownPendV = { x: 0, z: 0 };
  let lastSent = null, lastSentAt = 0, simAcc = 0, nextPing = 0.5, lastPhase = '', netMineDead = false;
  // strict-mode eval has its own scope, so hand the functions back explicitly; they close over the
  // client state declared above (sim, netMine, needHardSnapMe, ownHist, …) exactly as in the page
  // eslint-disable-next-line no-eval
  const { reconcileOwn, applyOwnCorrection } = eval(FNS + '\n;({ reconcileOwn, applyOwnCorrection })');

  function sendInput(input, now) {
    const l = lastSent, changed = !l || input.mx !== l.mx || input.mz !== l.mz || input.fire !== l.fire;
    if (changed || input.jump || input.dive || now * 1000 - lastSentAt >= 100) {
      let sendAt = now;
      const arr = Math.max(lastUp, sendAt + owd(U, jitU)); lastUp = arr;
      upQ.push({ arr, msg: { t: now, mx: input.mx, mz: input.mz, fire: input.fire, jump: input.jump, dive: input.dive } });
      lastSent = { mx: input.mx, mz: input.mz, fire: input.fire }; lastSentAt = now * 1000;
    }
  }
  let k = 0, shoved = false;
  function serverTick(T) {
    if (shove && !shoved && srv.t >= shove.t) { sp.x += shove.dx || 0; sp.z += shove.dz || 0; shoved = true; }
    sp._mpInput = ib.step(T + CLOCK_OFF) || { mx: 0, mz: 0, fire: false, jump: false, dive: false };
    srv.step(1 / 30, null);
    const q = v => Math.round(v), a = sp;
    const arr = Math.max(lastDown, T + owd(D, jitD)); lastDown = arr;
    downQ.push({ arr, snap: { t: q(srv.t * 1000) / 1000, phase: srv.phase, cd: srv.cd, me: {
      x: q(a.x * 100) / 100, y: q(a.y * 100) / 100, z: q(a.z * 100) / 100, vx: q(a.vx * 10) / 10, vy: q(a.vy * 10) / 10, vz: q(a.vz * 10) / 10,
      yaw: q(a.yaw * 100) / 100, ground: a.ground ? a.ground.id : -1, stun: a.stun, diveT: a.diveT, dead: a.dead, protect: a.protect,
      ack: ib.ack > 0 ? q(ib.ack * 1000) / 1000 : 0 } } });
  }
  function onState(s, tArr) {
    const off = s.t - tArr; srvOffset = srvOffset === null ? off : srvOffset + (off - srvOffset) * 0.1;
    cli.phase = s.phase; cli.cd = s.cd;
    if (s.phase !== lastPhase) { lastPhase = s.phase; needHardSnapMe = true; }
    const m = s.me; cp.stun = m.stun; cp.diveT = m.diveT; cp.dead = m.dead; cp.protect = m.protect;
    const dead = m.dead > 0; if (dead !== netMineDead) { netMineDead = dead; needHardSnapMe = true; }
    netMine = { x: m.x, y: m.y, z: m.z, yaw: m.yaw, vx: m.vx, vy: m.vy, vz: m.vz, ground: m.ground, t: s.t };
    if (correct) reconcileOwn({ t: s.t }, m, tArr);
  }

  const dt = 1 / 60, N = Math.round(tEnd / dt);
  const tr = { t: [], cx: [], cz: [], cy: [], cg: [], cvx: [], sx: [], sz: [], sy: [], sg: [], ox: [], oz: [], oy: [], og: [], snaps: 0 };
  for (let f = 0; f <= N; f++) {
    const now = f * dt;
    for (;;) {
      const tTick = (k + 1) / 30, tUp = upQ.length ? upQ[0].arr : Infinity, tDn = downQ.length ? downQ[0].arr : Infinity;
      const tNext = Math.min(tUp, tTick, tDn);
      if (tNext > now) break;
      if (tNext === tUp) ib.push(upQ.shift().msg, tNext + CLOCK_OFF);
      else if (tNext === tTick) { k++; serverTick(tTick); }
      else { const d = downQ.shift(); onState(d.snap, d.arr); }
    }
    if (now >= nextPing) { const smp = Math.min((owd(U, jitU) + owd(D, jitD)) * 1000, 1200); rttEst = rttEst < 0 ? smp : rttEst + (smp - rttEst) * 0.4; netStats.rtt = rttEst; nextPing += 1; }
    const input = script(now);
    sendInput(input, now);
    if (srvOffset !== null) { const e = srvOffset + now - cli.t; if (Math.abs(e) > 0.05) cli.t += e * (1 - Math.exp(-10 * dt)); }  // clock slew, as in applyNet()
    if (netMine && correct) applyOwnCorrection(cp, dt);
    simAcc += dt; let n = 0;
    while (simAcc >= SIM_STEP - 1e-12 && n < 10) { cli.step(SIM_STEP, input); simAcc -= SIM_STEP; n++; }
    ownHist.push({ w: now, x: cp.x, y: cp.y, z: cp.z, g: !!cp.ground, vx: cp.vx, vz: cp.vz });
    while (ownHist.length && ownHist[0].w < now - OWN_HIST_S) ownHist.shift();
    solo.step(dt, input);
    tr.t.push(now); tr.cx.push(cp.x); tr.cz.push(cp.z); tr.cy.push(cp.y); tr.cg.push(!!cp.ground); tr.cvx.push(cp.vx);
    tr.sx.push(sp.x); tr.sz.push(sp.z); tr.sy.push(sp.y); tr.sg.push(!!sp.ground);
    tr.ox.push(op.x); tr.oz.push(op.z); tr.oy.push(op.y); tr.og.push(!!op.ground);
  }
  tr.snaps = netStats.snaps;
  return tr;
}

// ── scenarios ──
const J = { mx: 1, mz: 0, jump: false, dive: false, fire: false }, Z = { mx: 0, mz: 0, jump: false, dive: false, fire: false };
const fellFrom = (g, y, from) => { for (let i = from; i < y.length; i++) if (!g[i] && y[i] < -0.5) return true; return false; };
let failures = 0;
const ok = (c, l) => { console.log((c ? '  PASS  ' : '  FAIL  ') + l); if (!c) failures++; };
const LINKS = {
  'RTT 200': { U: 0.1, D: 0.1 }, 'RTT 400': { U: 0.2, D: 0.2 }, 'RTT 800': { U: 0.4, D: 0.4 },
  'RTT 400 ±80ms': { U: 0.2, D: 0.2, jitU: 0.08, jitD: 0.08 }, 'RTT 400 ±150ms': { U: 0.2, D: 0.2, jitU: 0.15, jitD: 0.15 },
  'up 50 / down 400 ms': { U: 0.05, D: 0.4 }, 'up 400 / down 50 ms': { U: 0.4, D: 0.05 }, 'RTT 2000': { U: 1, D: 1 },
};
const T0 = l => 3.5 + l.D + (l.jitD || 0) + 0.2;       // inputs start only after the client has seen "go"
const hold = (t0, r) => now => (now >= t0 && now < r) ? J : Z;

console.log('A. release with 1.0 u of on-screen margin before the edge (edge x=8; falls beyond ~8.34): falls out of 12 seeds');
for (const [name, l] of Object.entries(LINKS)) {
  const t0 = T0(l); let f = 0; const NS = 12;
  for (let sd = 1; sd <= NS; sd++) {
    const p1 = run({ ...l, seed: sd, script: hold(t0, 99), tEnd: t0 + 6 });
    const r = p1.t[p1.cx.findIndex((x, i) => x >= 7.0 && p1.t[i] > t0)];
    const p2 = run({ ...l, seed: sd, script: hold(t0, r), tEnd: r + 3 + 2 * l.D + 2 * (l.jitD || 0) });
    const from = Math.round(t0 * 60);
    if (fellFrom(p2.cg, p2.cy, from) || fellFrom(p2.sg, p2.sy, from)) f++;
  }
  ok(f <= 1, `${name.padEnd(20)} ${f}/${NS} falls`);
}

console.log('\nB. after stopping on open ground the screen must not lurch again (peak speed after the stop <= 1 u/s)');
for (const name of ['RTT 400', 'RTT 800', 'RTT 400 ±80ms']) {
  const l = LINKS[name], t0 = T0(l), r = t0 + 1.5;
  const tr = run({ ...l, seed: 1, script: hold(t0, r), tEnd: r + 3 });
  const i0 = Math.round(r * 60), sp = i => Math.hypot(tr.cx[i] - tr.cx[i - 1], tr.cz[i] - tr.cz[i - 1]) * 60;
  let iS = -1; for (let i = i0 + 1; i < tr.t.length; i++) if (sp(i) < 0.3) { iS = i; break; }
  let pk = 0; for (let i = iS + 1; i < tr.t.length; i++) pk = Math.max(pk, sp(i));
  ok(iS > 0 && pk <= 1.0, `${name.padEnd(20)} stops +${((iS - i0) / 60).toFixed(2)}s, later peak ${pk.toFixed(1)} u/s`);
}

console.log('\nC. a real server-side displacement (server body shoved 1.0 u while standing) is still absorbed: |screen - server| after 1.5 s <= 0.45');
for (const name of ['RTT 200', 'RTT 400', 'RTT 400 ±80ms']) {
  const l = LINKS[name];
  const tr = run({ ...l, seed: 2, script: () => Z, tEnd: 7, shove: { t: 4.0, dz: 1.0 } });
  const i = Math.round(5.5 * 60), e = Math.abs(tr.cz[i] - tr.sz[i]);
  ok(e <= 0.45, `${name.padEnd(20)} residual ${e.toFixed(2)} u`);
}

console.log('\nD. jump arc stays local: max |screen y - solo y| during the arc <= 0.4 u, landing within 0.4 u of the solo prediction');
for (const name of ['RTT 200', 'RTT 400']) {
  const l = LINKS[name], t0 = T0(l);
  const js = now => (now >= t0 && now < t0 + 1.7) ? { ...J, jump: Math.abs(now - (t0 + 0.5)) < 1 / 120 } : Z;
  const tr = run({ ...l, seed: 4, script: js, tEnd: t0 + 4 });
  let m = 0; for (let i = Math.round((t0 + 0.5) * 60); i < Math.round((t0 + 1.4) * 60); i++) m = Math.max(m, Math.abs(tr.cy[i] - tr.oy[i]));
  const iL = Math.round((t0 + 3.3) * 60), gap = Math.abs(tr.cx[iL] - tr.ox[iL]);
  ok(m <= 0.4 && gap <= 0.4, `${name.padEnd(20)} dy ${m.toFixed(2)} u, landing gap ${gap.toFixed(2)} u`);
}

console.log('\nE. analog steering on the platform: RMS distance of the screen from the solo prediction <= 0.15 u');
for (const name of ['RTT 400', 'RTT 400 ±80ms']) {
  const l = LINKS[name], t0 = T0(l);
  const steer = now => (now >= t0 && now < t0 + 2.5) ? { mx: 0.8 * Math.sin((now - t0) * 4.4), mz: 0.3, jump: false, dive: false, fire: false } : Z;
  let acc = 0; const NS = 8;
  for (let sd = 1; sd <= NS; sd++) {
    const tr = run({ ...l, seed: sd, script: steer, tEnd: t0 + 3.5 });
    let ss = 0, n = 0; for (let i = Math.round((t0 + 0.5) * 60); i < Math.round((t0 + 2.5) * 60); i++) { const d = Math.hypot(tr.cx[i] - tr.ox[i], tr.cz[i] - tr.oz[i]); ss += d * d; n++; }
    acc += Math.sqrt(ss / n);
  }
  ok(acc / NS <= 0.15, `${name.padEnd(20)} rms ${(acc / NS).toFixed(2)} u`);
}

console.log('\n' + (failures ? `PIPELINE: ${failures} FAILURE(S)` : 'PIPELINE: ALL PASS'));
process.exit(failures ? 1 : 0);
