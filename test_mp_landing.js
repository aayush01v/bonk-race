'use strict';
// Run the shipped state handler, not a hand-maintained imitation of it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Sim = require('./bonk/sim.js');
const html = fs.readFileSync('sim-race-webgl.html', 'utf8');
const block = html.slice(html.indexOf('const INTERP_DELAY'), html.indexOf('/* ---------------- per-frame update'));
const start = html.indexOf("else if (e.data.type === 'mp_state' && sim) {");
const end = html.indexOf("else if (e.data.type === 'mp_events' && sim)", start);
const handler = html.slice(html.indexOf('{', start) + 1, end).trim().replace(/}\s*$/, '');
const neutral = { mx: 0, mz: 0, jump: false, dive: false, fire: false };
function setup() {
  const sim = Sim.create(42); sim.addPlayer({ bot: false }); sim.begin(); sim.phase = 'race';
  sim.t = 80; sim.step(1 / 60, neutral);
  const p = sim.players[0]; p._serverLife = true;
  const g = sim.solids.find(s => s.kind === 'slide');
  Object.assign(p, { x: g.cx, y: g.cy + g.hy, z: g.cz, ground: g, dead: 0, vy: 0 });
  let now = 10000; const events = [];
  const api = new Function('sim', 'me', 'Sim', 'TAU', 'clamp', 'performance', 'mpHost', 'onEvent',
    block + '\nreturn {applyNet, ownHist, sendMPInput, resetNet, receive(e) {' + handler +
    '}, prime() {lastNetPhase="race"; needHardSnapMe=false;}, get snaps(){return netStats.snaps;} };')(
      sim, 0, Sim, Math.PI * 2, (v,a,b)=>Math.max(a,Math.min(b,v)),
      { now:()=>now }, { postMessage(){} }, e=>events.push(e));
  api.prime();
  function deliver(overrides = {}) {
    const q = Object.assign({ x:g.cx,y:g.cy+g.hy,z:g.cz,vx:0,vy:0,vz:0,ground:g.id,dead:0,ack:10.0,falls:0 }, overrides);
    const a = [q.x*100,q.y*100,q.z*100,q.vx*10,q.vy*10,q.vz*10,0,q.ground,0,0,q.dead*100,0,0,0,0,0,0,q.falls,0,q.ack*1000];
    api.receive({data:{data:{t:(sim.t-0.1)*1000,raceT:0,phase:'race',cd:0,finishCount:0,pl:[a],tl:[],bl:[],pk:[]}}});
  }
  return {sim,p,g,api,events,deliver,clock(t){now=t*1000;}};
}
// Reproduce a missed moving-platform landing within the old 8-unit snap threshold.
for (const newerJump of [false, true]) {
  const {p,g,sim,api,deliver,clock} = setup();
  Object.assign(p,{ground:null,y:g.cy+g.hy-1.2,vy:-6});
  for(const w of [9.98,10.04]) api.ownHist.push({w,x:p.x,y:p.y,z:p.z,g:false,vx:0,vy:-6,vz:0});
  if(newerJump) {clock(10.1);api.sendMPInput({...neutral,jump:true},10.1);}
  clock(10.2);
  const sampleT=sim.t-0.1, sampleX=g.cx;
  const expectedX=sampleX+g.cx-(g.b.cx+g.ax*Math.sin(sampleT*g.w+g.ph));
  deliver();api.applyNet(1/60);
  if(newerJump) {assert.equal(api.snaps,0);assert.equal(p.ground,null);}
  else {
    assert.equal(api.snaps,1, "acknowledged missed landing must recover before the kill plane");
    assert.ok(Math.abs(p.x-expectedX)<1e-8, "grounded correction follows moving platform pose");assert.equal(p.ground,g);assert.equal(p.vy,0);
    assert.ok(Math.abs(p.y-(g.cy+g.hy))<1e-8);
    const old=sim.solidPose(g.id,sim.t-0.1); // verify recovery is on platform, not below it
    assert.ok(Number.isFinite(old.cx));
    sim.step(1/60,neutral);assert.equal(p.ground,g);assert.equal(p._pendingFall,false);
  }
}
// False local fall: no premature checkpoint message, stale alive packet cannot
// resolve it, acknowledged alive packet restores contact, no independent respawn.
{
  const {sim,p,api,deliver,events,clock,g}=setup();
  Object.assign(p,{x:100,y:-10,ground:null,vy:-10});sim.step(1/60,neutral);
  assert.equal(p._pendingFall,true);assert.equal(p.dead,0);assert.equal(p.falls,0);
  assert.equal(sim.ev.some(e=>e.t==='fall'),false);
  clock(10.2);deliver({ack:10});api.applyNet(1/60);
  assert.equal(p._pendingFall,true);assert.equal(events.length,0);
  for(let i=0;i<180;i++)sim.step(1/60,neutral);
  assert.equal(p._pendingFall,true);assert.equal(p.x,100);
  clock(13.3);deliver({ack:13.2});api.applyNet(1/60);
  assert.equal(p._pendingFall,false);assert.equal(p.dead,0);assert.equal(p.ground,g);
  assert.equal(events.length,0);
}
// Genuine server death is announced once; missing packets cannot locally respawn.
{
  const {sim,p,api,deliver,events,clock}=setup();
  clock(10.2);deliver({dead:1,ground:-1,y:-10,ack:10.1,falls:1});api.applyNet(1/60);
  for(let i=0;i<120;i++)sim.step(1/60,neutral);
  assert.equal(p.dead,1);assert.equal(events.filter(e=>e.t==='fall').length,1);
  deliver({dead:0.5,ground:-1,y:-10,ack:10.2,falls:1});api.applyNet(1/60);
  assert.equal(events.length,1);
  deliver({dead:0,ack:12,falls:1});api.applyNet(1/60);
  assert.equal(p.dead,0);assert.ok(p.y>-9);assert.equal(p.falls,1);
  sim.reset('race');assert.equal(p._pendingFall,false);
}
// Server and solo mode still commit falls and respawn without network messages.
{
  const s=Sim.create(1);const p=s.addPlayer({bot:false});s.begin();s.phase='race';
  Object.assign(p,{x:100,y:-10,ground:null});s.step(1/60,neutral);
  assert.ok(p.dead>0);assert.equal(p.falls,1);
  for(let i=0;i<90;i++)s.step(1/60,neutral);
  assert.equal(p.dead<=0,true);assert.ok(p.y>-9);
}
console.log('LANDING/FALL: all behavioral regressions pass');
