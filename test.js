const fs = await import("node:fs");
const simSrc = fs.readFileSync("bonk/sim.js", "utf8");

// Mock module for CommonJS
const module = { exports: {} };
eval(simSrc);
const Sim = module.exports;

const sim = Sim.create(12345);
const p = sim.addPlayer({ name: 'Human', bot: false, kind: 'zombie', skill: 0 });

sim.begin();

console.log("Phase: " + sim.phase);
console.log("Initial p.z: " + p.z);

// 200 ticks of 0.05s = 10 seconds
for (let i = 0; i <= 200; i++) { 
  const dt = 0.05;
  p._mpInput = { mx: 0, mz: -1, jump: false, dive: false, fire: false };
  sim.step(dt, null);
  
  if (i % 20 === 0) {
    console.log(`Tick ${i}: phase=${sim.phase}, cd=${sim.cd.toFixed(2)}, raceT=${sim.raceT.toFixed(2)}, p.z=${p.z.toFixed(2)}, p.vz=${p.vz.toFixed(2)}, canAct=${sim.phase === 'race' && !p.finished}`);
  }
}
