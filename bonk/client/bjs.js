/* ======================================================================
   BJS - Babylon.js renderer for Sim Race (replaces gl.js / GFX).

   game.js keeps all input, HUD, audio, particles-as-data and camera logic.
   This module only draws: it reads the sim state every frame and updates
   a retained Babylon scene (course solids, racers, pickups, bullets,
   clouds, checkpoint flags, particles).

   Babylon features used: StandardMaterial + vertex colours, hemispheric and
   directional lights, ShadowGenerator (PCF, light frustum follows the
   action), GlowLayer, built-in outline renderer, SolidParticleSystem,
   linear fog, hardware scaling, optional Inspector (?inspector).

   URL flags:  ?shadows=0  ?glow=0  ?outline=0  ?lowfx=1  ?debug  ?inspector

   Axes match the sim: +Z forward, +Y up, Babylon's default left-handed
   system, so `rotation.y = yaw` is the sim's yaw with no conversion.
   ====================================================================== */
const BJS = (() => {
'use strict';
const API = { ok: false, error: '', failed: [] };
try {
if (typeof BABYLON === 'undefined') { API.error = 'the Babylon.js script did not load (check your internet connection)'; return API; }
const B = BABYLON;
const canvas = document.getElementById('gl');

/* ---------------- options ---------------- */
const qs = new URLSearchParams(location.search);
const flag = (k, d) => (qs.has(k) ? qs.get(k) !== '0' : d);
const COARSE = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
const LOW = qs.has('lowfx') ? qs.get('lowfx') !== '0' : COARSE;
const OPT = { shadows: flag('shadows', true), glow: flag('glow', !LOW), outline: flag('outline', true), debug: qs.has('debug'), inspector: qs.has('inspector') };

/* ---------------- small helpers ---------------- */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const cache = new Map();
function rgb(hex, k) {
  const m = k || 1, key = hex + '|' + m;
  let c = cache.get(key);
  if (!c) {
    const n = parseInt(hex.slice(1), 16);
    c = [((n >> 16) & 255) / 255 * m, ((n >> 8) & 255) / 255 * m, (n & 255) / 255 * m];
    cache.set(key, c);
  }
  return c;
}
const INK = [0.165, 0.102, 0.369], WHITE = [1, 1, 1], BLACK = [0, 0, 0];
const YELLOW = [1, 0.82, 0.25], YELLOW_EM = [0.45, 0.36, 0.04], MINT = [0.37, 0.95, 0.65];
const PAD_EM = [0.16, 0.48, 0.30], HUB = [1, 0.82, 0.25], HOUSE = [0.72, 0.22, 0.42], ROD = [0.86, 0.86, 0.93], POLE = [0.32, 0.26, 0.55];
const CLOUD = [1, 1, 1], CLOUD_EM = [0.30, 0.30, 0.36], OFFWHITE = [1, 0.96, 0.92];
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const c3 = a => new B.Color3(a[0], a[1], a[2]);

/* ---------------- engine, scene, camera, lights ---------------- */
let engine, scene, cam, hemi, sun, shadowGen = null, glowLayer = null;
const SUN_DIR = (() => { const x = -0.4, y = -0.8, z = 0.45, l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; })();
const focus = { x: 0, y: 0, z: 0 };
const tmpT = () => new B.Vector3(0, 0, 0);
let tgt = null, dpr = 1;
try {
  engine = new B.Engine(canvas, true, { alpha: true, premultipliedAlpha: true, stencil: true, powerPreference: 'high-performance' }, false);
  dpr = Math.min(window.devicePixelRatio || 1, LOW ? 1.5 : 2);
  engine.setHardwareScalingLevel(1 / dpr);
  scene = new B.Scene(engine);
  scene.clearColor = new B.Color4(0, 0, 0, 0);          // the page's CSS sky shows through
  scene.skipPointerMovePicking = true;
  try { scene.detachControl(); } catch (_) {}      // game.js owns all input; keep Babylon's pointer/keyboard handlers off the canvas
  scene.fogMode = B.Scene.FOGMODE_LINEAR;
  scene.fogColor = new B.Color3(0.80, 0.91, 1.0);
  scene.fogStart = 90; scene.fogEnd = 340;

  cam = new B.FreeCamera('cam', new B.Vector3(0, 6, -10), scene);
  cam.minZ = 0.2; cam.maxZ = 700; cam.fov = 1.05;
  scene.activeCamera = cam;
  tgt = tmpT();

  hemi = new B.HemisphericLight('hemi', new B.Vector3(0, 1, 0), scene);
  hemi.diffuse = new B.Color3(0.64, 0.66, 0.74);
  hemi.groundColor = new B.Color3(0.50, 0.45, 0.62);
  hemi.specular = new B.Color3(0, 0, 0);
  sun = new B.DirectionalLight('sun', new B.Vector3(SUN_DIR[0], SUN_DIR[1], SUN_DIR[2]), scene);
  sun.diffuse = new B.Color3(0.40, 0.38, 0.34);
  sun.specular = new B.Color3(0, 0, 0);
  sun.position = new B.Vector3(0, 40, -20);
} catch (e) {
  API.error = (e && e.message) || String(e);
  return API;
}

/* optional effects are isolated: a failure turns one effect off instead of the game */
function tryFx(name, fn) {
  try { fn(); } catch (e) { API.failed.push(name); try { console.warn('[BJS] ' + name + ' disabled:', e); } catch (_) {} }
}

tryFx('shadows', () => {
  if (!OPT.shadows) return;
  const R = 30;
  sun.autoUpdateExtends = false; sun.autoCalcShadowZBounds = false;
  sun.orthoLeft = -R; sun.orthoRight = R; sun.orthoTop = R; sun.orthoBottom = -R;
  sun.shadowFrustumSize = R * 2;
  sun.shadowMinZ = 1; sun.shadowMaxZ = 120;
  shadowGen = new B.ShadowGenerator(LOW ? 512 : 1024, sun);
  shadowGen.usePercentageCloserFiltering = true;
  shadowGen.bias = 0.0015; shadowGen.normalBias = 0.03;
  shadowGen.setDarkness(0.25);
});

/* ---------------- materials ---------------- */
function stdMat(name, diffuse, emissive) {
  const m = new B.StandardMaterial(name, scene);
  m.diffuseColor = c3(diffuse || WHITE);
  m.specularColor = new B.Color3(0, 0, 0);
  if (emissive) m.emissiveColor = c3(emissive);
  m.backFaceCulling = false;                 // geometry below carries explicit outward normals
  return m;
}
const matVC = stdMat('vc', WHITE);           // vertex-coloured, lit
const matCloud = stdMat('cloud', CLOUD, CLOUD_EM);
const matYellow = stdMat('yellow', YELLOW, YELLOW_EM);
const matBullet = stdMat('bullet', YELLOW, [0.7, 0.55, 0.1]);
const matFlagOff = stdMat('flagOff', WHITE), matFlagOn = stdMat('flagOn', MINT, [0.1, 0.3, 0.2]);
const matBlob = stdMat('blob', BLACK, INK);   // unlit ink colour; per-racer strength comes from mesh.visibility
matBlob.disableLighting = true;

/* ---------------- geometry (plain arrays, explicit normals and RGBA vertex colours) ---------------- */
const newG = () => ({ p: [], n: [], c: [], i: [] });
function pushV(g, x, y, z, nx, ny, nz, col) { g.p.push(x, y, z); g.n.push(nx, ny, nz); g.c.push(col[0], col[1], col[2], 1); return g.p.length / 3 - 1; }
function quad(g, a, b, c, d, n, col) {
  const i0 = pushV(g, a[0], a[1], a[2], n[0], n[1], n[2], col);
  pushV(g, b[0], b[1], b[2], n[0], n[1], n[2], col);
  pushV(g, c[0], c[1], c[2], n[0], n[1], n[2], col);
  pushV(g, d[0], d[1], d[2], n[0], n[1], n[2], col);
  g.i.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
}
/* breakpoints from -h to h: interior cuts on multiples of `step`; optional rim band of width `rim` */
function cuts(h, step, rim) {
  const a = [-h], eps = 1e-6, inner0 = rim ? -h + rim : -h, inner1 = rim ? h - rim : h;
  if (rim && h > rim * 2) a.push(inner0);
  if (step) for (let k = Math.ceil((inner0 + eps) / step); k * step < inner1 - eps; k++) { const v = k * step; if (v > a[a.length - 1] + eps) a.push(v); }
  if (rim && h > rim * 2) a.push(inner1);
  a.push(h);
  return a;
}
/* one box face as a grid; origin/u/v are the face centre and two axis vectors (unit), hu/hv half sizes */
function face(g, o, u, v, n, hu, hv, stepU, stepV, rim, colorFn) {
  const us = cuts(hu, stepU, rim), vs = cuts(hv, stepV, rim);
  for (let iu = 0; iu < us.length - 1; iu++) for (let iv = 0; iv < vs.length - 1; iv++) {
    const u0 = us[iu], u1 = us[iu + 1], v0 = vs[iv], v1 = vs[iv + 1];
    const P = (a, b) => [o[0] + u[0] * a + v[0] * b, o[1] + u[1] * a + v[1] * b, o[2] + u[2] * a + v[2] * b];
    const edge = rim && (iu === 0 || iv === 0 || iu === us.length - 2 || iv === vs.length - 2);
    quad(g, P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1), n, colorFn((u0 + u1) / 2, (v0 + v1) / 2, !!edge));
  }
}
/* box centred on the origin. pat: null | 'checker' (soft tiles + dark rim) | 'stripes' | 'strip' | 'banner' */
function boxGeo(hx, hy, hz, col, pat) {
  const g = newG(), side = mul(col, 0.9);
  const par = (a, b, s) => (Math.floor(a / s) + Math.floor(b / s)) & 1;
  const flat = c => () => c;
  // top
  if (pat === 'checker') face(g, [0, hy, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0], hx, hz, 2, 2, 0.14, (a, b, edge) => (edge ? mul(col, 0.55) : mul(col, par(a, b, 2) ? 1.0 : 0.9)));
  else if (pat === 'strip') face(g, [0, hy, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0], hx, hz, 1, 1, 0, (a, b) => (par(a, b, 1) ? WHITE : INK));
  else if (pat === 'banner') face(g, [0, hy, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0], hx, hz, 0.75, 0.75, 0, (a, b) => (par(a, b, 0.75) ? WHITE : INK));
  else if (pat === 'stripes') face(g, [0, hy, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0], hx, hz, 0.75, 0, 0, (a) => (par(a + 1e3, 0, 0.75) ? mix(col, OFFWHITE, 0.88) : col));
  else face(g, [0, hy, 0], [1, 0, 0], [0, 0, 1], [0, 1, 0], hx, hz, 0, 0, 0, flat(col));
  // sides and bottom
  const sideFn = (stepU, uAxis) => {
    if (pat === 'banner') return (a, b) => (par(a, b, 0.75) ? WHITE : INK);
    if (pat === 'stripes' && uAxis === 'x') return (a) => (par(a + 1e3, 0, 0.75) ? mix(col, OFFWHITE, 0.88) : col);
    if (pat === 'strip') return () => WHITE;
    return () => side;
  };
  const stepOf = (axis) => (pat === 'banner' ? 0.75 : pat === 'stripes' && axis === 'x' ? 0.75 : 0);
  face(g, [0, -hy, 0], [1, 0, 0], [0, 0, 1], [0, -1, 0], hx, hz, 0, 0, 0, () => mul(col, 0.7));
  face(g, [0, 0, hz], [1, 0, 0], [0, 1, 0], [0, 0, 1], hx, hy, stepOf('x'), pat === 'banner' ? 0.75 : 0, 0, sideFn(0, 'x'));
  face(g, [0, 0, -hz], [1, 0, 0], [0, 1, 0], [0, 0, -1], hx, hy, stepOf('x'), pat === 'banner' ? 0.75 : 0, 0, sideFn(0, 'x'));
  face(g, [hx, 0, 0], [0, 0, 1], [0, 1, 0], [1, 0, 0], hz, hy, pat === 'banner' ? 0.75 : 0, pat === 'banner' ? 0.75 : 0, 0, sideFn(0, 'z'));
  face(g, [-hx, 0, 0], [0, 0, 1], [0, 1, 0], [-1, 0, 0], hz, hy, pat === 'banner' ? 0.75 : 0, pat === 'banner' ? 0.75 : 0, 0, sideFn(0, 'z'));
  return g;
}
/* unit prototypes, ported from gl.js: cylinder (h=1, y in [-.5,.5]), sphere (r=1), cone */
function cylProto(seg, rTop, rBot, capTop, capBot) {
  const g = { p: [], n: [], i: [] }, slope = rBot - rTop;
  for (let j = 0; j <= seg; j++) {
    const a = j / seg * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), l = Math.hypot(c, slope, s);
    g.p.push(c * rTop, 0.5, s * rTop, c * rBot, -0.5, s * rBot);
    g.n.push(c / l, slope / l, s / l, c / l, slope / l, s / l);
  }
  for (let j = 0; j < seg; j++) { const A = 2 * j; g.i.push(A, A + 3, A + 1, A, A + 2, A + 3); }
  const cap = (y, ny, r, top) => {
    const base = g.p.length / 3;
    g.p.push(0, y, 0); g.n.push(0, ny, 0);
    for (let j = 0; j <= seg; j++) { const a = j / seg * Math.PI * 2; g.p.push(Math.cos(a) * r, y, Math.sin(a) * r); g.n.push(0, ny, 0); }
    for (let j = 0; j < seg; j++) (top ? g.i.push(base, base + j + 2, base + j + 1) : g.i.push(base, base + j + 1, base + j + 2));
  };
  if (capTop && rTop > 0) cap(0.5, 1, rTop, true);
  if (capBot && rBot > 0) cap(-0.5, -1, rBot, false);
  return g;
}
function sphereProto(rows, cols) {
  const g = { p: [], n: [], i: [] };
  for (let i = 0; i <= rows; i++) {
    const th = i / rows * Math.PI, st = Math.sin(th), ct = Math.cos(th);
    for (let j = 0; j <= cols; j++) { const ph = j / cols * Math.PI * 2, x = st * Math.cos(ph), z = st * Math.sin(ph); g.p.push(x, ct, z); g.n.push(x, ct, z); }
  }
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) { const a = i * (cols + 1) + j, b = a + cols + 1; g.i.push(a, a + 1, b, a + 1, b + 1, b); }
  return g;
}
const PROTO = { cyl: cylProto(18, 1, 1, true, true), cone: cylProto(14, 0, 1, false, true), sphere: sphereProto(10, 16) };
/* append a transformed, uniformly coloured copy of a prototype */
function addProto(dst, src, tx, ty, tz, sx, sy, sz, col) {
  const base = dst.p.length / 3;
  for (let k = 0; k < src.p.length; k += 3) {
    dst.p.push(src.p[k] * sx + tx, src.p[k + 1] * sy + ty, src.p[k + 2] * sz + tz);
    let nx = src.n[k] / sx, ny = src.n[k + 1] / sy, nz = src.n[k + 2] / sz; const l = Math.hypot(nx, ny, nz) || 1;
    dst.n.push(nx / l, ny / l, nz / l);
    dst.c.push(col[0], col[1], col[2], 1);
  }
  for (let k = 0; k < src.i.length; k++) dst.i.push(src.i[k] + base);
}
/* round platform: wedge pattern on top, radial wall */
function discGeo(R, hh, col) {
  const g = newG(), wedges = 8, sub = 4, N = wedges * sub, light = mix(col, WHITE, 0.5), side = mul(col, 0.9);
  for (let w = 0; w < wedges; w++) {
    const wc = w & 1 ? light : col;
    for (let s = 0; s < sub; s++) {
      const a0 = (w * sub + s) / N * Math.PI * 2, a1 = (w * sub + s + 1) / N * Math.PI * 2;
      const i0 = pushV(g, 0, hh, 0, 0, 1, 0, wc);
      pushV(g, Math.cos(a0) * R, hh, Math.sin(a0) * R, 0, 1, 0, wc);
      pushV(g, Math.cos(a1) * R, hh, Math.sin(a1) * R, 0, 1, 0, wc);
      g.i.push(i0, i0 + 1, i0 + 2);
      const j0 = pushV(g, 0, -hh, 0, 0, -1, 0, mul(col, 0.7));
      pushV(g, Math.cos(a0) * R, -hh, Math.sin(a0) * R, 0, -1, 0, mul(col, 0.7));
      pushV(g, Math.cos(a1) * R, -hh, Math.sin(a1) * R, 0, -1, 0, mul(col, 0.7));
      g.i.push(j0, j0 + 1, j0 + 2);
      const k0 = pushV(g, Math.cos(a0) * R, hh, Math.sin(a0) * R, Math.cos(a0), 0, Math.sin(a0), side);
      pushV(g, Math.cos(a0) * R, -hh, Math.sin(a0) * R, Math.cos(a0), 0, Math.sin(a0), side);
      pushV(g, Math.cos(a1) * R, -hh, Math.sin(a1) * R, Math.cos(a1), 0, Math.sin(a1), side);
      pushV(g, Math.cos(a1) * R, hh, Math.sin(a1) * R, Math.cos(a1), 0, Math.sin(a1), side);
      g.i.push(k0, k0 + 1, k0 + 2, k0, k0 + 2, k0 + 3);
    }
  }
  return g;
}

function toMesh(name, g, material) {
  const m = new B.Mesh(name, scene), vd = new B.VertexData();
  vd.positions = g.p; vd.indices = g.i; vd.normals = g.n; vd.colors = g.c;
  vd.applyToMesh(m);
  m.material = material || matVC;
  m.isPickable = false;
  return m;
}
const node = name => new B.TransformNode(name, scene);

/* ---------------- world (built once, positions synced per frame) ---------------- */
let cloudsFor = null;
const W = { built: false, key: '', solids: [], deco: [], clouds: [], flags: [], fixed: [], rods: [] };

function addCaster(m) { if (shadowGen) tryFx('caster', () => shadowGen.addShadowCaster(m, false)); }
function glowOnly(m) { if (glowLayer) tryFx('glowMesh', () => glowLayer.addIncludedOnlyMesh(m)); }

function disposeWorld() {
  for (const m of W.fixed) m.dispose();
  for (const e of W.solids) { e.mesh.dispose(); if (e.rod) e.rod.dispose(); }
  for (const e of W.deco) e.mesh.dispose();
  for (const c of W.clouds) c.mesh.dispose();
  for (const f of W.flags) { f.pole.dispose(); f.cloth.dispose(); }
  W.fixed = []; W.solids = []; W.deco = []; W.clouds = []; W.flags = []; W.built = false;
  W.flagCount = -1; cloudsFor = null;
}

function buildWorld(sim, world) {
  disposeWorld();
  sim.solids.forEach((s, i) => {
    const col = rgb(s.color);
    let mesh, mat = matVC, pat = null, freeze = false;
    switch (s.shape) {
      case 'slab': case 'mover': case 'tile': pat = 'checker'; break;
      case 'bar': case 'piston': pat = 'stripes'; break;
    }
    if (s.shape === 'disc') mesh = toMesh('disc' + i, discGeo(s.hx, s.hy, col), matVC);
    else if (s.shape === 'pad') mesh = toMesh('pad' + i, boxGeo(s.hx, s.hy, s.hz, WHITE, null), stdMat('pad' + i, col, PAD_EM));
    else mesh = toMesh(s.shape + i, boxGeo(s.hx, s.hy, s.hz, col, pat), mat);
    if (s.kind === 'crumble') mesh.material = stdMat('tile' + i, WHITE);      // own material so the tint can change
    mesh.receiveShadows = !!shadowGen;
    if (s.shape === 'bar' || s.shape === 'piston') addCaster(mesh);
    if (s.shape === 'pad') glowOnly(mesh);
    mesh.position.set(s.cx, s.cy, s.cz); mesh.rotation.y = s.yaw;
    freeze = s.kind === 'static' && s.shape !== 'pad';
    if (freeze) mesh.freezeWorldMatrix();
    const e = { i, mesh, freeze, on: true, rod: null, tint: 0 };
    if (s.kind === 'piston') {
      e.rod = toMesh('rod' + i, boxGeo(0.5, 0.5, 0.5, ROD, null), matVC);
      e.rod.scaling.set(1, 0.28, 0.28);
    }
    W.solids.push(e);
  });
  for (const d of sim.deco) {
    let mesh = null;
    if (d.shape === 'hub') { const g = newG(); addProto(g, PROTO.cyl, 0, 0, 0, 0.62, 1.56, 0.62, HUB); mesh = toMesh('hub', g, matVC); mesh.position.set(d.x, d.y + 0.78, d.z); }
    else if (d.shape === 'rail') { mesh = toMesh('rail', boxGeo(0.45, 0.75, 1.3, HOUSE, null), matVC); mesh.position.set(d.x, d.y + 0.75, d.z); }
    if (mesh) { mesh.freezeWorldMatrix(); mesh.receiveShadows = !!shadowGen; W.deco.push({ mesh }); }
  }
  // start line, finish line and gantry
  const fz = sim.finishZ;
  const fixed = (name, hx, hy, hz, col, pat, x, y, z) => { const m = toMesh(name, boxGeo(hx, hy, hz, col, pat), matVC); m.position.set(x, y, z); m.freezeWorldMatrix(); W.fixed.push(m); return m; };
  fixed('startLine', 7.5, 0.03, 0.5, WHITE, 'strip', 0, world.startTop + 0.03, 1.8);
  fixed('finishLine', 7, 0.03, 1, WHITE, 'strip', 0, world.finishTop + 0.03, fz + 0.9);
  fixed('postL', 0.4, 3.6, 0.4, [1, 0.56, 0.72], null, -7.6, world.finishTop + 2.3, fz + 0.9);
  fixed('postR', 0.4, 3.6, 0.4, [1, 0.56, 0.72], null, 7.6, world.finishTop + 2.3, fz + 0.9);
  fixed('banner', 8, 0.8, 0.35, WHITE, 'banner', 0, world.finishTop + 5.4, fz + 0.9);
  // clouds (merged spheres, bobbing as a unit)
  W.built = true;
  W.key = sim.solids.length + ':' + sim.deco.length + ':' + fz;
}

/* clouds are not part of the sim: the same layout as game.js */
function buildClouds(list) {
  for (const c of W.clouds) c.mesh.dispose();
  W.clouds = list.map(c => {
    const g = newG();
    for (const b of c.b) addProto(g, PROTO.sphere, b[0] * c.s, b[1] * c.s, b[2] * c.s, b[3] * c.s, b[3] * c.s * 0.7, b[3] * c.s, CLOUD);
    const mesh = toMesh('cloud', g, matCloud);
    mesh.position.set(c.x, c.y, c.z); mesh.isPickable = false;
    return { mesh, c };
  });
}

function buildFlags(flags) {
  for (const f of W.flags) { f.pole.dispose(); f.cloth.dispose(); }
  W.flags = flags.map(f => {
    const pole = toMesh('pole', boxGeo(0.07, 1.0, 0.07, POLE, null), matVC); pole.position.set(f.x, f.y + 1.0, f.z); pole.freezeWorldMatrix();
    const cloth = toMesh('cloth', boxGeo(0.45, 0.25, 0.03, WHITE, null), matFlagOff);
    cloth.position.set(f.x - Math.sign(f.x || 1) * 0.5, f.y + 1.72, f.z); cloth.freezeWorldMatrix();
    return { f, pole, cloth, on: false };
  });
  W.flagCount = flags.length;
}

/* ---------------- racers ---------------- */
const rigs = [];
function buildRig(K, id) {
  const g = newG(), col = K.rgb, lite = K.lite, big = K.hat === 'none' ? 1.3 : 1;
  addProto(g, PROTO.cyl, 0, 0.75, 0, 0.42, 0.66, 0.42, col);
  addProto(g, PROTO.sphere, 0, 0.42, 0, 0.42, 0.42, 0.42, col);
  addProto(g, PROTO.sphere, 0, 1.08, 0, 0.42, 0.42, 0.42, col);
  addProto(g, PROTO.sphere, -0.155, 1.2, 0.33, 0.12 * big, 0.125 * big, 0.1, WHITE);
  addProto(g, PROTO.sphere, 0.155, 1.2, 0.33, 0.115, 0.12, 0.1, WHITE);
  addProto(g, PROTO.sphere, -0.155, 1.2, 0.42, 0.056, 0.06, 0.05, INK);
  addProto(g, PROTO.sphere, 0.155, 1.2, 0.42, 0.056, 0.06, 0.05, INK);
  addProto(g, PROTO.sphere, 0, 0.97, 0.4, 0.09, 0.03, 0.04, INK);
  switch (K.hat) {
    case 'stem': addProto(g, PROTO.cyl, 0, 1.53, 0, 0.07, 0.2, 0.07, K.hc || [0.3, 0.6, 0.3]); break;
    case 'tuft': addProto(g, PROTO.sphere, 0.02, 1.52, 0.04, 0.13, 0.13, 0.13, lite); break;
    case 'antenna':
      addProto(g, PROTO.cyl, 0, 1.6, 0, 0.03, 0.26, 0.03, [0.35, 0.4, 0.55]);
      addProto(g, PROTO.sphere, 0, 1.76, 0, 0.075, 0.075, 0.075, [1, 0.35, 0.45]); break;
    case 'party':
      addProto(g, PROTO.cone, 0, 1.72, 0, 0.2, 0.46, 0.2, YELLOW);
      addProto(g, PROTO.sphere, 0, 1.96, 0, 0.06, 0.06, 0.06, WHITE); break;
  }
  const root = node('racer' + id), pivot = node('pivot' + id);
  pivot.parent = root;
  const body = toMesh('body' + id, g, matVC); body.parent = pivot;
  if (OPT.outline) tryFx('outline', () => { body.renderOutline = true; body.outlineWidth = 0.05; body.outlineColor = c3(INK); });
  const handG = newG(); addProto(handG, PROTO.sphere, 0, 0, 0, 0.13, 0.13, 0.13, lite);
  const footG = newG(); addProto(footG, PROTO.sphere, 0, 0, 0, 0.15, 0.11, 0.22, INK);
  const handL = toMesh('handL' + id, handG, matVC), handR = toMesh('handR' + id, handG, matVC);
  const footL = toMesh('footL' + id, footG, matVC), footR = toMesh('footR' + id, footG, matVC);
  for (const m of [handL, handR, footL, footR]) m.parent = pivot;
  for (const m of [body, handL, handR, footL, footR]) addCaster(m);
  const blob = toMesh('blob' + id, discProtoGeo(), matBlob);
  return { kind: id, root, pivot, body, handL, handR, footL, footR, blob, shown: true, blobShown: true };
}
let _blobG = null;
function discProtoGeo() {
  if (_blobG) return _blobG;
  const g = newG(), seg = 20;
  for (let j = 0; j < seg; j++) {
    const a0 = j / seg * Math.PI * 2, a1 = (j + 1) / seg * Math.PI * 2, i0 = pushV(g, 0, 0, 0, 0, 1, 0, WHITE);
    pushV(g, Math.cos(a0), 0, Math.sin(a0), 0, 1, 0, WHITE); pushV(g, Math.cos(a1), 0, Math.sin(a1), 0, 1, 0, WHITE);
    g.i.push(i0, i0 + 1, i0 + 2);
  }
  return (_blobG = g);
}
function disposeRig(r) { r.root.dispose(); r.blob.dispose(); }
function getRig(q, KINDS) {
  let r = rigs[q.id];
  if (!r || r.kindId !== q.kind) {
    if (r) disposeRig(r);
    r = buildRig(KINDS[q.kind] || KINDS.zombie, q.id); r.kindId = q.kind; rigs[q.id] = r;
  }
  return r;
}
function setOn(obj, key, node, on) { if (obj[key] !== on) { obj[key] = on; node.setEnabled(on); } }

function poseRig(r, q, v, t) {
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
  r.root.position.set(q.x, q.y, q.z); r.root.rotation.y = q.yaw;
  r.pivot.position.set(0, 0.43 * lie, 0); r.pivot.rotation.x = pitch; r.pivot.scaling.set(sxz, sy, sxz);

  const dive = q.diveT > 0, sw = Math.sin(v.phase) * run;
  const hy = dive ? 0.92 : air ? 1.05 : q.stun > 0 ? 1.0 : 0.72, hz = dive ? 0.5 : sw * 0.34;
  r.handL.position.set(-0.52, hy, hz);
  r.handR.position.set(0.52, hy, dive ? hz : -hz);
  const f = v.phase, cf = Math.cos(f) * 0.28 * run;
  r.footL.position.set(-0.2, air ? 0.2 : 0.1 + Math.max(0, Math.sin(f)) * 0.15 * run, air ? 0.16 : 0.06 + cf);
  r.footR.position.set(0.2, air ? 0.2 : 0.1 + Math.max(0, -Math.sin(f)) * 0.15 * run, air ? 0.01 : 0.06 - cf);
}

/* ---------------- pickups, bullets, marker ---------------- */
const pick = [], bul = [];
let marker = null;
function ensureActors(sim) {
  while (pick.length < sim.pickups.length) {
    const m = toMesh('pickup', boxGeo(0.22, 0.22, 0.22, WHITE, null), matYellow);
    glowOnly(m); pick.push({ mesh: m, on: true });
  }
  while (bul.length < 32) {
    const g = newG(); addProto(g, PROTO.sphere, 0, 0, 0, 0.17, 0.17, 0.17, WHITE);
    const m = toMesh('bullet', g, matBullet); glowOnly(m); m.setEnabled(false); bul.push({ mesh: m, on: false });
  }
  if (!marker) {
    const g = newG(); addProto(g, PROTO.cone, 0, 0, 0, 0.3, 0.42, 0.3, WHITE);
    marker = { mesh: toMesh('marker', g, matYellow), on: true };
    marker.mesh.rotation.x = Math.PI;
  }
}

/* ---------------- particles: one SolidParticleSystem of camera-facing quads ---------------- */
const NPART = 440;
let sps = null, spsFlags = null;
tryFx('particles', () => {
  const tex = new B.DynamicTexture('sprite', { width: 64, height: 64 }, scene, false);
  tex.hasAlpha = true;
  const ctx = tex.getContext(), grd = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.55, 'rgba(255,255,255,0.75)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.clearRect(0, 0, 64, 64); ctx.fillStyle = grd; ctx.fillRect(0, 0, 64, 64);
  tex.update();
  const mat = new B.StandardMaterial('spriteMat', scene);
  mat.diffuseTexture = tex; mat.useAlphaFromDiffuseTexture = true;
  mat.disableLighting = true; mat.specularColor = new B.Color3(0, 0, 0);
  mat.backFaceCulling = false; mat.fogEnabled = false;

  const quadMesh = new B.Mesh('spriteQuad', scene), vd = new B.VertexData();
  vd.positions = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
  vd.indices = [0, 1, 2, 0, 2, 3]; vd.normals = [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]; vd.uvs = [0, 0, 1, 0, 1, 1, 0, 1];
  vd.applyToMesh(quadMesh);

  sps = new B.SolidParticleSystem('fx', scene, { updatable: true, isPickable: false });
  sps.addShape(quadMesh, NPART);
  quadMesh.dispose();
  const mesh = sps.buildMesh();
  mesh.material = mat; mesh.hasVertexAlpha = true; mesh.isPickable = false; mesh.alwaysSelectAsActiveMesh = true;
  sps.billboard = true; sps.isAlwaysVisible = true;
  sps.computeParticleRotation = false; sps.computeParticleTexture = false;
  sps.initParticles = () => { for (let i = 0; i < sps.nbParticles; i++) { const p = sps.particles[i]; p.color = new B.Color4(1, 1, 1, 0); p.scaling.set(0, 0, 0); p.isVisible = false; } };
  sps.initParticles(); sps.setParticles();
});

tryFx('glow', () => {
  if (!OPT.glow) return;
  glowLayer = new B.GlowLayer('glow', scene, { mainTextureFixedSize: 256, blurKernelSize: 24 });
  glowLayer.intensity = 0.8;
});

/* ---------------- debug overlay and inspector ---------------- */
let dbg = null, dbgT = 0;
if (OPT.debug) {
  dbg = document.createElement('div');
  dbg.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:98;background:rgba(255,255,255,.9);color:#2a1a5e;font:700 11px/1.3 monospace;padding:4px 8px;border-radius:8px;white-space:pre';
  document.body.appendChild(dbg);
}
if (OPT.inspector) tryFx('inspector', () => {
  const s = document.createElement('script');
  s.src = 'https://cdn.babylonjs.com/inspector/babylon.inspector.bundle.js';
  s.onload = () => { try { scene.debugLayer.show({ embedMode: true }); } catch (e) { console.warn('[BJS] inspector', e); } };
  document.head.appendChild(s);
});

/* ---------------- per-frame API used by game.js ---------------- */
function resizeIfNeeded() {
  const w = Math.max(2, Math.floor(canvas.clientWidth * dpr)), h = Math.max(2, Math.floor(canvas.clientHeight * dpr));
  if (engine.getRenderWidth() !== w || engine.getRenderHeight() !== h) engine.resize();
}
window.addEventListener('resize', () => { try { engine.resize(); } catch (_) {} });

API.rgb = rgb;
API.beginFrame = (ex, ey, ez, tx, ty, tz, fovDeg) => {
  resizeIfNeeded();
  cam.position.set(ex, ey, ez);
  tgt.set(tx, ty, tz); cam.setTarget(tgt);
  cam.fov = fovDeg * Math.PI / 180;
  focus.x = tx; focus.y = ty; focus.z = tz;
};

API.scene = (sim, t, me, flags, world, clouds) => {
  const key = sim.solids.length + ':' + sim.deco.length + ':' + sim.finishZ;
  if (!W.built || W.key !== key) buildWorld(sim, world);
  if (clouds && cloudsFor !== clouds) { cloudsFor = clouds; buildClouds(clouds); }
  if (W.flagCount !== flags.length) buildFlags(flags);

  for (const cl of W.clouds) cl.mesh.position.y = cl.c.y + Math.sin(t * 0.4 + cl.c.ph) * 0.8;

  for (const e of W.solids) {
    const s = sim.solids[e.i];
    const on = s.state !== 'gone';
    if (e.on !== on) { e.on = on; e.mesh.setEnabled(on); if (e.rod) e.rod.setEnabled(on); }
    if (!on || e.freeze) continue;
    const shaking = s.state === 'shake', j = shaking ? Math.sin(t * 90 + e.i * 1.7) * 0.07 : 0;
    e.mesh.position.set(s.cx + j, s.cy, s.cz); e.mesh.rotation.y = s.yaw;
    if (s.shape === 'pad') e.mesh.scaling.y = 1 + 0.16 * Math.sin(t * 7);
    if (s.kind === 'crumble') { const tint = shaking ? 1 : 0; if (e.tint !== tint) { e.tint = tint; e.mesh.material.diffuseColor = tint ? new B.Color3(1, 0.78, 0.7) : new B.Color3(1, 1, 1); } }
    if (e.rod) {
      const hx = s.b.cx - s.dir * 1.2, len = Math.max(0.02, Math.abs(s.cx - hx));
      e.rod.position.set((hx + s.cx) / 2, s.cy, s.cz); e.rod.scaling.x = len;
    }
  }
  const pc = sim.players[me] ? sim.players[me].cp : 0;
  for (const f of W.flags) { const on = pc >= f.f.i; if (on !== f.on) { f.on = on; f.cloth.material = on ? matFlagOn : matFlagOff; } }
};

API.actors = (sim, t, me, vis, KINDS, mode, groundBelow) => {
  ensureActors(sim);
  // pickups
  for (let i = 0; i < pick.length; i++) {
    const k = sim.pickups[i], p = pick[i], on = !!(k && k.on);
    if (p.on !== on) { p.on = on; p.mesh.setEnabled(on); }
    if (!on) continue;
    p.mesh.position.set(k.x, k.y + 0.12 * Math.sin(t * 3 + k.x + k.z), k.z);
    p.mesh.rotation.set(0.6, t * 2.2, 0);
  }
  // bullets
  for (let i = 0; i < bul.length; i++) {
    const b = sim.bullets[i], m = bul[i], on = !!b;
    if (m.on !== on) { m.on = on; m.mesh.setEnabled(on); }
    if (on) m.mesh.position.set(b.x, b.y, b.z);
  }
  // racers
  for (const q of sim.players) {
    const r = getRig(q, KINDS);
    const hidden = q.dead > 0 || (q.protect > 0 && ((t * 14) | 0) % 2 === 1);
    setOn(r, 'shown', r.root, !hidden);
    let blobOn = false;
    if (q.dead <= 0) {
      poseRig(r, q, vis[q.id], t);
      const top = groundBelow(q.x, q.z, q.y + 0.6);
      if (top !== null) {
        const h = Math.max(0, q.y - top), rad = 0.52 - Math.min(h, 7) * 0.035;
        r.blob.position.set(q.x, top + 0.045, q.z); r.blob.scaling.set(rad, 1, rad);
        r.blob.visibility = (shadowGen ? 0.22 : 0.34) * (1 - Math.min(h, 9) / 11);
        blobOn = true;
      }
    }
    setOn(r, 'blobShown', r.blob, blobOn);
  }
  // marker above the human racer
  const p = sim.players[me];
  const showMarker = mode === 'play' && p && p.dead <= 0;
  if (marker.on !== showMarker) { marker.on = showMarker; marker.mesh.setEnabled(showMarker); }
  if (showMarker) marker.mesh.position.set(p.x, p.y + 2.4 + Math.sin(t * 5) * 0.1, p.z);
};

API.fx = (pdata, n) => {
  if (sps) {
    const ps = sps.particles, m = Math.min(n, NPART);
    for (let i = 0; i < m; i++) {
      const p = ps[i], o = i * 8;
      p.position.set(pdata[o], pdata[o + 1], pdata[o + 2]);
      const s = pdata[o + 7]; p.scaling.set(s, s, s);
      p.color.r = pdata[o + 3]; p.color.g = pdata[o + 4]; p.color.b = pdata[o + 5]; p.color.a = pdata[o + 6];
      p.isVisible = true;
    }
    for (let i = m; i < NPART; i++) { const p = ps[i]; if (p.isVisible) { p.isVisible = false; p.scaling.set(0, 0, 0); } }
    sps.setParticles();
  }
  // keep the shadow frustum centred on the action
  if (shadowGen) sun.position = new B.Vector3(focus.x - SUN_DIR[0] * 45, focus.y - SUN_DIR[1] * 45, focus.z - SUN_DIR[2] * 45);
  engine.beginFrame();
  scene.render();
  engine.endFrame();
  if (dbg && (dbgT += 1) % 20 === 0) {
    dbg.textContent = 'Babylon ' + (B.Engine.Version || '?') + '  ' + engine.getFps().toFixed(0) + ' fps\n' +
      'meshes ' + scene.meshes.length + '  active ' + scene.getActiveMeshes().length + '\n' +
      'shadows ' + (shadowGen ? 'on' : 'off') + '  glow ' + (glowLayer ? 'on' : 'off') + '  low ' + (LOW ? 'yes' : 'no') +
      (API.failed.length ? '\noff: ' + API.failed.join(', ') : '');
  }
};

API.ok = true;
API.scene_ = scene; API.engine_ = engine;
return API;
} catch (e) { API.ok = false; API.error = (e && e.message) || String(e); return API; }
})();
