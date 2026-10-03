const Sim = require('./bonk/sim.js');
const sim = Sim.create(123);
sim.addPlayer({});
console.log("Initial p.y:", sim.players[0].y);
sim.step(0.016, null);
console.log("After step p.y:", sim.players[0].y, "ground:", sim.players[0].ground ? sim.players[0].ground.name : 'null');
for(let i=0; i<10; i++) sim.step(0.016, null);
console.log("After 10 steps p.y:", sim.players[0].y, "ground:", sim.players[0].ground ? sim.players[0].ground.name : 'null');
