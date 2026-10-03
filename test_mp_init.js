// Simulates the FIXED client mp_init flow in sim-race-webgl.html, incl. bots.
const Sim = require('./bonk/sim.js');

const seed = 12345;
const sim = Sim.create(seed);
sim.__mpSeed = seed;

const settings = { spinnerSpeed: 1.0, crumbleHold: 1.2, bounceForce: 17.5 };
for (const s of sim.solids) {
  if (s.kind === 'spin' && settings.spinnerSpeed !== undefined) s.om *= settings.spinnerSpeed;
  if (s.bounce && settings.bounceForce !== undefined) s.bounce = settings.bounceForce;
}

// roster as sent by the server (id order == addPlayer order)
const roster = [
  { id: 0, name: 'Host',    kind: 'zombie',  bot: false },
  { id: 1, name: 'Bot 1',   kind: 'robot',   bot: true },
  { id: 2, name: 'Bot 2',   kind: 'ghost',   bot: true },
  { id: 3, name: 'Guest',   kind: 'pumpkin', bot: false },
];
const me = 0;
sim.humanId = me;
for (const r of roster) sim.addPlayer({ name: r.name, bot: r.bot, kind: r.kind, skill: r.bot ? 0.8 : 0 });
sim.begin();

let jumps = 0, dives = 0, crashes = 0;
try {
  for (let i = 0; i < 60 * 20; i++) { // 20s: 3s countdown + 17s race
    const dt = 1 / 60;
    const me_ = sim.players[me];
    // press jump once grounded during race, press dive mid-race
    const jump = i === 240, dive = i >= 400 && i <= 600 && me_.stun <= 0 && me_.dead <= 0;
    sim.step(dt, { mx: 0, mz: 1, jump, dive, fire: false });
    if (jump && me_.vy > 8) jumps++; // jumped: vy just set to JUMP_V=9.8, gravity for one frame ~9.35
    if (dive && me_.diveT > 0) { dives++; }
    if (i % 300 === 0) {
      const p = sim.players[me];
      console.log(`t=${(i / 60).toFixed(1)} phase=${sim.phase} cd=${sim.cd.toFixed(2)} p.z=${p.z.toFixed(1)} vz=${p.vz.toFixed(1)} ground=${p.ground ? p.ground.name || 'solid' : 'null'}`);
    }
  }
} catch (e) { crashes++; console.error('CRASH:', e.message, e.stack.split('\n')[1]); }

const p = sim.players[me];
console.log(`\nphase=${sim.phase} raceT=${sim.raceT.toFixed(1)} z=${p.z.toFixed(1)} jumps=${jumps} dives=${dives} crashes=${crashes}`);
console.log('bot moved:', sim.players[1].z > 1, '| bot2 moved:', sim.players[2].z > 1);
if (crashes === 0 && sim.phase === 'race' && p.z > 1) console.log('\nCLIENT MP INIT FLOW: OK');
else console.log('\nCLIENT MP INIT FLOW: FAILED');
process.exit(crashes === 0 && p.z > 1 ? 0 : 1);
