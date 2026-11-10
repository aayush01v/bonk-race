'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Sim = require('./bonk/sim.js');
// Exercise the real frame loop, input sampling, transport and simulation. Only
// rendering/audio after the physics/event section are omitted.
const html = fs.readFileSync('sim-race-webgl.html', 'utf8');
const inputStart = html.indexOf('const keys = Object.create(null)');
const inputEnd = html.indexOf("window.addEventListener('keydown'", inputStart);
const readStart = html.indexOf('function readInput()');
const readEnd = html.indexOf('\n}', readStart) + 2;
const netStart = html.indexOf('const INTERP_DELAY');
const netEnd = html.indexOf('/* ---------------- per-frame update');
const frameStart = html.indexOf('function update(dt, t)', netEnd);
const frameEnd = html.indexOf('  sim.ev.length = 0;', frameStart) + '  sim.ev.length = 0;'.length;
function setup() {
  const sim = Sim.create(42); sim.addPlayer({ bot:false }); sim.begin(); sim.phase='race';
  for(let i=0;i<10;i++)sim.step(1/60, {mx:0,mz:0});
  const events=[], sent=[], steps=[]; let now=1000;
  const realStep=sim.step;
  sim.step=(dt,input)=>{ steps.push({...input}); realStep(dt,input); };
  const code = html.slice(inputStart,inputEnd)+html.slice(readStart,readEnd)+html.slice(netStart,netEnd)+
    html.slice(frameStart,frameEnd)+'\n}\nreturn {update,pulse,clearInput,resetNet,touch};';
  const api=new Function('sim','Sim','TAU','clamp','performance','mpHost','onEvent','mode','paused','isMP','me',code)(
    sim,Sim,2*Math.PI,(v,a,b)=>Math.max(a,Math.min(b,v)),{now:()=>now},
    {postMessage:m=>sent.push(structuredClone(m))},e=>events.push({...e}),'play',false,true,0);
  return {sim,api,sent,events,steps,frame(dt){now+=dt*1000;api.update(dt,now/1000);}};
}
// A jump sent on a render-only frame must still execute locally on the next
// physics tick. Sweep the tap's phase relative to 60 Hz physics at common rates.
for(const hz of [60,90,120,144]) for(const action of ['jump','dive']) for(let phase=0;phase<6;phase++) {
  const h=setup(); for(let i=0;i<phase;i++)h.frame(1/hz);
  h.api.pulse[action]=true;
  for(let i=0;i<6;i++)h.frame(1/hz);
  assert.equal(h.sent.filter(m=>m.type==='mp_input'&&m.input[action]).length,1,`${hz} Hz ${action}: one wire pulse`);
  assert.equal(h.steps.filter(i=>i[action]).length,1,`${hz} Hz ${action} phase ${phase}: local pulse exactly once`);
  assert.equal(h.events.filter(e=>e.t===action).length,1,`${hz} Hz ${action}: action actually occurs`);
}
// Catch-up frames must not replay the pulse on every fixed step or change held input.
{
  const h=setup();h.api.touch.mz=1;h.api.touch.fire=true;h.api.pulse.jump=true;
  h.frame(1/30);
  assert.equal(h.steps.length,2);assert.equal(h.steps.filter(i=>i.jump).length,1);
  assert.ok(h.steps.every(i=>i.mz===1&&i.fire));
}
// Several zero-step frames still retain the action; reset/blur discards it.
for(const reset of [null,'clearInput','resetNet']) {
  const h=setup();h.api.pulse.jump=true;h.frame(0.001);h.frame(0.001);
  assert.equal(h.steps.length,0);
  if(reset)h.api[reset]();
  h.frame(1/60);
  assert.equal(h.events.filter(e=>e.t==='jump').length,reset?0:1);
}
console.log('INPUT FRAME TIMING: all jump/dive and reset regressions pass');
