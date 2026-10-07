// End-to-end test of the stamped-input pipeline against the REAL mp-server over WebSockets:
//  - snapshots carry `ack` (client-stamp time) for the human's row, monotonic and never ahead of what was sent
//  - a hold of exactly H seconds (stamp time) moves the player for H seconds on the server even when every
//    packet is delayed by random jitter — i.e. durations are reproduced (the old "apply on arrival" path is
//    printed for comparison)
//  - garbage / flood input can't crash the server or the queue
const { spawn } = require('child_process');
const WebSocket = require('ws');
const Sim = require('./bonk/sim.js');
const { performance } = require('perf_hooks');

const PORT = 8132, URL = `ws://localhost:${PORT}/ws`;
let failures = 0;
const ok = (c, l) => { console.log((c ? '  PASS  ' : '  FAIL  ') + l); if (!c) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => performance.now() / 1000;

function makeClient(name) {
  const c = { ws: new WebSocket(URL), states: [], raceStart: null, joined: null, alive: true };
  c.ws.on('open', () => c.ws.send(JSON.stringify({ type: 'setName', name, kind: 'zombie' })));
  c.ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'joined') c.joined = m;
    else if (m.type === 'raceStart') c.raceStart = m;
    else if (m.type === 'state') c.states.push({ at: now(), t: m.t / 1000, x: m.pl[0][0] / 100, z: m.pl[0][2] / 100, y: m.pl[0][1] / 100, ack: m.pl[0][19] });
  });
  c.ws.on('close', () => { c.alive = false; });
  c.send = o => c.ws.readyState === WebSocket.OPEN && c.ws.send(JSON.stringify({ type: 'input', ...o }));
  return c;
}

// reference: hold +x for n server ticks, then release; final x after settling
function refHoldTicks(seed, n) {
  const S = Sim.create(seed);
  S.addPlayer({ name: 'p', bot: false, kind: 'zombie', skill: 0 });
  S.humanId = -1; S.begin();
  const NEUT = { mx: 0, mz: 0, jump: false, dive: false, fire: false };
  for (let i = 0; i < 90 + 5; i++) { S.players[0]._mpInput = NEUT; S.step(1 / 30, null); }  // countdown
  const x0 = S.players[0].x;
  for (let i = 0; i < n; i++) { S.players[0]._mpInput = { mx: 1, mz: 0, jump: false, dive: false, fire: false }; S.step(1 / 30, null); }
  for (let i = 0; i < 60; i++) { S.players[0]._mpInput = NEUT; S.step(1 / 30, null); }
  return S.players[0].x - x0;
}

async function holdTest(srvLabel, stamped, jitterMs, H) {
  const cl = makeClient('P'); await sleep(250);
  cl.ws.send(JSON.stringify({ type: 'create', settings: { botCount: 0, maxPlayers: 4 } })); await sleep(250);
  cl.ws.send(JSON.stringify({ type: 'start' })); await sleep(300);
  const seed = cl.raceStart.seed;
  await sleep(3400);                                   // countdown
  const x0 = cl.states[cl.states.length - 1].x;
  // schedule: one stamped message per change + 100 ms keep-alives, each sent after a random delay
  // (order preserved like TCP); the stamp is taken when the message is CREATED, not when it is sent
  const msgs = [];
  const t0 = now() + 0.05;
  for (let k = 0; k * 0.1 < H; k++) msgs.push({ t: t0 + k * 0.1, mx: 1, mz: 0 });
  msgs.push({ t: t0 + H, mx: 0, mz: 0 });
  let prevDue = 0;
  for (const m of msgs) {
    const create = (m.t - now()) * 1000; await sleep(Math.max(0, create));
    const due = Math.max(prevDue, now() * 1000 + Math.random() * jitterMs); prevDue = due;
    const out = { mx: m.mx, mz: m.mz, fire: false, jump: false, dive: false }; if (stamped) out.t = m.t;
    setTimeout(() => cl.send(out), Math.max(0, due - now() * 1000));
  }
  await sleep(jitterMs + 1800);                        // let the last packet land and the player settle
  const last = cl.states[cl.states.length - 1];
  const travelled = last.x - x0;
  const acks = cl.states.map(s => s.ack).filter(a => a > 0);
  cl.ws.close();
  return { seed, travelled, acks, states: cl.states.length };
}

async function main() {
  const srv = spawn('node', ['mp-server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; srv.stdout.on('data', d => out += d); srv.stderr.on('data', d => out += d);
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`http://localhost:${PORT}/api/rooms`)).ok; } catch (_) { await sleep(100); } }
  if (!up) { console.log(out); console.error('server never came up'); srv.kill(); process.exit(1); }

  const H = 0.6;
  // 1) stamped, no jitter
  const a = await holdTest('stamped/0ms', true, 0, H);
  const lo = refHoldTicks(a.seed, Math.round(H * 30) - 1) - 0.08, hi = refHoldTicks(a.seed, Math.round(H * 30) + 1) + 0.08;
  console.log(`hold ${H}s, no jitter: server travelled ${a.travelled.toFixed(2)} u (reference window ${lo.toFixed(2)}..${hi.toFixed(2)})`);
  ok(a.travelled >= lo && a.travelled <= hi, 'stamped hold reproduces its duration (no jitter)');
  ok(a.acks.length > 20, `snapshots carry an ack for the human row (${a.acks.length} of ${a.states})`);
  let mono = true; for (let i = 1; i < a.acks.length; i++) if (a.acks[i] < a.acks[i - 1]) mono = false;
  ok(mono, 'ack is monotonic');

  // 2) stamped with 0-140 ms random delay on every packet
  const b = await holdTest('stamped/140ms', true, 140, H);
  const lo2 = refHoldTicks(b.seed, Math.round(H * 30) - 1) - 0.08, hi2 = refHoldTicks(b.seed, Math.round(H * 30) + 1) + 0.08;
  // the buffer's first-packet estimate can be ~jitter high, so allow a little more
  const tol = 0.7;
  console.log(`hold ${H}s, 0-140 ms jitter (stamped): server travelled ${b.travelled.toFixed(2)} u (window ${lo2.toFixed(2)}..${hi2.toFixed(2)} +-${tol})`);
  ok(b.travelled >= lo2 - tol && b.travelled <= hi2 + tol, 'stamped hold keeps its duration under jitter (within the buffer tolerance)');

  // 3) same jitter, un-stamped (legacy apply-on-arrival) — informational comparison
  const c = await holdTest('legacy/140ms', false, 140, H);
  console.log(`hold ${H}s, 0-140 ms jitter (legacy, un-stamped): server travelled ${c.travelled.toFixed(2)} u  [error vs ideal ${Math.abs(c.travelled - (lo2 + hi2) / 2).toFixed(2)} u; stamped error ${Math.abs(b.travelled - (lo2 + hi2) / 2).toFixed(2)} u]`);

  // 4) garbage + flood
  const g = makeClient('G'); await sleep(250);
  g.ws.send(JSON.stringify({ type: 'create', settings: { botCount: 0, maxPlayers: 4 } })); await sleep(250);
  g.ws.send(JSON.stringify({ type: 'start' })); await sleep(3800);
  const junk = [{ mx: 1e9, mz: -1e9, t: now() }, { mx: 'x', mz: null, t: now() }, { mx: 1, mz: 0, t: 'x' }, { mx: 1, mz: 0, t: -5 }, { mx: 1, mz: 0, t: 1e12 }, { t: now() }, {}, { mx: [], mz: {}, t: now() }];
  for (const j of junk) g.send(j);
  for (let i = 0; i < 6000; i++) g.send({ mx: 1, mz: 0, fire: false, jump: false, dive: false, t: now() + i * 1e-4 });
  const n0 = g.states.length; await sleep(700);
  ok(g.alive && g.states.length > n0 + 10, 'server survives garbage + a 6000-packet flood and keeps streaming');
  g.ws.close();
  srv.kill();
  console.log(failures ? `\nACK E2E: ${failures} FAILURE(S)` : '\nACK E2E: ALL PASS');
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
