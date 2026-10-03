/* ======================================================================
   GAME - input, camera, HUD, audio and drawing wrapped around the Sim.
   sim.js is used exactly as written: this file reads its state every
   frame and feeds it { mx, mz, jump, dive, fire } for the human racer.
   ====================================================================== */
(() => {
'use strict';
const $ = id => document.getElementById(id);

function errBar(msg) {
  let b = $('errBar');
  if (!b) {
    b = document.createElement('div'); b.id = 'errBar';
    b.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:99;background:#fff;color:#2a1a5e;border:3px solid #2a1a5e;border-radius:14px;padding:8px 12px;font:700 12px/1.35 system-ui,sans-serif;pointer-events:none';
    document.body.appendChild(b);
  }
  b.textContent = 'Error: ' + msg;
}
window.addEventListener('error', ev => errBar(ev.message || 'unknown error'));

const G = typeof GFX !== 'undefined' ? GFX : null;
if (!G) {
  $('errMsg').textContent = "This browser couldn't start WebGL, which the game needs to draw. Try Chrome, Safari or Firefox with hardware acceleration turned on." +
    (window.__gfxError ? ' (' + window.__gfxError + ')' : '');
  $('err').classList.remove('hidden'); $('menu').classList.add('hidden');
  return;
}

const M = G.mesh, rgb = G.rgb;
const { push, pop, translate, scale, rotX, rotY, draw } = G;

/* ---------------- helpers ---------------- */
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const damp = (k, dt) => 1 - Math.exp(-k * dt);
const rr = (a, b) => a + Math.random() * (b - a);
const ord = n => { const v = n % 100; return n + (v > 10 && v < 14 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10 < 4 ? n % 10 : 0]); };
const fmt = t => {
  const q = Math.max(0, Math.floor(t * 10)), m = Math.floor(q / 600), s = Math.floor((q % 600) / 10);
  return m + ':' + (s < 10 ? '0' : '') + s + '.' + (q % 10);
};
const tint = (c, k) => [c[0] + (1 - c[0]) * k, c[1] + (1 - c[1]) * k, c[2] + (1 - c[2]) * k];
const setText = (n, s) => { if (n._s !== s) { n._s = s; n.textContent = s; } };

const INK = [0.165, 0.102, 0.369], BLACK = [0, 0, 0], WHITE = [1, 1, 1];
const YELLOW = [1, 0.82, 0.25], YELLOW_EM = [0.45, 0.36, 0.04];
const MINT = [0.37, 0.95, 0.65], DUST = [0.96, 0.93, 1];
const CLOUD = [1, 1, 1], CLOUD_EM = [0.30, 0.30, 0.36], PAD_EM = [0.16, 0.48, 0.30];
const HUB = [1, 0.82, 0.25], HOUSE = [0.72, 0.22, 0.42], ROD = [0.86, 0.86, 0.93], POLE = [0.32, 0.26, 0.55];
const CONF = [[1, .56, .72], [1, .82, .25], [.44, .89, .72], [.72, .61, 1], [.55, .83, 1], [1, .48, .35]];

const KINDS = {
  zombie:  { name: 'Zombie',    c: '#8fd16a', hat: 'none' },
  pumpkin: { name: 'Pumpkin',   c: '#ff9a3d', hat: 'stem', hc: [0.28, 0.66, 0.30] },
  ghost:   { name: 'Ghost',     c: '#efe9ff', hat: 'tuft' },
  robot:   { name: 'Robot',     c: '#8bd3ff', hat: 'antenna' },
  gum:     { name: 'Bubblegum', c: '#ff8fb8', hat: 'party' },
  banana:  { name: 'Banana',    c: '#ffd23f', hat: 'stem', hc: [0.52, 0.36, 0.18] }
};
const KIND_IDS = Object.keys(KINDS);
KIND_IDS.forEach(k => { KINDS[k].rgb = rgb(KINDS[k].c); KINDS[k].lite = tint(KINDS[k].rgb, 0.35); });

/* ---------------- audio (tiny WebAudio synth, no files) ---------------- */
let ac = null, master = null, muted = false, noiseBuf = null;
function audioInit() {
  try {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ac = new AC(); master = ac.createGain(); master.gain.value = 0.32; master.connect(ac.destination);
    }
    if (ac.state === 'suspended') ac.resume();
  } catch (e) { ac = null; }
}
function tone(type, f0, f1, dur, vol, delay) {
  if (!ac || muted || vol < 0.01) return;
  const t = ac.currentTime + (delay || 0), o = ac.createOscillator(), g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.03);
}
function noise(dur, vol, freq) {
  if (!ac || muted || vol < 0.01) return;
  if (!noiseBuf) {
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = ac.currentTime, s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
  s.buffer = noiseBuf; f.type = 'lowpass'; f.frequency.value = freq;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(g); g.connect(master); s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.03);
}
const sfx = {
  jump: v => tone('sine', 300, 700, 0.14, 0.5 * v),
  dive: v => { tone('sawtooth', 260, 90, 0.22, 0.22 * v); noise(0.2, 0.25 * v, 1800); },
  land: (v, p) => tone('sine', 140, 50, 0.14, Math.min(0.6, p / 25) * v),
  bounce: v => tone('sine', 180, 900, 0.3, 0.55 * v),
  fire: v => tone('square', 820, 180, 0.11, 0.18 * v),
  bonk: v => { tone('triangle', 240, 60, 0.2, 0.7 * v); noise(0.12, 0.35 * v, 900); },
  pickup: v => { tone('sine', 660, 660, 0.09, 0.4 * v); tone('sine', 990, 990, 0.14, 0.4 * v, 0.07); },
  cp: () => { tone('triangle', 523, 523, 0.1, 0.4); tone('triangle', 784, 784, 0.18, 0.4, 0.09); },
  fall: v => tone('sine', 700, 70, 0.6, 0.5 * v),
  rumble: v => noise(0.35, 0.4 * v, 300),
  beep: () => tone('square', 440, 440, 0.16, 0.28),
  go: () => tone('square', 880, 880, 0.4, 0.3),
  finish: () => [523, 659, 784, 1047].forEach((f, i) => tone('triangle', f, f, 0.22, 0.45, i * 0.1))
};

/* ---------------- particles (one point-sprite draw call) ---------------- */
const NP = 380;
const P = {
  x: new Float32Array(NP), y: new Float32Array(NP), z: new Float32Array(NP),
  vx: new Float32Array(NP), vy: new Float32Array(NP), vz: new Float32Array(NP),
  life: new Float32Array(NP), max: new Float32Array(NP), size: new Float32Array(NP),
  r: new Float32Array(NP), g: new Float32Array(NP), b: new Float32Array(NP),
  grav: new Float32Array(NP), grow: new Float32Array(NP), head: 0
};
const pdata = new Float32Array((NP + 48) * 8);
let pn = 0;
function spawn(x, y, z, vx, vy, vz, life, size, col, grav, grow) {
  const i = P.head; P.head = (i + 1) % NP;
  P.x[i] = x; P.y[i] = y; P.z[i] = z; P.vx[i] = vx; P.vy[i] = vy; P.vz[i] = vz;
  P.life[i] = P.max[i] = life; P.size[i] = size; P.r[i] = col[0]; P.g[i] = col[1]; P.b[i] = col[2];
  P.grav[i] = grav; P.grow[i] = grow;
}
function dust(x, y, z, n, spd) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, s = spd * rr(0.4, 1);
    spawn(x + Math.cos(a) * 0.25, y + 0.1, z + Math.sin(a) * 0.25, Math.cos(a) * s, rr(0.4, 1.4), Math.sin(a) * s, rr(0.35, 0.65), 0.55, DUST, 0, 1.6);
  }
}
function burst(x, y, z, n, col, spd, size, life, grav) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, e = rr(-0.3, 1), s = spd * rr(0.5, 1), c = Math.sqrt(1 - e * e);
    spawn(x, y, z, Math.cos(a) * s * c, e * s + 1, Math.sin(a) * s * c, life * rr(0.6, 1), size, col, grav, -0.5);
  }
}
function confetti(x, y, z, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, s = rr(1.5, 6);
    spawn(x, y, z, Math.cos(a) * s, rr(5, 11), Math.sin(a) * s, rr(1.2, 2.0), 0.26, CONF[i % CONF.length], 11, -0.3);
  }
}
function stepParticles(dt) {
  const drag = Math.exp(-2.2 * dt);
  for (let i = 0; i < NP; i++) {
    if (P.life[i] <= 0) continue;
    P.life[i] -= dt;
    P.vy[i] -= P.grav[i] * dt;
    P.x[i] += P.vx[i] * dt; P.y[i] += P.vy[i] * dt; P.z[i] += P.vz[i] * dt;
    P.vx[i] *= drag; P.vz[i] *= drag;
  }
}
function packParticles() {
  pn = 0;
  for (let i = 0; i < NP; i++) {
    if (P.life[i] <= 0) continue;
    const k = P.life[i] / P.max[i], o = pn++ * 8;
    pdata[o] = P.x[i]; pdata[o + 1] = P.y[i]; pdata[o + 2] = P.z[i];
    pdata[o + 3] = P.r[i]; pdata[o + 4] = P.g[i]; pdata[o + 5] = P.b[i];
    pdata[o + 6] = Math.min(1, k * 1.6);
    pdata[o + 7] = P.size[i] * (1 + P.grow[i] * (1 - k));
  }
}
function glow(x, y, z, col, a, size) {
  if (pn >= NP + 46) return;
  const o = pn++ * 8;
  pdata[o] = x; pdata[o + 1] = y; pdata[o + 2] = z; pdata[o + 3] = col[0]; pdata[o + 4] = col[1]; pdata[o + 5] = col[2];
  pdata[o + 6] = a; pdata[o + 7] = size;
}

/* ---------------- scenery that is not part of the sim ---------------- */
const clouds = [];
(() => {
  let s = 9127;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 20; i++) {
    const side = i % 2 ? 1 : -1, sc = 2.5 + r() * 4;
    clouds.push({ x: side * (18 + r() * 50), y: -8 + r() * 36, z: -30 + r() * 260, s: sc, ph: r() * TAU,
      b: [[0, 0, 0, 1], [1.15, -0.1, 0.25, 0.72], [-1.05, -0.15, -0.2, 0.8]] });
  }
})();

/* ---------------- game state ---------------- */
let myKind = 'zombie', sim = null, me = 0, vis = [], dots = [], flags = [], mode = 'menu', best = null;
let lastN = 0, resultsAt = 0, resultsShown = false, listT = 0, touchOn = false, veilOn = false, paused = false;
const cam = { x: 0, y: 0, z: 0, init: false, shake: 0, fov: 60 };

function makeSim() {
  const s = Sim.create((Math.random() * 1e9) | 0);
  const others = KIND_IDS.filter(k => k !== myKind);
  const skills = [0.6, 0.72, 0.82, 0.88, 0.66];
  [0, 1, -1, 2, 3, 4].forEach(o => {
    if (o < 0) s.humanId = s.addPlayer({ name: 'You', bot: false, kind: myKind }).id;
    else s.addPlayer({ name: KINDS[others[o]].name, bot: true, kind: others[o], skill: skills[o] });
  });
  return s;
}
function attach(s) {
  sim = s; me = s.humanId;
  vis = s.players.map(() => ({ phase: Math.random() * TAU, squash: 0, dust: 0 }));
  flags = [];
  for (let i = 1; i < s.cps.length; i++) {
    const sl = s.solids.find(o => o.cp === i);
    if (sl) flags.push({ i, x: sl.cx - (sl.hx - 0.6), y: sl.cy + sl.hy, z: sl.cz - sl.hz + 1.2 });
  }
  const fin = s.solids.find(o => o.name === 'finish'), sta = s.solids.find(o => o.name === 'start');
  world.finishTop = fin ? fin.cy + fin.hy : 3; world.startTop = sta ? sta.cy + sta.hy : 0;
  P.life.fill(0);
}
const world = { finishTop: 3, startTop: 0 };

function courseY(z) {
  const c = sim.cps;
  if (z <= c[0].z) return c[0].y;
  for (let i = 1; i < c.length; i++) {
    if (z <= c[i].z) return c[i - 1].y + (c[i].y - c[i - 1].y) * ((z - c[i - 1].z) / (c[i].z - c[i - 1].z));
  }
  return c[c.length - 1].y;
}

function groundBelow(x, z, maxY) {
  let best = null;
  for (const s of sim.solids) {
    if (!s.active) continue;
    const top = s.cy + s.hy;
    if (top > maxY) continue;
    const dx = x - s.cx, dz = z - s.cz, rr2 = s.rad + 0.3;
    if (dx * dx + dz * dz > rr2 * rr2) continue;
    const c = Math.cos(s.yaw), n = Math.sin(s.yaw);
    if (Math.abs(dx * c - dz * n) <= s.hx + 0.1 && Math.abs(dx * n + dz * c) <= s.hz + 0.1 && (best === null || top > best)) best = top;
  }
  return best;
}

/* ---------------- input ---------------- */
const keys = Object.create(null), pulse = { jump: false, dive: false }, touch = { mx: 0, mz: 0, fire: false };
const KEYMAP = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', KeyF: 'fire', KeyJ: 'fire' };
const clearInput = () => { for (const k in keys) keys[k] = false; pulse.jump = pulse.dive = false; touch.mx = touch.mz = 0; touch.fire = false; };

window.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const c = e.code, k = KEYMAP[c], onBtn = document.activeElement && document.activeElement.tagName === 'BUTTON';
  if (mode === 'play') {
    if (k) { keys[k] = true; e.preventDefault(); return; }
    if (c === 'Space') { e.preventDefault(); if (!e.repeat) pulse.jump = true; return; }
    if (c === 'ShiftLeft' || c === 'ShiftRight' || c === 'KeyK') { e.preventDefault(); if (!e.repeat) pulse.dive = true; return; }
    if (c === 'KeyR' && !e.repeat) { startGame(); return; }
    if (c === 'Escape' && !e.repeat) { goMenu(); return; }
    if (c === 'Enter' && resultsShown && !onBtn) startGame();
  } else if ((c === 'Enter' || c === 'Space') && !onBtn && !e.repeat) { e.preventDefault(); startGame(); }
});
window.addEventListener('keyup', e => { const k = KEYMAP[e.code]; if (k) keys[k] = false; });
window.addEventListener('blur', clearInput);
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('button'); if (b) b.blur(); });

function readInput() {
  let mx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0) + touch.mx;
  let mz = (keys.up ? 1 : 0) - (keys.down ? 1 : 0) + touch.mz;
  const m = Math.hypot(mx, mz);
  if (m > 1) { mx /= m; mz /= m; }
  return { mx, mz, jump: pulse.jump, dive: pulse.dive, fire: !!(keys.fire || touch.fire) };
}

function enableTouch() {
  if (touchOn) return;
  touchOn = true; document.body.classList.add('touch');
  if (mode === 'play') $('touch').classList.remove('hidden');
}
if ((window.matchMedia && matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window) enableTouch();
window.addEventListener('pointerdown', e => { if (e.pointerType === 'touch') enableTouch(); }, { passive: true });

(() => {
  const zone = $('joyZone'), base = $('joyBase'), knob = $('joyKnob'), R = 52;
  let id = null, x0 = 0, y0 = 0;
  const move = e => {
    let dx = e.clientX - x0, dy = e.clientY - y0;
    const d = Math.hypot(dx, dy);
    if (d > R) { dx *= R / d; dy *= R / d; }
    knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    if (d < 8) { touch.mx = touch.mz = 0; return; }
    touch.mx = clamp(dx / (R * 0.8), -1, 1); touch.mz = clamp(-dy / (R * 0.8), -1, 1);
  };
  const end = e => {
    if (id === null || (e && e.pointerId !== id)) return;
    id = null; touch.mx = touch.mz = 0; base.style.opacity = 0; knob.style.transform = '';
  };
  zone.addEventListener('pointerdown', e => {
    if (id !== null) return;
    id = e.pointerId; try { zone.setPointerCapture(id); } catch (_) {}
    x0 = e.clientX; y0 = e.clientY;
    base.style.left = x0 + 'px'; base.style.top = y0 + 'px'; base.style.opacity = 1;
    move(e); e.preventDefault();
  });
  zone.addEventListener('pointermove', e => { if (e.pointerId === id) { move(e); e.preventDefault(); } });
  zone.addEventListener('pointerup', end); zone.addEventListener('pointercancel', end); zone.addEventListener('lostpointercapture', end);

  const hold = (node, on, off) => {
    node.addEventListener('pointerdown', e => { e.preventDefault(); try { node.setPointerCapture(e.pointerId); } catch (_) {} node.classList.add('down'); on(); });
    const up = () => { node.classList.remove('down'); if (off) off(); };
    node.addEventListener('pointerup', up); node.addEventListener('pointercancel', up); node.addEventListener('lostpointercapture', up);
  };
  hold($('bJump'), () => { pulse.jump = true; });
  hold($('bDive'), () => { pulse.dive = true; });
  hold($('bFire'), () => { touch.fire = true; }, () => { touch.fire = false; });
})();

/* ---------------- HUD ---------------- */
const el = {
  menu: $('menu'), hud: $('hud'), touch: $('touch'), results: $('results'), placeN: $('placeN'), placeOf: $('placeOf'),
  timer: $('timer'), track: $('track'), ammo: $('ammo'), count: $('count'), toast: $('toast'), veil: $('veil'),
  resHead: $('resHead'), resSub: $('resSub'), resList: $('resList')
};
const pips = Array.from(el.ammo.querySelectorAll('i'));
let countTimer = 0;
function showCount(txt, cls) {
  const n = el.count;
  n.className = 'outline ' + cls; n.textContent = txt;
  void n.offsetWidth; n.classList.add('pop');
  clearTimeout(countTimer); countTimer = setTimeout(() => { n.textContent = ''; }, 950);
}
function toast(msg) {
  const n = el.toast; n.textContent = msg;
  n.classList.remove('show'); void n.offsetWidth; n.classList.add('show');
}
function buildDots() {
  el.track.textContent = '';
  dots = sim.players.map(p => {
    const d = document.createElement('div');
    d.className = 'dot' + (p.id === me ? ' me' : ''); d.style.setProperty('--c', KINDS[p.kind].c);
    el.track.appendChild(d); return d;
  });
}
function updateHud() {
  const p = sim.players[me], counting = sim.phase === 'countdown';
  const pl = sim.ranking().indexOf(p) + 1;
  setText(el.placeN, counting ? 'Ready' : ord(pl));
  setText(el.placeOf, counting ? '' : '/ ' + sim.players.length);
  setText(el.timer, fmt(p.finished ? p.finishT : Math.max(0, sim.raceT)));
  for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('on', i < p.ammo);
  for (const q of sim.players) dots[q.id].style.left = (clamp(q.z / sim.finishZ, 0, 1) * 100).toFixed(1) + '%';
}
function fillResList() {
  const ul = el.resList; ul.textContent = '';
  sim.ranking().forEach((q, i) => {
    const li = document.createElement('li'); if (q.id === me) li.className = 'me';
    const a = document.createElement('span'); a.textContent = i + 1;
    const d = document.createElement('i'); d.style.setProperty('--c', KINDS[q.kind].c);
    const n = document.createElement('span'); n.textContent = q.id === me ? 'You' : q.name;
    const t = document.createElement('em'); t.textContent = q.finished ? fmt(q.finishT) : 'racing...';
    li.append(a, d, n, t); ul.appendChild(li);
  });
}
function showResults() {
  resultsShown = true;
  const p = sim.players[me];
  el.resHead.textContent = p.place === 1 ? 'You won!' : ord(p.place) + ' place';
  let sub = 'Time ' + fmt(p.finishT);
  if (best !== null && p.finishT > best + 0.05) sub += '  -  best ' + fmt(best);
  el.resSub.textContent = sub;
  fillResList(); listT = 0;
  el.touch.classList.add('hidden');
  el.results.classList.remove('hidden');
}

/* ---------------- flow ---------------- */
function startGame() {
  audioInit();
  attach(makeSim()); sim.begin();
  mode = 'play'; cam.init = false; cam.shake = 0; lastN = 0; resultsAt = 0; resultsShown = false;
  clearInput();
  el.menu.classList.add('hidden'); el.results.classList.add('hidden'); el.hud.classList.remove('hidden');
  el.touch.classList.toggle('hidden', !touchOn);
  veilOn = false; el.veil.classList.remove('on'); el.count.textContent = ''; el.ammo.classList.remove('hidden');
  buildDots(); try { window.focus(); } catch (_) {}
}
function goMenu() {
  mode = 'menu'; attach(makeSim()); clearInput(); resultsShown = false;
  el.hud.classList.add('hidden'); el.touch.classList.add('hidden'); el.results.classList.add('hidden');
  el.menu.classList.remove('hidden'); veilOn = false; el.veil.classList.remove('on');
}

(() => {
  const picker = $('picker');
  KIND_IDS.forEach(id => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.dataset.k = id; b.setAttribute('role', 'radio'); b.setAttribute('aria-label', KINDS[id].name);
    b.style.setProperty('--c', KINDS[id].c);
    b.addEventListener('click', () => pick(id)); picker.appendChild(b);
  });
})();
function pick(id) {
  myKind = id; sim = null;
  document.querySelectorAll('.chip').forEach(b => b.setAttribute('aria-checked', String(b.dataset.k === id)));
  setText($('pickName'), KINDS[id].name);
  attach(makeSim());
}
$('btnPlay').addEventListener('click', startGame);
$('btnAgain').addEventListener('click', startGame);
$('btnMenu').addEventListener('click', goMenu);
$('btnRestart').addEventListener('click', startGame);
$('btnMute').addEventListener('click', e => { muted = !muted; e.currentTarget.classList.toggle('off', muted); audioInit(); });

/* ---------------- sim events -> sound, particles, toasts ---------------- */
function shake(a) { cam.shake = Math.max(cam.shake, a); }
function onEvent(e) {
  const p = sim.players[me], mine = e.id === me;
  let near = 1;
  if (!mine) {
    const d = Math.hypot(e.x - p.x, e.y - p.y, e.z - p.z);
    near = clamp(1 - d / 26, 0, 1); near *= near;
  }
  const v = vis[e.id];
  switch (e.t) {
    case 'jump': dust(e.x, e.y, e.z, 4, 0.5); sfx.jump(near); break;
    case 'dive': dust(e.x, e.y + 0.3, e.z, 6, 0.8); sfx.dive(near); break;
    case 'land':
      if (v) v.squash = clamp(e.power / 18, 0.3, 1);
      dust(e.x, e.y, e.z, Math.min(9, 3 + (e.power * 0.4) | 0), 0.9); sfx.land(near, e.power);
      if (mine && e.power > 14) shake(0.16);
      break;
    case 'bounce': burst(e.x, e.y + 0.2, e.z, 16, MINT, 4, 0.35, 0.7, 6); sfx.bounce(near); break;
    case 'fire': burst(e.x, e.y + 1, e.z, 4, YELLOW, 2.5, 0.22, 0.25, 0); sfx.fire(near); break;
    case 'bonk':
      burst(e.x, e.y, e.z, 12, YELLOW, 5, 0.3, 0.55, 8); sfx.bonk(near);
      if (mine) { shake(0.35); toast('Bonked!'); } else if (e.by === me) toast('Nice bonk!');
      break;
    case 'hit': burst(e.x, e.y + 1, e.z, 12, CONF[0], 5, 0.3, 0.55, 8); sfx.bonk(near); if (mine) { shake(0.45); toast('Ouch!'); } break;
    case 'pickup': burst(e.x, e.y + 1, e.z, 10, YELLOW, 3, 0.25, 0.6, -2); sfx.pickup(near); if (mine) toast('Blaster loaded'); break;
    case 'cp': if (mine && e.cp > 0) { toast('Checkpoint!'); sfx.cp(); } break;
    case 'fall': sfx.fall(near); if (mine) toast('Back to checkpoint'); break;
    case 'respawn': burst(e.x, e.y + 0.6, e.z, 14, MINT, 3.5, 0.3, 0.7, 2); break;
    case 'crumble': burst(e.x, e.y, e.z, 10, [1, 0.72, 0.42], 3, 0.35, 0.8, 9); sfx.rumble(near * 0.8); break;
    case 'shake': if (Math.random() < 0.5) burst(e.x, e.y + 0.5, e.z, 2, [1, 0.72, 0.42], 1.5, 0.28, 0.5, 8); break;
    case 'spark': burst(e.x, e.y, e.z, 5, YELLOW, 2.5, 0.2, 0.3, 4); break;
    case 'go': showCount('GO!', 'go'); sfx.go(); break;
    case 'finish':
      confetti(e.x, e.y + 1, e.z, e.place === 1 ? 70 : 34);
      if (mine) {
        sfx.finish(); showCount('FINISH!', 'go'); shake(0.2);
        const p2 = sim.players[me];
        resultsAt = performance.now() / 1000 + 1.7;
        if (best === null || p2.finishT < best) { const had = best !== null; best = p2.finishT; if (had) toast('New best time!'); }
      }
      break;
  }
}

/* ---------------- per-frame update ---------------- */
function update(dt, t) {
  const playing = mode === 'play';
  if (!paused) sim.step(dt, playing ? readInput() : null);
  if (playing) { pulse.jump = false; pulse.dive = false; }
  for (let i = 0; i < sim.ev.length; i++) onEvent(sim.ev[i]);
  sim.ev.length = 0;
  stepParticles(dt);

  for (const q of sim.players) {
    const v = vis[q.id], sp = Math.hypot(q.vx, q.vz);
    if (q.ground) v.phase += Math.min(sp, 8) * dt * 1.5;
    v.squash *= Math.exp(-9 * dt);
    if (q.ground && sp > 5.5 && q.stun <= 0 && q.dead <= 0 && (v.dust -= dt) <= 0) { v.dust = 0.12; dust(q.x, q.y, q.z, 1, 0.5); }
  }
  if (!playing) return;

  const p = sim.players[me], ty = Math.max(p.y, -2);
  if (!cam.init || Math.abs(p.z - cam.z) > 30) { cam.x = p.x * 0.8; cam.y = ty; cam.z = p.z; cam.init = true; }
  cam.x += (p.x * 0.8 - cam.x) * damp(5, dt);
  cam.y += (ty - cam.y) * damp(3.2, dt);
  cam.z += (p.z - cam.z) * damp(9, dt);
  cam.shake *= Math.exp(-6 * dt);
  cam.fov += (60 + clamp(Math.hypot(p.vx, p.vz) / 7.4, 0, 1) * 4 - cam.fov) * damp(3, dt);

  if (sim.phase === 'countdown') {
    const n = Math.ceil(sim.cd);
    if (n !== lastN) { lastN = n; if (n >= 1 && n <= 3) { showCount(String(n), 'c' + n); sfx.beep(); } }
  }
  const dead = p.dead > 0;
  if (dead !== veilOn) { veilOn = dead; el.veil.classList.toggle('on', dead); }
  updateHud();
  if (resultsAt && !resultsShown && t >= resultsAt) showResults();
  else if (resultsShown && t >= listT) { listT = t + 0.4; fillResList(); }
}

/* ---------------- drawing ---------------- */
function part(mesh, x, y, z, sx, sy, sz, col, em) { push(); translate(x, y, z); scale(sx, sy, sz); draw(mesh, col, 0, em); pop(); }
function box(x, y, z, sx, sy, sz, yaw, col, pat, em) { push(); translate(x, y, z); if (yaw) rotY(yaw); scale(sx, sy, sz); draw(M.cube, col, pat, em, sx, sy, sz); pop(); }
function hull(x, y, z, sx, sy, sz, yaw, th) { push(); translate(x, y, z); if (yaw) rotY(yaw); scale(sx + th * 2, sy + th * 2, sz + th * 2); draw(M.cube, BLACK, 0, INK); pop(); }

function drawScene(t) {
  for (const c of clouds) {
    const bob = Math.sin(t * 0.4 + c.ph) * 0.8;
    for (const b of c.b) part(M.sphere, c.x + b[0] * c.s, c.y + bob + b[1] * c.s, c.z + b[2] * c.s, b[3] * c.s, b[3] * c.s * 0.7, b[3] * c.s, CLOUD, CLOUD_EM);
  }
  const S = sim.solids, fz = sim.finishZ;
  G.outlineBegin();
  for (let i = 0; i < S.length; i++) {
    const s = S[i]; if (s.state === 'gone') continue;
    const j = s.state === 'shake' ? Math.sin(t * 90 + i * 1.7) * 0.07 : 0;
    hull(s.cx + j, s.cy, s.cz, s.hx * 2, s.hy * 2, s.hz * 2, s.yaw, s.shape === 'bar' ? 0.06 : 0.08);
  }
  for (const d of sim.deco) if (d.shape === 'hub') part(M.cyl, d.x, d.y + 0.78, d.z, 0.7, 1.6, 0.7, BLACK, INK);
  hull(-7.6, world.finishTop + 2.3, fz + 0.9, 0.8, 7.2, 0.8, 0, 0.07); hull(7.6, world.finishTop + 2.3, fz + 0.9, 0.8, 7.2, 0.8, 0, 0.07);
  hull(0, world.finishTop + 5.4, fz + 0.9, 16, 1.6, 0.7, 0, 0.07);
  G.outlineEnd();

  for (let i = 0; i < S.length; i++) {
    const s = S[i]; if (s.state === 'gone') continue;
    let col = rgb(s.color), pat = 0, em = null, sy = s.hy * 2;
    const j = s.state === 'shake' ? Math.sin(t * 90 + i * 1.7) * 0.07 : 0;
    switch (s.shape) {
      case 'slab': case 'mover': case 'tile': pat = 1; break;
      case 'bar': case 'piston': pat = 3; break;
      case 'disc': pat = 5; break;
      case 'pad': em = PAD_EM; sy *= 1 + 0.16 * Math.sin(t * 7); break;
    }
    if (s.state === 'shake') col = [Math.min(1, col[0] * 1.1 + 0.12), col[1] * 0.78, col[2] * 0.7];
    box(s.cx + j, s.cy, s.cz, s.hx * 2, sy, s.hz * 2, s.yaw, col, pat, em);
    if (s.kind === 'piston') {
      const hx = s.b.cx - s.dir * 1.2, len = Math.abs(s.cx - hx);
      box((hx + s.cx) / 2, s.cy, s.cz, len, 0.28, 0.28, 0, ROD, 0, null);
    }
  }
  for (const d of sim.deco) {
    if (d.shape === 'hub') part(M.cyl, d.x, d.y + 0.78, d.z, 0.62, 1.56, 0.62, HUB);
    else if (d.shape === 'rail') box(d.x, d.y + 0.75, d.z, 0.9, 1.5, 2.6, 0, HOUSE, 0, null);
  }
  const pc = sim.players[me].cp;
  for (const f of flags) {
    box(f.x, f.y + 1.0, f.z, 0.14, 2.0, 0.14, 0, POLE, 0, null);
    box(f.x - Math.sign(f.x || 1) * 0.5, f.y + 1.72, f.z, 0.9, 0.5, 0.06, 0, pc >= f.i ? MINT : WHITE, 0, pc >= f.i ? [0.1, 0.3, 0.2] : null);
  }
  box(0, world.startTop + 0.03, 1.8, 15, 0.06, 1, 0, WHITE, 4, null);
  box(0, world.finishTop + 0.03, fz + 0.9, 14, 0.06, 2, 0, WHITE, 4, null);
  box(-7.6, world.finishTop + 2.3, fz + 0.9, 0.8, 7.2, 0.8, 0, [1, 0.56, 0.72], 0, null);
  box(7.6, world.finishTop + 2.3, fz + 0.9, 0.8, 7.2, 0.8, 0, [1, 0.56, 0.72], 0, null);
  box(0, world.finishTop + 5.4, fz + 0.9, 16, 1.6, 0.7, 0, WHITE, 2, null);
}

function drawRacer(q, v, t) {
  const K = KINDS[q.kind] || KINDS.zombie;
  const sp = Math.hypot(q.vx, q.vz), busy = q.stun > 0 || q.diveT > 0;
  const run = q.ground && !busy ? Math.min(sp / 7, 1) : 0;
  let pitch;
  if (q.stun > 0) pitch = q.flop * 1.5 * Math.min(1, (1 - q.stun / (q.stunMax || 1)) * 5 + 0.2);
  else if (q.getup > 0) pitch = q.flop * 1.5 * (q.getup / 0.35);
  else if (q.diveT > 0) pitch = 1.38 * Math.min(1, (1 - q.diveT / 0.5) * 7 + 0.3);
  else pitch = run * 0.2;
  const lie = Math.abs(Math.sin(pitch)), air = !q.ground && !busy;
  const st = air ? clamp(q.vy / 16, -0.3, 0.4) : 0, sq = v.squash;
  const sy = 1 + st * 0.35 - sq * 0.26, sxz = 1 - st * 0.18 + sq * 0.16;

  push();
  translate(q.x, q.y, q.z); rotY(q.yaw); translate(0, 0.43 * lie, 0); rotX(pitch); scale(sxz, sy, sxz);

  G.outlineBegin();
  part(M.cyl, 0, 0.75, 0, 0.48, 0.66, 0.48, BLACK, INK);
  part(M.sphere, 0, 0.42, 0, 0.48, 0.48, 0.48, BLACK, INK);
  part(M.sphere, 0, 1.08, 0, 0.48, 0.48, 0.48, BLACK, INK);
  G.outlineEnd();

  part(M.cyl, 0, 0.75, 0, 0.42, 0.66, 0.42, K.rgb);
  part(M.sphere, 0, 0.42, 0, 0.42, 0.42, 0.42, K.rgb);
  part(M.sphere, 0, 1.08, 0, 0.42, 0.42, 0.42, K.rgb);

  const big = K.hat === 'none' ? 1.3 : 1;
  part(M.sphere, -0.155, 1.2, 0.33, 0.12 * big, 0.125 * big, 0.1, WHITE);
  part(M.sphere, 0.155, 1.2, 0.33, 0.115, 0.12, 0.1, WHITE);
  part(M.sphere, -0.155, 1.2, 0.42, 0.056, 0.06, 0.05, INK);
  part(M.sphere, 0.155, 1.2, 0.42, 0.056, 0.06, 0.05, INK);
  part(M.sphere, 0, 0.97, 0.4, 0.09, 0.03, 0.04, INK);

  const dive = q.diveT > 0, sw = Math.sin(v.phase) * run;
  const hy = dive ? 0.92 : air ? 1.05 : q.stun > 0 ? 1.0 : 0.72, hz = dive ? 0.5 : sw * 0.34;
  part(M.sphere, -0.52, hy, hz, 0.13, 0.13, 0.13, K.lite);
  part(M.sphere, 0.52, hy, dive ? hz : -hz, 0.13, 0.13, 0.13, K.lite);
  const f = v.phase, cf = Math.cos(f) * 0.28 * run;
  part(M.sphere, -0.2, air ? 0.2 : 0.1 + Math.max(0, Math.sin(f)) * 0.15 * run, air ? 0.16 : 0.06 + cf, 0.15, 0.11, 0.22, INK);
  part(M.sphere, 0.2, air ? 0.2 : 0.1 + Math.max(0, -Math.sin(f)) * 0.15 * run, air ? 0.01 : 0.06 - cf, 0.15, 0.11, 0.22, INK);

  switch (K.hat) {
    case 'stem': part(M.cyl, 0, 1.53, 0, 0.07, 0.2, 0.07, K.hc); break;
    case 'tuft': part(M.sphere, 0.02, 1.52, 0.04, 0.13, 0.13, 0.13, K.lite); break;
    case 'antenna':
      part(M.cyl, 0, 1.6, 0, 0.03, 0.26, 0.03, [0.35, 0.4, 0.55]);
      part(M.sphere, 0, 1.76, 0, 0.075, 0.075, 0.075, [1, 0.35, 0.45], [0.35, 0.05, 0.1]); break;
    case 'party':
      part(M.cone, 0, 1.72, 0, 0.2, 0.46, 0.2, YELLOW);
      part(M.sphere, 0, 1.96, 0, 0.06, 0.06, 0.06, WHITE); break;
  }
  pop();
}

function drawActors(t) {
  G.outlineBegin();
  for (const k of sim.pickups) if (k.on) {
    push(); translate(k.x, k.y + 0.12 * Math.sin(t * 3 + k.x + k.z), k.z); rotY(t * 2.2); rotX(0.6); scale(0.56, 0.56, 0.56); draw(M.cube, BLACK, 0, INK); pop();
  }
  G.outlineEnd();
  for (const k of sim.pickups) if (k.on) {
    push(); translate(k.x, k.y + 0.12 * Math.sin(t * 3 + k.x + k.z), k.z); rotY(t * 2.2); rotX(0.6); scale(0.44, 0.44, 0.44); draw(M.cube, YELLOW, 0, YELLOW_EM); pop();
  }
  for (const b of sim.bullets) part(M.sphere, b.x, b.y, b.z, 0.17, 0.17, 0.17, YELLOW, [0.7, 0.55, 0.1]);

  for (const q of sim.players) {
    if (q.dead > 0) continue;
    if (q.protect > 0 && ((t * 14) | 0) % 2) continue;
    drawRacer(q, vis[q.id], t);
  }
  const p = sim.players[me];
  if (mode === 'play' && p.dead <= 0) {
    const y = p.y + 2.4 + Math.sin(t * 5) * 0.1;
    G.outlineBegin(); push(); translate(p.x, y, p.z); rotX(Math.PI); scale(0.37, 0.5, 0.37); draw(M.cone, BLACK, 0, INK); pop(); G.outlineEnd();
    push(); translate(p.x, y, p.z); rotX(Math.PI); scale(0.3, 0.42, 0.3); draw(M.cone, YELLOW, 0, YELLOW_EM); pop();
  }
}

function drawFx() {
  G.beginTransparent();
  for (const q of sim.players) {
    if (q.dead > 0) continue;
    const top = groundBelow(q.x, q.z, q.y + 0.6);
    if (top === null) continue;
    const h = Math.max(0, q.y - top), r = 0.52 - Math.min(h, 7) * 0.035, a = 0.34 * (1 - Math.min(h, 9) / 11);
    push(); translate(q.x, top + 0.045, q.z); scale(r, 1, r); G.setAlpha(a); draw(M.disc, BLACK, 0, INK); pop();
  }
  G.endTransparent();
  packParticles();
  for (const k of sim.pickups) if (k.on) glow(k.x, k.y, k.z, YELLOW, 0.4, 1.6);
  for (const b of sim.bullets) glow(b.x, b.y, b.z, [1, 0.9, 0.5], 0.55, 0.9);
  G.drawParticles(pdata, pn);
}

function render(t) {
  let ex, ey, ez, tx, ty, tz, fov = 60;
  if (mode === 'menu') {
    const z = (t * 6.5) % 175 - 6, cy = courseY(z);
    ex = -11 + 3 * Math.sin(t * 0.35); ey = cy + 8 + Math.sin(t * 0.2); ez = z - 12;
    tx = 0; ty = cy + 0.8; tz = z + 9; fov = 62;
  } else {
    const k = sim.phase === 'countdown' ? clamp(sim.cd / 3, 0, 1) : 0, ik = k * k * (3 - 2 * k), sh = cam.shake;
    ex = cam.x + ik * 7 + (Math.random() - 0.5) * sh; ey = cam.y + 5.2 + ik * 3 + (Math.random() - 0.5) * sh; ez = cam.z - 9.5 - ik * 5;
    tx = cam.x * 0.92; ty = cam.y + 1.0; tz = cam.z + 5; fov = cam.fov;
  }
  G.beginFrame(ex, ey, ez, tx, ty, tz, fov);
  drawScene(t); drawActors(t); drawFx();
}

/* ---------------- main loop ---------------- */
let last = performance.now(), failed = false;
function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000; last = now;
  if (!(dt > 0)) return;
  if (dt > 0.1) dt = 0.1;
  try { update(dt, now / 1000); render(now / 1000); }
  catch (e) { if (!failed) { failed = true; errBar(e && e.message || String(e)); console.error(e); } }
}
document.addEventListener('visibilitychange', () => { last = performance.now(); });

pick(myKind);
requestAnimationFrame(frame);
window.__race = { get sim() { return sim; }, get mode() { return mode; }, get me() { return me; }, start: startGame, menu: goMenu, pause(v) { paused = !!v; } };
})();
