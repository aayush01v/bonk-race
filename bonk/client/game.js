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
const isMP = typeof location !== 'undefined' && location.search.includes('mp=1');
const netOn = isMP && new URLSearchParams(location.search).has('net');  // ?net=1: show the netcode debug overlay
// The lobby launches this game inside an iframe, where window.opener is null.
// For a window.open()-style launch, parent === window, so fall back to opener there.
const mpHost = (window.parent && window.parent !== window) ? window.parent : (window.opener || null);

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
    const lx = dx * c - dz * n, lz = dx * n + dz * c;
    const inside = s.round ? Math.hypot(lx, lz) <= s.hx + 0.1 : (Math.abs(lx) <= s.hx + 0.1 && Math.abs(lz) <= s.hz + 0.1);
    if (inside && (best === null || top > best)) best = top;
  }
  return best;
}

/* ---------------- input ---------------- */
const keys = Object.create(null), pulse = { jump: false, dive: false }, touch = { mx: 0, mz: 0, fire: false };
const KEYMAP = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', KeyF: 'fire', KeyJ: 'fire' };
const clearInput = () => { for (const k in keys) keys[k] = false; pulse.jump = pulse.dive = predictedPulse.jump = predictedPulse.dive = false; touch.mx = touch.mz = 0; touch.fire = false; };

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
    d.className = 'dot' + (p.id === me ? ' me' : ''); d.style.setProperty('--c', (KINDS[p.kind] || KINDS.zombie).c);
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
  for (const q of sim.players) if (dots[q.id]) dots[q.id].style.left = (clamp(q.z / sim.finishZ, 0, 1) * 100).toFixed(1) + '%';
}
function fillResList() {
  const ul = el.resList; ul.textContent = '';
  sim.ranking().forEach((q, i) => {
    const li = document.createElement('li'); if (q.id === me) li.className = 'me';
    const a = document.createElement('span'); a.textContent = i + 1;
    const d = document.createElement('i'); d.style.setProperty('--c', (KINDS[q.kind] || KINDS.zombie).c);
    const n = document.createElement('span'); n.textContent = q.id === me ? 'You' : q.name;
    const t = document.createElement('em'); t.textContent = q.finished ? fmt(q.finishT) : 'racing...';
    li.append(a, d, n, t); ul.appendChild(li);
  });
}
function showResults() {
  resultsShown = true;
  // MP: the lobby shows authoritative results shortly after — these solo buttons would desync the sim
  $('btnAgain').style.display = isMP ? 'none' : '';
  $('btnMenu').style.display = isMP ? 'none' : '';
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
  if (isMP) return; // MP races are driven by the lobby via mp_init — restarting locally would replace the synced sim
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
  if (isMP) return; // MP: the lobby owns the post-race flow (results + rematch)
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
  if (!KINDS[id]) id = 'zombie';
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

/* ---------------- MP netcode: interpolation, correction, input ----------------
   Remotes (other humans AND bots) run the local sim with neutral input — the local
   sim is a physics shell around the network truth: it resolves my collisions and
   produces the passive events (land/fall/respawn/pickup/...) the server doesn't
   relay. Their motion comes from server snapshots interpolated INTERP_DELAY behind
   the local clock; my player is predicted locally and smoothly corrected toward the
   server. Fixed 1/60 sub-steps match the server's h. See README §10. */
const INTERP_DELAY = 0.1, SIM_STEP = 1 / 60;
// Network pulses are sent immediately; local pulses survive render-only frames.
const predictedPulse = { jump: false, dive: false };
// Adaptive interpolation delay: instead of a fixed 100 ms, the render delay
// eases toward a target that tracks arrival jitter. The arrival-aligned
// sim clock already includes downlink transit; adding RTT/2 here counts it twice.
const INTERP_MIN = 0.1, INTERP_MAX = 0.4, INTERP_BASE = 0.15;
const EXTRAP_MAX = 0.2;   // cap on how far a starved sample is extrapolated
// Own-player reconciliation state (see reconcileOwn()). A short history of where WE
// predicted ourselves to be lets a server sample be compared with the prediction at
// the MATCHING moment instead of with where we are now.
const ownHist = [];                    // { w, x, y, z, g }: predicted pos at client wall time w (s)
const ownPend = { x: 0, y: 0, z: 0 };  // correction still to be eased in
const ownPendV = { x: 0, z: 0 };       // velocity correction still to be eased in
const OWN_DZ = 0.35;                   // u: residual below this is alignment noise — ignored
const OWN_DV = 2.5;                    // u/s: velocity residual below this is alignment noise (one tick of accel/decel is ~2 u/s)
const ACK_LEAD = 1 / 60;               // s: the server integrates one tick after applying an input; ownHist is labelled by input stamp
const OWN_HIST_S = 6;                  // s of predicted history kept: must exceed the worst loop delay (RTT + playout buffer)
const BUF_AGE = 1.0;      // snapshots older than (now - BUF_AGE) are dropped (time, not count)
let interpDelay = INTERP_DELAY;   // the smoothed delay actually used to render
let interpTarget = INTERP_DELAY;  // where interpDelay is easing toward
let srvOffset = null;            // smoothed (server time - client wall seconds)
const snapBuf = [];   // raw server 'state' snapshots, oldest first
let netMine = null;   // last server sample of my player (correction target)
let netMineDead = false, lastNetPhase = '', needHardSnapMe = false;
let simAcc = 0, lastSentInp = null, lastSentAt = 0, lastInpAt = 0;
let pendingFallStamp = null, lastJumpStamp = 0;
let lastDiveStamp = 0, lastFireStamp = 0, lastPickupStamp = 0;
// lastInpAt: sim time of the last REAL input (change or pulse) — the keep-alive
// resend doesn't re-arm it. Drives the input-confirmation window in applyNet:
// until the server has had uplink time to receive it and broadcast it, no state
// sample can contain that input, so correcting toward one would pull the local
// prediction backward (the "sticky jump" tug on takeoff).
// Remote fire/jump/dive VFX are held until the remote's interpolated position
// actually reaches the event's spot (flushNetEvents), not fired on arrival.
const evQueue = [];   // { at, ev } scheduled remote events (at = the event's server time st)
const netStats = { snaps: 0, gaps: [], rtt: -1, corr: 0, lastStateNow: 0, pingTs: 0, lastPing: 0, lastUi: 0 };
let rttEst = -1;  // smoothed RTT estimate (ms) — see updateRtt()
const NEUTRAL = { mx: 0, mz: 0, jump: false, dive: false, fire: false };
const wrapA = a => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };

// Inverse of mp-server.js broadcastState() (compact fixed-point wire format,
// documented there): keyless arrays, positions ×100, velocities ×10, t in ms.
// Decodes to the legacy object shape the rest of the netcode below consumes.
function decodeState(m) {
  return {
    t: m.t / 1000, raceT: m.raceT / 100, phase: m.phase, cd: m.cd / 100, finishCount: m.finishCount,
    players: m.pl.map(a => ({
      x: a[0] / 100, y: a[1] / 100, z: a[2] / 100,
      vx: a[3] / 10, vy: a[4] / 10, vz: a[5] / 10, yaw: a[6] / 100, ground: a[7],
      stun: a[8] / 100, diveT: a[9] / 100, dead: a[10] / 100, protect: a[11] / 100,
      ammo: a[12], cp: a[13], finished: a[14] > 0, finishT: a[15] / 100,
      place: a[16], falls: a[17], bonks: a[18],
      ack: a[19] > 0 ? a[19] / 1000 : 0,  // client-stamp time (s) this sample reflects; 0 = not acked
    })),
    tiles: m.tl.map(a => ({ id: a[0], state: a[1], cy: a[2] / 100, active: a[3] > 0 })),
    bullets: m.bl.map(a => ({ id: a[0], x: a[1] / 100, y: a[2] / 100, z: a[3] / 100, vx: a[4] / 10, vz: a[5] / 10, owner: a[6] })),
    pickups: m.pk.map(on => ({ on: on > 0 })),
  };
}

function resetNet() {
  snapBuf.length = 0;
  netMine = null; netMineDead = false; lastNetPhase = ''; needHardSnapMe = false;
  simAcc = 0; lastSentInp = null; lastSentAt = 0; lastInpAt = 0;
  pendingFallStamp = null; lastJumpStamp = 0;
  predictedPulse.jump = predictedPulse.dive = false;
  lastDiveStamp = 0; lastFireStamp = 0; lastPickupStamp = 0;
  interpDelay = INTERP_DELAY; interpTarget = INTERP_DELAY; srvOffset = null;
  evQueue.length = 0;
  netStats.snaps = 0; netStats.gaps.length = 0; netStats.corr = 0; netStats.lastStateNow = 0;
  // RTT state must not leak across rematches, and the probe should re-fire
  // promptly after a fresh race (lastPing = 0 → the 1 Hz gate is open)
  rttEst = -1; netStats.rtt = -1; netStats.lastPing = 0;
  ownHist.length = 0; ownPend.x = ownPend.y = ownPend.z = 0; ownPendV.x = ownPendV.z = 0;
}

// Feed one RTT sample (ms) into the estimate. A single raw ping is too noisy to
// drive the netcode: a GC pause or tab switch shows up as a 3-5 s sample that
// would clamp the input-confirmation gates to their worst case (1.2 s) and push
// the interpolation delay target to its cap for a full second — the "actions
// render after a delay" symptom on spiky lines. So: drop non-positive samples
// (clock glitches), clamp the rest to the gates' own worst case (nothing is
// lost above it — a truly slow line gets the same worst-case behavior as
// before), and smooth with an EMA (α = 0.4 → ~2 s time constant at the 1 Hz
// probe), so a single spike degrades the estimate for a fraction of a second
// instead of pinning it.
function updateRtt(sampleMs) {
  if (!(sampleMs > 0)) return;
  const s = Math.min(sampleMs, 1200);
  const a = 0.4;
  rttEst = rttEst < 0 ? s : rttEst + (s - rttEst) * a;
  netStats.rtt = rttEst;
}

// Refresh the adaptive-delay target from arrival-gap jitter, not RTT.
// srvOffset is measured at arrival, so sim.t already trails the server by
// downlink transit. Only extra buffering for uneven arrivals is needed here.
// Called on each state arrival. Jitter is how late the
// worst recent packet was (p95 arrival gap minus the mean, over the ~60-sample
// window already collected for the ?net=1 overlay).
function updateDelayTarget() {
  let jitter = 0;
  if (netStats.gaps.length > 4) {
    const g = netStats.gaps.slice().sort((a, b) => a - b);
    const p95 = g[(0.95 * g.length) | 0] || 0;
    const mean = g.reduce((a, b) => a + b, 0) / g.length;
    jitter = Math.max(0, p95 - mean) / 1000;
  }
  interpTarget = clamp(INTERP_BASE + jitter * 0.5, INTERP_MIN, INTERP_MAX);
}

// Release queued remote fire/jump/dive VFX whose render time has arrived, so the
// effect lands when the remote's interpolated position reaches that spot. Drop
// anything that fell >250 ms behind render time (stale after a stall) instead of
// bursting it at a position the remote has already left.
function flushNetEvents() {
  const rNow = sim.t - interpDelay;
  // the stale-drop and release loops below only look at the queue head, so the
  // queue must be in time order — an event that arrives late with an older st
  // (or the st-less fallback stamped at the later arrival) would otherwise sit
  // behind a newer one and never be dropped/released on time.
  evQueue.sort((a, b) => a.at - b.at);
  while (evQueue.length && evQueue[0].at < rNow - 0.25) evQueue.shift();
  while (evQueue.length && evQueue[0].at <= rNow) sim.ev.push(evQueue.shift().ev);
}

// send input only on change (+ one-shot pulses, + 100ms keep-alive) — not every frame
function sendMPInput(input, stampT) {
  if (!mpHost) return;
  const now = performance.now();
  const l = lastSentInp;
  const changed = !l || input.mx !== l.mx || input.mz !== l.mz || input.fire !== l.fire;
  if (input.jump) lastJumpStamp = stampT;
  if (input.dive) lastDiveStamp = stampT;
  if (input.fire) lastFireStamp = stampT;
  if (changed || input.jump || input.dive || now - lastSentAt >= 100) {
    // re-arm the confirmation window only for real new inputs; the 100 ms
    // keep-alive resend carries no new information for the server
    if (changed || input.jump || input.dive) lastInpAt = sim.t;
    // monotonic wall-clock stamp (NOT sim.t: that clock is slewed toward the server's and
    // would distort input durations on the server's playout buffer)
    input.t = stampT;
    mpHost.postMessage({ type: 'mp_input', input }, '*');
    lastSentInp = { mx: input.mx, mz: input.mz, fire: input.fire };
    lastSentAt = now;
  }
}

// the two snapshots that bracket "now - interpDelay". When the render time has
// overtaken the newest sample (starvation) it reports `ex` = how far (s, capped)
// to extrapolate the newest sample forward instead of freezing.
function lerpPair() {
  const b = snapBuf;
  if (!b.length) return null;
  const tNow = sim.t - interpDelay;
  if (tNow >= b[b.length - 1].t) {
    const newest = b[b.length - 1], prev = b[b.length - 2] || newest;
    return { a: prev, b: newest, k: 1, ex: clamp(tNow - newest.t, 0, EXTRAP_MAX) };
  }
  for (let i = b.length - 1; i >= 1; i--) {
    if (b[i - 1].t <= tNow) {
      const a = b[i - 1], c = b[i];
      return { a, b: c, k: (c.t - a.t) > 1e-4 ? clamp((tNow - a.t) / (c.t - a.t), 0, 1) : 1, ex: 0 };
    }
  }
  return { a: b[0], b: b[0], k: 1, ex: 0 };
}

// <own-reconcile-fns>
// A server sample only reflects the inputs the server had received when it ticked,
// i.e. our prediction from about one RTT ago. Comparing it with where we are NOW
// reads as a phantom error of ~v·rtt and drags the player back toward a ghost — the
// "stops, then slides forward over the edge" bug. So the sample is compared with what
// we predicted at the matching moment; with no real divergence that error is ~0 and
// nothing is applied. Only the excess over OWN_DZ is eased in, and the same offset is
// added to the history so the next sample doesn't count it twice. Velocity is
// corrected only for meaningful residuals; ordinary airborne arcs stay locally
// owned, except when an acknowledged landing proves a descending miss.
function reconcileOwn(s, sp, tArr, p) {
  if (needHardSnapMe || !ownHist.length) return;
  let tm;
  if (sp.ack > 0) {
    // exact: the server says which of our (monotonic-stamped) inputs this sample contains
    tm = sp.ack + ACK_LEAD;
  } else {
    // old server without acks: estimate the loop delay. `base` is arrival-based (srvOffset
    // is learned from arrival times), so it already includes the downlink; the inputs the
    // sample reflects were sent a FULL round trip before it arrived — not rtt/2.
    const rtt = netStats.rtt >= 0 ? netStats.rtt / 1000 : 0.1;
    const base = srvOffset !== null ? s.t - srvOffset : tArr;
    tm = base - rtt;
  }
  let h = null;
  for (let i = ownHist.length - 1; i >= 1; i--) {
    const a = ownHist[i - 1], b = ownHist[i];
    if (a.w <= tm && tm <= b.w) {
      const k = b.w > a.w ? (tm - a.w) / (b.w - a.w) : 1;
      h = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, g: a.g && b.g,
            vy: a.vy + (b.vy - a.vy) * k, vx: a.vx + (b.vx - a.vx) * k, vz: a.vz + (b.vz - a.vz) * k };
      break;
    }
  }
  if (!h) return;
  // Acknowledged landing disagrees with our descending trajectory. Recover
  // before reaching KILL_Y, but never cancel a jump/dive issued after that sample.
  if (p && sp.ack > 0 && !h.g && h.vy < -1 && sp.ground >= 0 &&
      sp.y - h.y > 0.6 && p.vy <= 0 && !p.ground &&
      lastJumpStamp <= sp.ack && lastDiveStamp <= sp.ack) {
    needHardSnapMe = true;
    return;
  }
  const ex = sp.x - h.x, ey = sp.y - h.y, ez = sp.z - h.z;
  if (ex * ex + ey * ey + ez * ez > 64) { needHardSnapMe = true; return; }  // |err| > 8 u
  const mag = Math.hypot(ex, ez);
  if (mag > OWN_DZ) {
    const k = (mag - OWN_DZ) / mag, px = ex * k, pz = ez * k;
    ownPend.x += px; ownPend.z += pz;
    for (const e of ownHist) { e.x += px; e.z += pz; }
  }
  if (h.g && sp.ground >= 0 && Math.abs(ey) > 0.3) {
    const py = ey - Math.sign(ey) * 0.3;
    ownPend.y += py;
    for (const e of ownHist) e.y += py;
  }
  // velocity: same alignment, so a difference is a real divergence the server decided
  // (a bonk/knockback the local sim predicted differently or not at all). Only the excess
  // over OWN_DV is adopted, never the raw stale sample velocity.
  const dvx = sp.vx - h.vx, dvz = sp.vz - h.vz, dm = Math.hypot(dvx, dvz);
  if (dm > OWN_DV) {
    const k = (dm - OWN_DV) / dm, qx = dvx * k, qz = dvz * k;
    ownPendV.x += qx; ownPendV.z += qz;
    for (const e of ownHist) if (e.w > tm) { e.vx += qx; e.vz += qz; }
  }
}

function applyOwnCorrection(p, dt) {
  if (needHardSnapMe) {  // fall/respawn, phase change, |err| > 8 u: events, not drift
    p.x = netMine.x; p.y = netMine.y; p.z = netMine.z; p.yaw = netMine.yaw;
    p.vx = netMine.vx; p.vy = netMine.vy; p.vz = netMine.vz;
    p.ground = netMine.ground >= 0 ? sim.solids[netMine.ground] : null;
    // A grounded sample is attached to a moving platform at sample time.
    // Preserve that local contact point at the client's current platform pose.
    if (p.ground && p.ground.active && sim.solidPose) {
      const g = p.ground, old = sim.solidPose(g.id, netMine.t);
      const dx = p.x - old.cx, dz = p.z - old.cz;
      const c = Math.cos(old.yaw), sn = Math.sin(old.yaw);
      const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
      const nc = Math.cos(g.yaw), ns = Math.sin(g.yaw);
      p.x = g.cx + lx * nc + lz * ns; p.z = g.cz - lx * ns + lz * nc;
      p.y = g.cy + g.hy;
    }
    if (p.ground && !p.ground.active) p.ground = null;
    needHardSnapMe = false; netStats.snaps++;
    ownHist.length = 0; ownPend.x = ownPend.y = ownPend.z = 0; ownPendV.x = ownPendV.z = 0;
  } else {
    const f = 1 - Math.exp(-12 * dt);
    const dx = ownPend.x * f, dy = ownPend.y * f, dz = ownPend.z * f;
    p.x += dx; p.y += dy; p.z += dz;
    ownPend.x -= dx; ownPend.y -= dy; ownPend.z -= dz;
    const dvx = ownPendV.x * f, dvz = ownPendV.z * f;
    p.vx += dvx; p.vz += dvz;
    ownPendV.x -= dvx; ownPendV.z -= dvz;
  }
  netStats.corr = Math.hypot(ownPend.x, ownPend.y, ownPend.z);
}
// </own-reconcile-fns>

// Only server snapshots commit death/respawn. An alive snapshot predating a
// predicted fall cannot resolve it; wait until the input playhead reaches it.
function syncOwnLife(p, sp, nowS) {
  const dead = sp.dead > 0;
  if (dead !== netMineDead) {
    netMineDead = dead; needHardSnapMe = true;
    onEvent({ t: dead ? 'fall' : 'respawn', id: me, x: sp.x, y: sp.y, z: sp.z });
  }
  if (p._pendingFall) {
    if (pendingFallStamp === null) pendingFallStamp = nowS;
    const legacyReady = !(sp.ack > 0) && nowS - pendingFallStamp >
      Math.max(0.35, Math.min(1.2, netStats.rtt / 1000) + 0.15);
    const resolved = dead || legacyReady || (sp.ack > 0 && sp.ack + ACK_LEAD >= pendingFallStamp);
    if (!resolved) return false;
    p._pendingFall = false; pendingFallStamp = null; needHardSnapMe = true;
  }
  p.dead = sp.dead; p.protect = sp.protect;
  return true;
}

function applyNet(dt) {
  const S = sim, L = lerpPair(), remotes = [];
  // ease the render delay toward its adaptive target (~1 s time constant, no pops)
  interpDelay += (interpTarget - interpDelay) * (1 - Math.exp(-dt));
  // soft clock alignment: ease the local sim clock toward the estimated server
  // "now" (last snapshot time + time-since-arrival, smoothed) instead of
  // hard-snapping, so a low-FPS frame never makes the whole scene jump.
  if (srvOffset !== null) {
    const serverNow = srvOffset + performance.now() / 1000;
    const cerr = serverNow - S.t;
    if (Math.abs(cerr) > 0.05) S.t += cerr * (1 - Math.exp(-10 * dt));
  }
  if (L) {
    // remotes: network-true pos/vel/yaw before the local step — no more 15-20 Hz pulse.
    // The local step then runs neutral-input physics on them (it bleeds their
    // velocity), so update() re-applies these values after the step: what renders
    // is the interpolation itself.
    for (let i = 0; i < S.players.length; i++) {
      if (i === me) continue;
      const p = S.players[i], pa = L.a.players[i], pb = L.b.players[i];
      if (!p || !pa || !pb) continue;
      let x, y, z, vx, vy, vz, yaw;
      const dx = pb.x - pa.x, dy = pb.y - pa.y, dz = pb.z - pa.z;
      let snapd = false;
      if (dx * dx + dy * dy + dz * dz > 64) {  // discontinuity (fall/respawn): newer sample
        x = pb.x; y = pb.y; z = pb.z; vx = pb.vx; vy = pb.vy; vz = pb.vz; yaw = pb.yaw;
        snapd = true;
        netStats.snaps++;
      } else if (L.ex > 0) {
        // starved: advance the newest sample at its own velocity + yaw rate
        // (capped at EXTRAP_MAX) instead of freezing it in place
        x = pb.x + pb.vx * L.ex;
        y = pb.y + pb.vy * L.ex;
        z = pb.z + pb.vz * L.ex;
        vx = pb.vx; vy = pb.vy; vz = pb.vz;
        const dtl = pb.t - pa.t > 1e-4 ? pb.t - pa.t : 1e-4;
        yaw = pb.yaw + wrapA(pb.yaw - pa.yaw) / dtl * L.ex;
      } else {
        const k = L.k;
        x = pa.x + (pb.x - pa.x) * k;
        y = pa.y + (pb.y - pa.y) * k;
        z = pa.z + (pb.z - pa.z) * k;
        vx = pa.vx + (pb.vx - pa.vx) * k;
        vy = pa.vy + (pb.vy - pa.vy) * k;
        vz = pa.vz + (pb.vz - pa.vz) * k;
        yaw = pa.yaw + wrapA(pb.yaw - pa.yaw) * k;
      }
      if (!snapd) {
        // catch-up ease: after a long starvation the buffer may have been trimmed,
        // so the two samples bracketing the render time look continuous even though
        // the displayed position (held at the EXTRAP_MAX cap) is far behind — e.g.
        // a remote that fell and respawned while the connection was down. The
        // sample discontinuity guard above can't see that; close the gap over
        // ~150 ms instead of teleporting the player.
        const gx = x - p.x, gy = y - p.y, gz = z - p.z;
        if (gx * gx + gy * gy + gz * gz > 64) {
          const f = 1 - Math.exp(-12 * dt);
          x = p.x + gx * f; y = p.y + gy * f; z = p.z + gz * f;
          yaw = p.yaw + wrapA(yaw - p.yaw) * f;
        }
      }
      p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz; p.yaw = yaw;
      remotes.push({ p, x, y, z, vx, vy, vz, yaw });
    }
    // crumble tiles: interpolate the falling height (state/active applied on arrival);
    // when starved, keep a falling tile dropping at its recent fall rate
    for (let i = 0; i < L.b.tiles.length; i++) {
      const tb = L.b.tiles[i], tl = S.solids[tb.id], ta = L.a.tiles[i];
      if (!tl) continue;
      const aCy = ta ? ta.cy : tb.cy;
      const dc = tb.cy - aCy;
      if (dc * dc > 64) { tl.cy = tb.cy; continue; }  // respawn teleports: snap
      if (L.ex > 0) {
        const dtl = L.b.t - L.a.t > 1e-4 ? L.b.t - L.a.t : 1e-4;
        tl.cy = tb.cy + dc / dtl * L.ex;
      } else {
        tl.cy = tb.cy - dc * (1 - L.k);
      }
    }
    // bullets: keep my live local bullets; rebuild remotes between the two samples
    for (let i = S.bullets.length - 1; i >= 0; i--) if (S.bullets[i].owner !== me) S.bullets.splice(i, 1);
    const prev = new Map();
    for (const ba of L.a.bullets) prev.set(ba.id, ba);
    const tR = S.t - interpDelay;  // render time, same clock as lerpPair()
    for (const bb of L.b.bullets) {
      if (bb.owner === me) continue;  // my bullets live in sim.bullets, integrated locally
      const a2 = prev.get(bb.id);
      let x, y, z;
      if (a2) {
        x = a2.x + (bb.x - a2.x) * L.k;
        y = a2.y + (bb.y - a2.y) * L.k;
        z = a2.z + (bb.z - a2.z) * L.k;
        if (L.ex > 0) { x += bb.vx * L.ex; z += bb.vz * L.ex; }  // starved: keep flying
      } else {
        // new this interval: backdate to the render time (constant-velocity flight,
        // so this is exact once it is in the air). If it hasn't cleared the muzzle
        // (0.7 u ahead of the owner) at the render time, it isn't in flight yet —
        // hold it out until the next sample instead of showing it in the wrong place.
        const bt = L.b.t - tR;
        x = bb.x - bb.vx * bt; y = bb.y; z = bb.z - bb.vz * bt;
        const ow = L.b.players[bb.owner];
        if (ow) { const mx = x - ow.x, mz = z - ow.z; if (mx * mx + mz * mz < 0.5) continue; }
      }
      S.bullets.push({ id: bb.id, owner: bb.owner, vx: bb.vx, vz: bb.vz, life: 99, x, y, z });
    }
  }
  // me: reconcile against the server. The comparison happens once per sample in
  // reconcileOwn(); here we only ease the resulting correction in (or hard-snap on
  // true discontinuities: fall/respawn, phase change, |err| > 8 u).
  if (netMine) {
    const p = S.players[me];
    if (!p || p._pendingFall) return remotes;
    applyOwnCorrection(p, dt);
  }
  return remotes;
}

/* ---------------- per-frame update ---------------- */
function update(dt, t) {
  const playing = mode === 'play';
  if (!paused) {
    const input = playing ? readInput() : null;
    if (isMP) {
      const stampT = performance.now() / 1000;  // this frame's input stamp (monotonic)
      if (playing) {
        sendMPInput(input, stampT);
        predictedPulse.jump = predictedPulse.jump || input.jump;
        predictedPulse.dive = predictedPulse.dive || input.dive;
      }
      const remotes = applyNet(dt);
      // fixed 1/60 steps so the local sim's sub-step size matches the server's
      simAcc += dt;
      let n = 0;
      while (simAcc >= SIM_STEP && n < 10) {
        const stepInput = input ? { ...input, jump: predictedPulse.jump, dive: predictedPulse.dive } : null;
        sim.step(SIM_STEP, stepInput);
        // Consume once per physics tick, never on a frame with zero ticks.
        predictedPulse.jump = predictedPulse.dive = false;
        simAcc -= SIM_STEP; n++;
      }
      if (n >= 10) simAcc = 0;  // drop backlog instead of spiral-of-death
      // where we predict ourselves to be, on the wall clock; reconcileOwn() compares server samples with this
      const pm = sim.players[me];
      if (pm && pm._pendingFall && pendingFallStamp === null) pendingFallStamp = stampT;
      if (pm) {
        // labelled by the stamp of the input that produced it (what the server acks)
        ownHist.push({ w: stampT, x: pm.x, y: pm.y, z: pm.z, g: !!pm.ground, vx: pm.vx, vy: pm.vy, vz: pm.vz });
        while (ownHist.length && ownHist[0].w < stampT - OWN_HIST_S) ownHist.shift();
      }
      // re-apply the remote interpolation after the local step: neutral-input physics
      // would bleed their velocity and drift their position off the network truth
      for (let i = 0; i < remotes.length; i++) {
        const r = remotes[i];
        r.p.x = r.x; r.p.y = r.y; r.p.z = r.z;
        r.p.vx = r.vx; r.p.vy = r.vy; r.p.vz = r.vz; r.p.yaw = r.yaw;
      }
      // record local pickup/shake timestamps so stale snapshots don't re-trigger them
      for (let i = 0; i < sim.ev.length; i++) {
        const ev = sim.ev[i];
        if (ev.t === 'pickup' && ev.id === me) {
          lastPickupStamp = stampT;
          for (const k of sim.pickups) if (!k.on && !k._localOffAt) k._localOffAt = stampT;
        } else if (ev.t === 'shake') {
          for (const s of sim.solids) if (s.kind === 'crumble' && s.state === 'shake' && !s._shakeAt) s._shakeAt = stampT;
        }
      }
    } else {
      sim.step(dt, input);
    }
  }
  if (playing) { pulse.jump = false; pulse.dive = false; }
  if (isMP) flushNetEvents();  // release remote fire/jump/dive VFX whose render time has arrived
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
  if (isMP) {
    // RTT probe, 1/s — this must run in normal play, not only with ?net=1:
    // both consumers of netStats.rtt (the adaptive-delay target and the
    // input-confirmation uplink gate in applyNet) fall back to wrong values
    // while rtt stays -1 (zero one-way latency, 33 ms uplink floor), which
    // reads as "actions render after a delay" on any line slower than ~LAN.
    if (t - netStats.lastPing > 1 && mpHost) {
      netStats.lastPing = t; netStats.pingTs = performance.now();
      mpHost.postMessage({ type: 'mp_ping', ts: netStats.pingTs }, '*');
    }
    if (netOn && t - netStats.lastUi > 0.25) {
      netStats.lastUi = t;
      let p95 = 0;
      if (netStats.gaps.length > 4) {
        const g = netStats.gaps.slice().sort((a, b) => a - b);
        p95 = g[(0.95 * g.length) | 0] || 0;
      }
      el.net.textContent =
        'NET  rtt ' + (netStats.rtt < 0 ? '--' : Math.round(netStats.rtt)) + ' ms  ' +
        'gap p95 ' + Math.round(p95) + ' ms  ' +
        'snaps ' + netStats.snaps + '  ' +
        'corr ' + netStats.corr.toFixed(2) + ' u  ' +
        'delay ' + Math.round(interpDelay * 1000) + ' ms (tgt ' + Math.round(interpTarget * 1000) + ')';
    }
  }
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
    if (s.round) {
      push(); translate(s.cx + j, s.cy, s.cz); if (s.yaw) rotY(s.yaw);
      scale(s.hx + 0.08, s.hy * 2 + 0.16, s.hz + 0.08); draw(M.cyl, BLACK, 0, INK); pop();
    } else {
      hull(s.cx + j, s.cy, s.cz, s.hx * 2, s.hy * 2, s.hz * 2, s.yaw, s.shape === 'bar' ? 0.06 : 0.08);
    }
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
    if (s.round) {
      push(); translate(s.cx + j, s.cy, s.cz); if (s.yaw) rotY(s.yaw);
      scale(s.hx, sy, s.hz); draw(M.cyl, col, pat, em, s.hx * 2, sy, s.hz * 2); pop();
    } else {
      box(s.cx + j, s.cy, s.cz, s.hx * 2, sy, s.hz * 2, s.yaw, col, pat, em);
    }
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
  if (isMP && !sim) return;
  let dt = (now - last) / 1000; last = now;
  if (!(dt > 0)) return;
  if (dt > 0.1) dt = 0.1;
  try { update(dt, now / 1000); render(now / 1000); }
  catch (e) { if (!failed) { failed = true; errBar(e && e.message || String(e)); console.error(e); } }
}
document.addEventListener('visibilitychange', () => { last = performance.now(); });

if (isMP) {
  $('menu').classList.add('hidden');
  $('btnRestart').classList.add('hidden');
  if (netOn) {
    const n = document.createElement('div');
    n.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:60;font:11px/1.4 monospace;color:#9fe8c8;background:rgba(10,14,18,.65);padding:4px 8px;border-radius:6px;pointer-events:none';
    document.body.appendChild(n);
    el.net = n;
  }
  if (mpHost) mpHost.postMessage({ type: 'mp_ready' }, '*');
  window.addEventListener('message', e => {
    if (!e.data || !e.data.type) return;
    if (e.data.type === 'mp_init') {
      const d = e.data.data;
      // The lobby retries init while waiting for mp_ready; only re-init when the race actually changes
      if (sim && sim.__mpSeed === d.seed) return;
      audioInit();
      me = d.simPlayerId;
      myKind = d.roster.find(p => p.id === me)?.kind || 'zombie';
      if (!KINDS[myKind]) myKind = 'zombie';
      sim = Sim.create(d.seed);
      sim.__mpSeed = d.seed;
      sim.bid = 1e6;  // my local bullet ids: keep them out of the server's id range
      resetNet();
      // Apply room settings to matching objects (the server applies the same
      // changes in startRace — keep this list in lockstep with it)
      if (d.settings) {
        if (d.settings.gravity !== undefined && isFinite(d.settings.gravity)) {
          sim.grav = Sim.K.GRAV * d.settings.gravity;
        }
        for (const s of sim.solids) {
          if (s.kind === 'spin' && d.settings.spinnerSpeed !== undefined) s.om *= d.settings.spinnerSpeed;
          if (s.kind === 'crumble' && d.settings.crumbleHold !== undefined) {
            s.hold = d.settings.crumbleHold;
            s.timer = d.settings.crumbleHold;
          }
          if (s.bounce && d.settings.bounceForce !== undefined) s.bounce = d.settings.bounceForce;
        }
      }
      sim.humanId = me;
      // Build full player objects via addPlayer so bot AI (p.ai) and all timers
      // (diveCd, fireCd, coyote, jbuf, ...) exist — a hand-built object breaks
      // the local sim (bots crash in think(), first dive/fire never fires).
      for (const r of d.roster) sim.addPlayer({ name: r.name, bot: r.bot, kind: KINDS[r.kind] ? r.kind : 'zombie', skill: r.bot ? 0.8 : 0 });
      // remotes run on neutral local input: their motion is the interpolated network
      // state, so local bot think()/fires/jumps can't desync or double-fire events
      for (let i = 0; i < sim.players.length; i++) if (i !== me) sim.players[i]._mpInput = NEUTRAL;
      sim.players[me]._serverLife = true;
      sim.begin(); // start the local countdown; server state syncs the exact cd within 50ms
      vis = sim.players.map(() => ({ phase: Math.random() * TAU, squash: 0, dust: 0 }));
      flags = [];
      for (let i = 1; i < sim.cps.length; i++) {
        const sl = sim.solids.find(o => o.cp === i);
        if (sl) flags.push({ i, x: sl.cx - (sl.hx - 0.6), y: sl.cy + sl.hy, z: sl.cz - sl.hz + 1.2 });
      }
      const fin = sim.solids.find(o => o.name === 'finish'), sta = sim.solids.find(o => o.name === 'start');
      world.finishTop = fin ? fin.cy + fin.hy : 3; world.startTop = sta ? sta.cy + sta.hy : 0;
      P.life.fill(0);
      mode = 'play'; cam.init = false; cam.shake = 0; lastN = 0; resultsAt = 0; resultsShown = false;
      clearInput();
      $('results').classList.add('hidden');
      $('hud').classList.remove('hidden');
      $('touch').classList.toggle('hidden', !touchOn);
      veilOn = false; $('veil').classList.remove('on'); $('count').textContent = ''; $('ammo').classList.remove('hidden');
      buildDots();
      // re-ack so the lobby can stop its 500 ms init retry loop after a
      // rematch re-init (it only receives mp_ready once at load otherwise)
      if (mpHost) mpHost.postMessage({ type: 'mp_ready' }, '*');
    }
    else if (e.data.type === 'mp_state' && sim) {
      const s = decodeState(e.data.data);  // compact wire arrays → legacy shape
      const now = performance.now(), nowS = now / 1000;
      if (netStats.lastStateNow) netStats.gaps.push(now - netStats.lastStateNow);
      if (netStats.gaps.length > 60) netStats.gaps.shift();
      netStats.lastStateNow = now;
      snapBuf.push(s);
      // time-based cap: keep enough history for the adaptive delay instead of a
      // fixed packet count, so extra buffer becomes headroom under latency
      while (snapBuf.length > 2 && s.t - snapBuf[0].t > BUF_AGE) snapBuf.shift();
      // soft clock alignment: record the smoothed server/client clock offset;
      // applyNet() eases sim.t toward it instead of hard-snapping the whole scene
      const off = s.t - nowS;
      srvOffset = srvOffset === null ? off : srvOffset + (off - srvOffset) * 0.1;
      updateDelayTarget();
      // Never regress phase from 'race' back to 'countdown' on a slightly late snapshot
      if (!(sim.phase === 'race' && s.phase === 'countdown')) {
        sim.phase = s.phase; sim.cd = s.cd;
      }
      sim.finishCount = s.finishCount;
      if (s.phase !== lastNetPhase) {
        const expectedGo = lastNetPhase === 'countdown' && s.phase === 'race';
        lastNetPhase = s.phase;
        if (!expectedGo) needHardSnapMe = true;
      }
      const mySp = s.players[me];
      const myAck = mySp && mySp.ack > 0 ? mySp.ack : 0;
      const unackedWin = netStats.rtt > 0 ? netStats.rtt / 1000 + 0.15 : 0.35;
      for (let i = 0; i < s.players.length; i++) {
        const p = sim.players[i], sp = s.players[i];
        if (!p || !sp) continue;

        if (i === me) {
          const lifeReady = syncOwnLife(p, sp, nowS);
          p.falls = sp.falls; p.bonks = sp.bonks;
          // Checkpoints and finish are monotonic within a race: never regress them on stale snapshots
          p.cp = Math.max(p.cp, sp.cp);
          if (sp.finished) {
            p.finished = true; p.finishT = sp.finishT; p.place = sp.place;
          } else if (!p.finished) {
            p.place = sp.place;
          }
          // Protect local dive and ammo during the unacknowledged input window
          const diveUnacked = lastDiveStamp > 0 && (myAck > 0 ? myAck < lastDiveStamp + 0.05 : (nowS - lastDiveStamp) < unackedWin);
          const diveJustEnded = lastDiveStamp > 0 && p.diveT <= 0 && (nowS - lastDiveStamp) < unackedWin + 0.6;
          if (!diveUnacked && !(diveJustEnded && sp.diveT > 0)) {
            p.diveT = sp.diveT;
          }
          if (sp.stun > 0.55 || (!diveUnacked && !diveJustEnded)) {
            p.stun = sp.stun;
          }
          const actStamp = Math.max(lastFireStamp, lastPickupStamp);
          const ammoUnacked = actStamp > 0 && (myAck > 0 ? myAck < actStamp + 0.05 : (nowS - actStamp) < unackedWin);
          if (!ammoUnacked) p.ammo = sp.ammo;

          // position correction happens in applyNet(); keep the last server sample as target
          netMine = { x: sp.x, y: sp.y, z: sp.z, yaw: sp.yaw, vx: sp.vx, vy: sp.vy, vz: sp.vz, ground: sp.ground, t: s.t };  // (reconcileOwn reads sp.ack)
          if (lifeReady) reconcileOwn(s, sp, nowS, p);
        } else {
          p.stun = sp.stun; p.diveT = sp.diveT; p.dead = sp.dead; p.protect = sp.protect;
          p.ammo = sp.ammo; p.cp = sp.cp; p.finished = sp.finished; p.finishT = sp.finishT;
          p.place = sp.place; p.falls = sp.falls; p.bonks = sp.bonks;
        }
        // remotes: pos/vel/yaw are set by applyNet() from the interpolation buffer
      }
      for (const st of s.tiles) {
        const tl = sim.solids[st.id];
        if (!tl) continue;
        if (st.state === 'idle' && tl.state === 'shake' && tl._shakeAt && (nowS - tl._shakeAt) < unackedWin + 0.3) continue;
        if (st.state === 'idle') tl._shakeAt = 0;
        tl.state = st.state; tl.active = st.active;
      }
      // sim.bullets: my bullets stay local; remotes are rebuilt by applyNet() from snapBuf
      for (let i = 0; i < s.pickups.length; i++) {
        const pk = sim.pickups[i];
        if (!pk) continue;
        if (s.pickups[i].on && !pk.on && pk._localOffAt && (nowS - pk._localOffAt) < unackedWin + 0.3) continue;
        if (!s.pickups[i].on) pk._localOffAt = 0;
        pk.on = s.pickups[i].on;
      }
    }
    else if (e.data.type === 'mp_events' && sim) {
      // Remotes run on neutral local input, so their active effects never fire locally:
      // relay fire/jump/dive for them. Everything else (bonk/hit/spark/pickup/cp/finish/
      // land/fall/respawn...) is produced by my local sim on network-true positions, so
      // relaying it too would double-play; my own events are always local.
      // Each is scheduled for the render time when the remote reaches its spot
      // (ev.st, the server time the server stamped it) rather than firing now.
      const events = e.data.data.filter(ev => ev.id !== me && ev.by !== me &&
        (ev.t === 'fire' || ev.t === 'jump' || ev.t === 'dive'));
      for (const ev of events) {
        evQueue.push({ at: typeof ev.st === 'number' ? ev.st : sim.t - interpDelay, ev });
      }
    }
    else if (e.data.type === 'mp_pong') {
      updateRtt(performance.now() - e.data.ts);  // smoothed — see updateRtt()
    }
  });
} else {
  pick(myKind);
}

requestAnimationFrame(frame);
window.__race = { get sim() { return sim; }, get mode() { return mode; }, get me() { return me; }, start: startGame, menu: goMenu, pause(v) { paused = !!v; } };
})();
