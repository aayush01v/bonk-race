/* ======================================================================
   mock_babylon.js - a STAND-IN for Babylon.js, used only for testing.

   It implements just the API subset that bjs.js calls, with Babylon's
   conventions (left-handed, row-vector matrices, YXZ Euler order,
   LookAtLH / PerspectiveFovLH) and a tiny WebGL rasteriser, so the whole
   game can run headlessly and be screenshotted when the real library
   cannot be downloaded.  Objects are sealed: assigning a property that
   Babylon does not have throws, which catches typos.  Geometry handed to
   VertexData is validated (lengths, index range, unit normals).

   It is NOT Babylon: lighting is approximated, shadows/outlines/glow are
   recorded but not drawn.  Passing against this mock proves the logic of
   bjs.js and the game integration, not that every call matches the real
   Babylon API.
   ====================================================================== */
'use strict';
(() => {
const stats = { renders: 0, applied: 0, warnings: [], disposed: 0, created: {}, outlines: 0, casters: 0, glowMeshes: 0, drawn: 0, particlesDrawn: 0 };
const bump = n => { stats.created[n] = (stats.created[n] || 0) + 1; };
const num = (v, what) => { if (typeof v !== 'number' || !isFinite(v)) throw new TypeError('mock: ' + what + ' must be a finite number, got ' + v); return v; };

/* ---------------- math (row-major, row vectors: v' = v * M) ---------------- */
const I = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mulM = (a, b) => { const o = new Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) o[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j] + a[i * 4 + 3] * b[12 + j]; return o; };
const scaleM = (x, y, z) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
const rotXM = a => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; };
const rotYM = a => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; };
const rotZM = a => { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };
const transM = (x, y, z) => { const m = I(); m[12] = x; m[13] = y; m[14] = z; return m; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function lookAtLH(eye, target, up) {
  const z = norm([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]), x = norm(cross(up, z)), y = norm(cross(z, x));
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}
function perspFovLH(fov, aspect, n, f) {
  const t = 1 / Math.tan(fov / 2);
  return [t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (f - n), 1, 0, 0, -2 * n * f / (f - n), 0];
}

/* ---------------- value types ---------------- */
class Vector3 { constructor(x, y, z) { this.x = num(x === undefined ? 0 : x, 'Vector3.x'); this.y = num(y === undefined ? 0 : y, 'Vector3.y'); this.z = num(z === undefined ? 0 : z, 'Vector3.z'); Object.seal(this); }
  set(x, y, z) { this.x = num(x, 'Vector3.set x'); this.y = num(y, 'Vector3.set y'); this.z = num(z, 'Vector3.set z'); return this; } }
class Color3 { constructor(r, g, b) { this.r = num(r, 'Color3.r'); this.g = num(g, 'Color3.g'); this.b = num(b, 'Color3.b'); Object.seal(this); } }
class Color4 { constructor(r, g, b, a) { this.r = num(r, 'Color4.r'); this.g = num(g, 'Color4.g'); this.b = num(b, 'Color4.b'); this.a = num(a, 'Color4.a'); Object.seal(this); } }

/* ---------------- scene graph ---------------- */
let currentScene = null;
class TransformNode {
  constructor(name, scene) {
    this.name = name; this.parent = null; this.position = new Vector3(0, 0, 0); this.rotation = new Vector3(0, 0, 0); this.scaling = new Vector3(1, 1, 1);
    this._enabled = true; this._frozen = null; this._scene = scene; this._disposed = false;
    if (scene) scene._nodes.push(this);
    if (new.target === TransformNode) { bump('TransformNode'); Object.seal(this); }
  }
  setEnabled(v) { if (typeof v !== 'boolean') throw new TypeError('setEnabled needs a boolean'); this._enabled = v; }
  isEnabled(checkAncestors) { if (!this._enabled) return false; if (checkAncestors === false) return true; return this.parent ? this.parent.isEnabled(true) : true; }
  getWorldMatrix() {
    if (this._frozen) return this._frozen;
    let m = mulM(mulM(scaleM(this.scaling.x, this.scaling.y, this.scaling.z), mulM(mulM(rotZM(this.rotation.z), rotXM(this.rotation.x)), rotYM(this.rotation.y))), transM(this.position.x, this.position.y, this.position.z));
    if (this.parent) m = mulM(m, this.parent.getWorldMatrix());
    return m;
  }
  dispose() { if (this._disposed) return; this._disposed = true; stats.disposed++; const s = this._scene; if (s) { let i = s._nodes.indexOf(this); if (i >= 0) s._nodes.splice(i, 1); i = s.meshes.indexOf(this); if (i >= 0) s.meshes.splice(i, 1); } }
}
class Mesh extends TransformNode {
  constructor(name, scene) {
    super(name, scene);
    this.material = null; this.isPickable = true; this.receiveShadows = false; this.renderOutline = false; this.outlineWidth = 0.02; this.outlineColor = new Color3(0, 0, 0);
    this.visibility = 1; this.hasVertexAlpha = false; this.alwaysSelectAsActiveMesh = false;
    this._geo = null; this._gl = null; this._sps = null;
    if (scene) scene.meshes.push(this);
    if (new.target === Mesh) { bump('Mesh'); Object.seal(this); }
  }
  freezeWorldMatrix() { this._frozen = null; this._frozen = this.getWorldMatrix(); }
  set renderOutlineFlag(v) { }
}
class VertexData {
  constructor() { this.positions = null; this.indices = null; this.normals = null; this.colors = null; this.uvs = null; Object.seal(this); }
  applyToMesh(mesh) {
    const p = this.positions, ix = this.indices, nr = this.normals, co = this.colors, uv = this.uvs;
    if (!p || p.length % 3) throw new Error('mock VertexData: bad positions');
    const n = p.length / 3;
    if (n >= 65536) throw new Error('mock VertexData: ' + n + ' vertices (mesh "' + mesh.name + '") - too many for 16-bit indices');
    if (!ix || ix.length % 3 || !ix.length) throw new Error('mock VertexData: bad indices for "' + mesh.name + '"');
    for (let i = 0; i < ix.length; i++) if (!(ix[i] >= 0 && ix[i] < n && Number.isInteger(ix[i]))) throw new Error('mock VertexData: index out of range in "' + mesh.name + '": ' + ix[i] + ' of ' + n);
    for (let i = 0; i < p.length; i++) num(p[i], 'position');
    if (nr) {
      if (nr.length !== p.length) throw new Error('mock VertexData: normals length mismatch in "' + mesh.name + '"');
      for (let i = 0; i < nr.length; i += 3) { const l = Math.hypot(nr[i], nr[i + 1], nr[i + 2]); if (!(Math.abs(l - 1) < 0.02)) { stats.warnings.push('non-unit normal in ' + mesh.name + ' (' + l.toFixed(3) + ')'); break; } }
    }
    if (co && co.length !== n * 4) throw new Error('mock VertexData: colors need 4 floats per vertex in "' + mesh.name + '" (' + co.length + ' for ' + n + ' vertices)');
    if (uv && uv.length !== n * 2) throw new Error('mock VertexData: uvs length mismatch in "' + mesh.name + '"');
    mesh._geo = { p: Float32Array.from(p), n: nr ? Float32Array.from(nr) : null, c: co ? Float32Array.from(co) : null, uv: uv ? Float32Array.from(uv) : null, i: Uint16Array.from(ix) };
    stats.applied++;
  }
}
class Scene {
  constructor(engine) {
    this._engine = engine; this._nodes = []; this.meshes = []; this.activeCamera = null; this.clearColor = new Color4(0, 0, 0, 1);
    this.skipPointerMovePicking = false; this.fogMode = 0; this.fogColor = new Color3(1, 1, 1); this.fogStart = 0; this.fogEnd = 1;
    this.lights = []; this.glow = null; this.sps = []; this.debugLayer = { show() {} }; this.detached = false;
    currentScene = this; bump('Scene'); Object.seal(this);
  }
  detachControl() { this.detached = true; }
  getActiveMeshes() { return { length: this.meshes.filter(m => m.isEnabled() && m._geo).length }; }
  render() { if (!this.activeCamera) throw new Error('mock: scene.render() with no active camera'); stats.renders++; if (window.__MOCK_DRAW !== false) drawScene(this); }
}
Scene.FOGMODE_LINEAR = 3;
class Engine {
  constructor(canvas, aa, opts, adapt) {
    if (!(canvas instanceof HTMLCanvasElement)) throw new TypeError('mock Engine needs a canvas');
    this.canvas = canvas; this._level = 1; this.opts = opts; this.gl = null; Object.seal(this); bump('Engine');
    this.gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true, stencil: true });
    if (!this.gl) throw new Error('mock Engine: WebGL unavailable');
  }
  setHardwareScalingLevel(l) { this._level = num(l, 'scaling level'); }
  getRenderWidth() { return this.canvas.width; } getRenderHeight() { return this.canvas.height; }
  resize() { this.canvas.width = Math.max(2, Math.floor(this.canvas.clientWidth / this._level)); this.canvas.height = Math.max(2, Math.floor(this.canvas.clientHeight / this._level)); }
  beginFrame() {} endFrame() {} getFps() { return 60; }
}
Engine.Version = '8.20.0-mock';
class FreeCamera extends TransformNode {
  constructor(name, pos, scene) {
    super(name, scene); this.position = pos; this.fov = 0.8; this.minZ = 1; this.maxZ = 10000; this._target = new Vector3(0, 0, 1); bump('FreeCamera'); Object.seal(this);
    scene.activeCamera = scene.activeCamera || this;
  }
  setTarget(t) { this._target = new Vector3(t.x, t.y, t.z); }
}
class Light { constructor(name, dir, scene, kind) {
  this.name = name; this.direction = dir; this.diffuse = new Color3(1, 1, 1); this.specular = new Color3(1, 1, 1); this.intensity = 1; this.kind = kind;
  scene.lights.push(this); }
}
class HemisphericLight extends Light { constructor(n, d, s) { super(n, d, s, 'hemi'); this.groundColor = new Color3(0, 0, 0); bump('HemisphericLight'); Object.seal(this); } }
class DirectionalLight extends Light { constructor(n, d, s) { super(n, d, s, 'sun'); this.position = new Vector3(0, 0, 0);
  this.autoUpdateExtends = true; this.autoCalcShadowZBounds = false; this.orthoLeft = 0; this.orthoRight = 0; this.orthoTop = 0; this.orthoBottom = 0;
  this.shadowFrustumSize = 0; this.shadowMinZ = 0; this.shadowMaxZ = 0; bump('DirectionalLight'); Object.seal(this); } }
class ShadowGenerator { constructor(size, light) { if (!(light instanceof DirectionalLight)) throw new TypeError('mock ShadowGenerator needs a light'); this.size = size; this.light = light;
  this.usePercentageCloserFiltering = false; this.bias = 0; this.normalBias = 0; bump('ShadowGenerator'); Object.seal(this); }
  setDarkness(v) { num(v, 'darkness'); } addShadowCaster(m, inc) { if (!(m instanceof TransformNode)) throw new TypeError('addShadowCaster needs a mesh'); stats.casters++; } }
class StandardMaterial { constructor(name, scene) {
  this.name = name; this.diffuseColor = new Color3(1, 1, 1); this.specularColor = new Color3(1, 1, 1); this.emissiveColor = new Color3(0, 0, 0);
  this.backFaceCulling = true; this.alpha = 1; this.disableLighting = false; this.diffuseTexture = null; this.useAlphaFromDiffuseTexture = false; this.fogEnabled = true;
  bump('StandardMaterial'); Object.seal(this); } }
class DynamicTexture { constructor(name, size, scene, mips) { const w = typeof size === 'number' ? size : size.width, h = typeof size === 'number' ? size : size.height;
  this.canvas = document.createElement('canvas'); this.canvas.width = w; this.canvas.height = h; this.hasAlpha = false; bump('DynamicTexture'); Object.seal(this); }
  getContext() { return this.canvas.getContext('2d'); } update() {} }
class GlowLayer { constructor(name, scene, opts) { this.intensity = 1; this.included = []; scene.glow = this; bump('GlowLayer'); Object.seal(this); }
  addIncludedOnlyMesh(m) { if (!(m instanceof TransformNode)) throw new TypeError('addIncludedOnlyMesh needs a mesh'); this.included.push(m); stats.glowMeshes++; } }
class SolidParticleSystem {
  constructor(name, scene, opts) { this._scene = scene; this.particles = []; this.nbParticles = 0; this.billboard = false; this.isAlwaysVisible = false; this.computeParticleRotation = true; this.computeParticleTexture = true;
    this.initParticles = () => {}; this.mesh = null; this._shape = null; scene.sps.push(this); bump('SolidParticleSystem'); Object.seal(this); }
  addShape(mesh, n) { if (!mesh._geo) throw new Error('mock SPS.addShape: shape mesh has no geometry'); this._shape = mesh._geo;
    for (let i = 0; i < n; i++) this.particles.push({ position: new Vector3(0, 0, 0), scaling: new Vector3(1, 1, 1), color: null, isVisible: true, rotation: new Vector3(0, 0, 0) });
    this.nbParticles = this.particles.length; }
  buildMesh() { const m = new Mesh('sps', this._scene); m._sps = this; m._geo = null; this.mesh = m; return m; }
  setParticles() { stats.spsUpdates = (stats.spsUpdates || 0) + 1; }
}

/* ---------------- rasteriser ---------------- */
const VS = `attribute vec3 aP; attribute vec3 aN; attribute vec4 aC; uniform mat4 uW; uniform mat4 uVP; uniform vec3 uEye;
varying vec3 vN; varying vec4 vC; varying float vD; void main(){ vec4 w=uW*vec4(aP,1.0); vN=normalize(mat3(uW)*aN); vC=aC; vD=distance(w.xyz,uEye); gl_Position=uVP*w; }`;
const FS = `precision mediump float; varying vec3 vN; varying vec4 vC; varying float vD;
uniform vec3 uDiff; uniform vec3 uEmis; uniform float uAlpha; uniform float uUnlit; uniform vec3 uSky; uniform vec3 uGnd; uniform vec3 uSunC; uniform vec3 uSunD; uniform vec3 uFogC; uniform vec2 uFog;
void main(){ vec3 n=normalize(vN); vec3 hemi=mix(uGnd,uSky,0.5+0.5*n.y); float nl=max(dot(n,-uSunD),0.0); vec3 light=uUnlit>0.5?vec3(1.0):hemi+uSunC*nl;
 vec3 col=clamp(light*uDiff+uEmis,0.0,1.0)*vC.rgb; float f=clamp((vD-uFog.x)/(uFog.y-uFog.x),0.0,1.0); gl_FragColor=vec4(mix(col,uFogC,f)*uAlpha,uAlpha); }`;
const PVS = `attribute vec2 aQ; uniform vec3 uCenter; uniform vec3 uRight; uniform vec3 uUp; uniform float uSize; uniform mat4 uVP; varying vec2 vQ;
void main(){ vQ=aQ; vec3 w=uCenter+uRight*aQ.x*uSize+uUp*aQ.y*uSize; gl_Position=uVP*vec4(w,1.0); }`;
const PFS = `precision mediump float; varying vec2 vQ; uniform vec4 uCol; void main(){ float r=length(vQ)*2.0; if(r>1.0) discard; float a=(1.0-r*r)*uCol.a; gl_FragColor=vec4(uCol.rgb*a,a); }`;
const R = {};
function prog(gl, vs, fs) {
  const mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('mock shader: ' + gl.getShaderInfoLog(sh)); return sh; };
  const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('mock link: ' + gl.getProgramInfoLog(p)); return p;
}
function upload(gl, m) {
  const g = m._geo; if (m._gl) return m._gl;
  const buf = (arr, target) => { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, arr, gl.STATIC_DRAW); return b; };
  const n = g.p.length / 3, col = g.c || new Float32Array(n * 4).fill(1), nor = g.n || new Float32Array(n * 3).fill(0);
  m._gl = { p: buf(g.p, gl.ARRAY_BUFFER), n: buf(nor, gl.ARRAY_BUFFER), c: buf(col, gl.ARRAY_BUFFER), i: buf(g.i, gl.ELEMENT_ARRAY_BUFFER), count: g.i.length };
  return m._gl;
}
function drawScene(scene) {
  const eng = scene._engine, gl = eng.gl, cam = scene.activeCamera, cv = eng.canvas;
  if (!R.prog) {
    R.prog = prog(gl, VS, FS); R.pprog = prog(gl, PVS, PFS);
    R.u = {}; for (const k of ['uW', 'uVP', 'uEye', 'uDiff', 'uEmis', 'uAlpha', 'uUnlit', 'uSky', 'uGnd', 'uSunC', 'uSunD', 'uFogC', 'uFog']) R.u[k] = gl.getUniformLocation(R.prog, k);
    R.pu = {}; for (const k of ['uCenter', 'uRight', 'uUp', 'uSize', 'uVP', 'uCol']) R.pu[k] = gl.getUniformLocation(R.pprog, k);
    R.q = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, R.q); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5]), gl.STATIC_DRAW);
  }
  gl.viewport(0, 0, cv.width, cv.height);
  const cc = scene.clearColor; gl.clearColor(cc.r * cc.a, cc.g * cc.a, cc.b * cc.a, cc.a); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.depthMask(true); gl.disable(gl.BLEND);
  const eye = [cam.position.x, cam.position.y, cam.position.z], tg = cam._target;
  const view = lookAtLH(eye, [tg.x, tg.y, tg.z], [0, 1, 0]), proj = perspFovLH(cam.fov, cv.width / cv.height, cam.minZ, cam.maxZ), vp = mulM(view, proj);
  const hemi = scene.lights.find(l => l.kind === 'hemi'), sun = scene.lights.find(l => l.kind === 'sun');
  const dd = norm([sun.direction.x, sun.direction.y, sun.direction.z]);
  gl.useProgram(R.prog);
  gl.uniformMatrix4fv(R.u.uVP, false, vp); gl.uniform3fv(R.u.uEye, eye);
  gl.uniform3f(R.u.uSky, hemi.diffuse.r, hemi.diffuse.g, hemi.diffuse.b); gl.uniform3f(R.u.uGnd, hemi.groundColor.r, hemi.groundColor.g, hemi.groundColor.b);
  gl.uniform3f(R.u.uSunC, sun.diffuse.r, sun.diffuse.g, sun.diffuse.b); gl.uniform3f(R.u.uSunD, dd[0], dd[1], dd[2]);
  gl.uniform3f(R.u.uFogC, scene.fogColor.r, scene.fogColor.g, scene.fogColor.b); gl.uniform2f(R.u.uFog, scene.fogStart, scene.fogEnd);
  for (const loc of [0, 1, 2]) gl.enableVertexAttribArray(loc);
  const aP = gl.getAttribLocation(R.prog, 'aP'), aN = gl.getAttribLocation(R.prog, 'aN'), aC = gl.getAttribLocation(R.prog, 'aC');
  const opaque = [], blended = [];
  for (const m of scene.meshes) {
    if (!m._geo || !m.isEnabled() || m.visibility <= 0) continue;
    const mat = m.material; if (!mat) throw new Error('mock: mesh "' + m.name + '" has no material');
    (m.visibility < 1 || mat.alpha < 1 ? blended : opaque).push(m);
  }
  const drawMesh = m => {
    const mat = m.material, b = upload(gl, m);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.p); gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.n); gl.vertexAttribPointer(aN, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.c); gl.vertexAttribPointer(aC, 4, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.i);
    gl.uniformMatrix4fv(R.u.uW, false, m.getWorldMatrix());
    gl.uniform3f(R.u.uDiff, mat.diffuseColor.r, mat.diffuseColor.g, mat.diffuseColor.b);
    gl.uniform3f(R.u.uEmis, mat.emissiveColor.r, mat.emissiveColor.g, mat.emissiveColor.b);
    gl.uniform1f(R.u.uAlpha, Math.min(mat.alpha, m.visibility)); gl.uniform1f(R.u.uUnlit, mat.disableLighting ? 1 : 0);
    gl.drawElements(gl.TRIANGLES, b.count, gl.UNSIGNED_SHORT, 0); stats.drawn++;
  };
  for (const m of opaque) drawMesh(m);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
  for (const m of blended) drawMesh(m);
  // billboard particles
  gl.useProgram(R.pprog);
  gl.disableVertexAttribArray(1); gl.disableVertexAttribArray(2);
  const aQ = gl.getAttribLocation(R.pprog, 'aQ'); gl.enableVertexAttribArray(aQ); gl.bindBuffer(gl.ARRAY_BUFFER, R.q); gl.vertexAttribPointer(aQ, 2, gl.FLOAT, false, 0, 0);
  gl.uniformMatrix4fv(R.pu.uVP, false, vp); gl.uniform3f(R.pu.uRight, view[0], view[4], view[8]); gl.uniform3f(R.pu.uUp, view[1], view[5], view[9]);
  for (const sps of scene.sps) for (const p of sps.particles) {
    if (!p.isVisible || !p.color || p.scaling.x <= 0 || p.color.a <= 0) continue;
    gl.uniform3f(R.pu.uCenter, p.position.x, p.position.y, p.position.z); gl.uniform1f(R.pu.uSize, p.scaling.x * 2);
    gl.uniform4f(R.pu.uCol, p.color.r, p.color.g, p.color.b, p.color.a); gl.drawArrays(gl.TRIANGLES, 0, 6); stats.particlesDrawn++;
  }
  gl.disableVertexAttribArray(aQ); gl.enableVertexAttribArray(1); gl.enableVertexAttribArray(2); gl.depthMask(true); gl.disable(gl.BLEND);
}

window.BABYLON = { Engine, Scene, FreeCamera, HemisphericLight, DirectionalLight, ShadowGenerator, StandardMaterial, TransformNode, Mesh, VertexData, Vector3, Color3, Color4, DynamicTexture, SolidParticleSystem, GlowLayer };
window.__bjsMock = { stats, get scene() { return currentScene; }, math: { mulM, rotXM, rotYM } };
})();
