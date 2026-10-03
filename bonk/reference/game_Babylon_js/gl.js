/* ======================================================================
   GFX - a small WebGL1 renderer (no libraries).
   Lit meshes with fog and procedural patterns, blob shadows, point-sprite
   particles. X is mirrored in the projection so that +X is screen-right
   while the camera looks down +Z (the axes the sim was written for).
   ====================================================================== */
const GFX = (() => {
'use strict';
const canvas = document.getElementById('gl');
let gl = null;
try {
  gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' })
    || canvas.getContext('experimental-webgl');
} catch (e) { gl = null; }
if (!gl) return null;

const SKY = [0.80, 0.91, 1.0];

/* ---------------- 4x4 matrices (column-major) ---------------- */
const mat = () => new Float32Array(16);
function ident(o) { o.fill(0); o[0] = o[5] = o[10] = o[15] = 1; return o; }
function mul(o, a, b) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7],
        a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  for (let i = 0; i < 16; i += 4) {
    const b0 = b[i], b1 = b[i + 1], b2 = b[i + 2], b3 = b[i + 3];
    o[i]     = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    o[i + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    o[i + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    o[i + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  }
  return o;
}
function perspective(o, fovy, aspect, n, f) {
  const t = 1 / Math.tan(fovy / 2), nf = 1 / (n - f);
  o.fill(0);
  o[0] = t / aspect; o[5] = t; o[10] = (f + n) * nf; o[11] = -1; o[14] = 2 * f * n * nf;
  return o;
}
function lookAt(o, ex, ey, ez, tx, ty, tz) {
  let zx = ex - tx, zy = ey - ty, zz = ez - tz, l = Math.hypot(zx, zy, zz) || 1;
  zx /= l; zy /= l; zz /= l;
  let xx = zz, xz = -zx; l = Math.hypot(xx, xz) || 1; xx /= l; xz /= l;       // up(0,1,0) x z
  const yx = zy * xz, yy = zz * xx - zx * xz, yz = -zy * xx;                    // z x x
  o[0] = xx; o[1] = yx; o[2] = zx; o[3] = 0;
  o[4] = 0;  o[5] = yy; o[6] = zy; o[7] = 0;
  o[8] = xz; o[9] = yz; o[10] = zz; o[11] = 0;
  o[12] = -(xx * ex + xz * ez); o[13] = -(yx * ex + yy * ey + yz * ez); o[14] = -(zx * ex + zy * ey + zz * ez); o[15] = 1;
  return o;
}

/* matrix stack: push / pop / translate / rotate / scale, like old-school GL */
const stack = []; for (let i = 0; i < 20; i++) stack.push(mat());
let sp = 0;
ident(stack[0]);
function push() { stack[sp + 1].set(stack[sp]); sp++; }
function pop() { sp--; }
function translate(x, y, z) {
  const m = stack[sp];
  m[12] += m[0] * x + m[4] * y + m[8] * z;
  m[13] += m[1] * x + m[5] * y + m[9] * z;
  m[14] += m[2] * x + m[6] * y + m[10] * z;
}
function scale(x, y, z) {
  const m = stack[sp];
  m[0] *= x; m[1] *= x; m[2] *= x; m[3] *= x;
  m[4] *= y; m[5] *= y; m[6] *= y; m[7] *= y;
  m[8] *= z; m[9] *= z; m[10] *= z; m[11] *= z;
}
function rotY(a) {
  const c = Math.cos(a), s = Math.sin(a), m = stack[sp];
  const a0 = m[0], a1 = m[1], a2 = m[2], a3 = m[3], c0 = m[8], c1 = m[9], c2 = m[10], c3 = m[11];
  m[0] = a0 * c - c0 * s; m[1] = a1 * c - c1 * s; m[2] = a2 * c - c2 * s; m[3] = a3 * c - c3 * s;
  m[8] = a0 * s + c0 * c; m[9] = a1 * s + c1 * c; m[10] = a2 * s + c2 * c; m[11] = a3 * s + c3 * c;
}
function rotX(a) {
  const c = Math.cos(a), s = Math.sin(a), m = stack[sp];
  const b0 = m[4], b1 = m[5], b2 = m[6], b3 = m[7], c0 = m[8], c1 = m[9], c2 = m[10], c3 = m[11];
  m[4] = b0 * c + c0 * s; m[5] = b1 * c + c1 * s; m[6] = b2 * c + c2 * s; m[7] = b3 * c + c3 * s;
  m[8] = c0 * c - b0 * s; m[9] = c1 * c - b1 * s; m[10] = c2 * c - b2 * s; m[11] = c3 * c - b3 * s;
}
function rotZ(a) {
  const c = Math.cos(a), s = Math.sin(a), m = stack[sp];
  const a0 = m[0], a1 = m[1], a2 = m[2], a3 = m[3], b0 = m[4], b1 = m[5], b2 = m[6], b3 = m[7];
  m[0] = a0 * c + b0 * s; m[1] = a1 * c + b1 * s; m[2] = a2 * c + b2 * s; m[3] = a3 * c + b3 * s;
  m[4] = b0 * c - a0 * s; m[5] = b1 * c - a1 * s; m[6] = b2 * c - a2 * s; m[7] = b3 * c - a3 * s;
}

/* ---------------- shaders ---------------- */
const VS = `
attribute vec3 aPos; attribute vec3 aNor;
uniform mat4 uVP; uniform mat4 uM; uniform mat3 uN; uniform vec3 uEye;
varying vec3 vN; varying vec3 vLocal; varying vec3 vLN; varying float vDist;
void main(){
  vec4 w = uM * vec4(aPos, 1.0);
  vN = uN * aNor; vLocal = aPos; vLN = aNor; vDist = distance(w.xyz, uEye);
  gl_Position = uVP * w;
}`;
const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec3 uColor; uniform vec3 uEmis; uniform vec3 uSize;
uniform vec3 uSky; uniform vec3 uGround; uniform vec3 uSunCol; uniform vec3 uSun;
uniform vec3 uFogCol; uniform vec2 uFog; uniform float uPat; uniform float uAlpha;
varying vec3 vN; varying vec3 vLocal; varying vec3 vLN; varying float vDist;
void main(){
  vec3 n = normalize(vN);
  vec3 col = uColor;
  if (uPat > 0.5 && uPat < 1.5) {                 // soft checker on top faces
    if (vLN.y > 0.5) {
      vec2 c = floor(vLocal.xz * uSize.xz / 2.0);
      col *= 0.90 + 0.10 * mod(c.x + c.y, 2.0);
    }
  } else if (uPat > 1.5 && uPat < 2.5) {          // ink and white checker, every face (banners)
    vec2 q = abs(vLN.y) > 0.5 ? vLocal.xz * uSize.xz : (abs(vLN.x) > 0.5 ? vLocal.zy * uSize.zy : vLocal.xy * uSize.xy);
    vec2 c = floor(q / 0.75);
    col = mix(vec3(0.165, 0.102, 0.369), vec3(1.0), mod(c.x + c.y, 2.0));
  } else if (uPat > 2.5 && uPat < 3.5) {          // hazard stripes
    float s = fract((vLocal.x * uSize.x + vLocal.y * uSize.y) / 1.5);
    col = mix(uColor, vec3(1.0, 0.96, 0.92), step(0.5, s) * 0.88);
  } else if (uPat > 3.5 && uPat < 4.5) {          // start / finish strip: 1 unit checker on top
    if (vLN.y > 0.5) {
      vec2 c = floor(vLocal.xz * uSize.xz);
      col = mix(vec3(0.165, 0.102, 0.369), vec3(1.0), mod(c.x + c.y, 2.0));
    }
  } else if (uPat > 4.5) {                        // spin plate: 8 wedges on top
    if (vLN.y > 0.5) {
      float a = atan(vLocal.z, vLocal.x);
      col = mix(col, vec3(1.0), 0.5 * step(0.5, fract(a / 0.7853982 * 0.5)));
    }
  }
  float hemi = n.y * 0.5 + 0.5;
  vec3 amb = mix(uGround, uSky, hemi);
  float dif = max(dot(n, uSun), 0.0);
  vec3 lit = col * (amb + uSunCol * dif) + uEmis;
  float f = clamp((vDist - uFog.x) / (uFog.y - uFog.x), 0.0, 1.0);
  gl_FragColor = vec4(mix(lit, uFogCol, f), uAlpha);
}`;
const PVS = `
attribute vec3 aPos; attribute vec4 aCol; attribute float aSize;
uniform mat4 uVP; uniform float uScale;
varying vec4 vCol;
void main(){
  vec4 p = uVP * vec4(aPos, 1.0);
  gl_Position = p;
  gl_PointSize = clamp(aSize * uScale / max(p.w, 0.2), 1.0, 160.0);
  vCol = aCol;
}`;
const PFS = `
precision mediump float;
varying vec4 vCol;
void main(){
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  gl_FragColor = vec4(vCol.rgb, vCol.a * (1.0 - r * r));
}`;

function program(vs, fs, attribs) {
  const mk = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  attribs.forEach((a, i) => gl.bindAttribLocation(p, i, a));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
  return p;
}
let PL, PP;
try {
  PL = program(VS, FS, ['aPos', 'aNor']);
  PP = program(PVS, PFS, ['aPos', 'aCol', 'aSize']);
} catch (e) { window.__gfxError = String(e && e.message || e); return null; }

const U = {}, UP = {};
['uVP', 'uM', 'uN', 'uEye', 'uColor', 'uEmis', 'uSize', 'uSky', 'uGround', 'uSunCol', 'uSun', 'uFogCol', 'uFog', 'uPat', 'uAlpha']
  .forEach(n => { U[n] = gl.getUniformLocation(PL, n); });
['uVP', 'uScale'].forEach(n => { UP[n] = gl.getUniformLocation(PP, n); });

/* ---------------- meshes (interleaved position + normal) ---------------- */
function mesh(v, ix) {
  const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
  const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ix, gl.STATIC_DRAW);
  return { vb, ib, n: ix.length };
}
function buildCube() {
  const faces = [
    [1, 0, 0, 0, 1, 0, 0, 0, 1], [-1, 0, 0, 0, 0, 1, 0, 1, 0], [0, 1, 0, 0, 0, 1, 1, 0, 0],
    [0, -1, 0, 1, 0, 0, 0, 0, 1], [0, 0, 1, 1, 0, 0, 0, 1, 0], [0, 0, -1, 0, 1, 0, 1, 0, 0]
  ];
  const v = [], ix = [];
  faces.forEach((f, i) => {
    const [nx, ny, nz, ux, uy, uz, vx, vy, vz] = f;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]])
      v.push((nx + a * ux + b * vx) * 0.5, (ny + a * uy + b * vy) * 0.5, (nz + a * uz + b * vz) * 0.5, nx, ny, nz);
    const o = i * 4; ix.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  return mesh(new Float32Array(v), new Uint16Array(ix));
}
function buildCyl(seg, rTop, rBot, capTop, capBot) {         // height 1, y in [-.5,.5]
  const v = [], ix = [], slope = rBot - rTop;
  for (let j = 0; j <= seg; j++) {
    const a = j / seg * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), l = Math.hypot(c, slope, s);
    v.push(c * rTop, 0.5, s * rTop, c / l, slope / l, s / l);
    v.push(c * rBot, -0.5, s * rBot, c / l, slope / l, s / l);
  }
  for (let j = 0; j < seg; j++) { const A = 2 * j, B = A + 1, C = A + 2, D = A + 3; ix.push(A, D, B, A, C, D); }
  const cap = (y, ny, r, top) => {
    const base = v.length / 6;
    v.push(0, y, 0, 0, ny, 0);
    for (let j = 0; j <= seg; j++) { const a = j / seg * Math.PI * 2; v.push(Math.cos(a) * r, y, Math.sin(a) * r, 0, ny, 0); }
    for (let j = 0; j < seg; j++) top ? ix.push(base, base + j + 2, base + j + 1) : ix.push(base, base + j + 1, base + j + 2);
  };
  if (capTop && rTop > 0) cap(0.5, 1, rTop, true);
  if (capBot && rBot > 0) cap(-0.5, -1, rBot, false);
  return mesh(new Float32Array(v), new Uint16Array(ix));
}
function buildSphere(rows, cols) {                            // radius 1
  const v = [], ix = [];
  for (let i = 0; i <= rows; i++) {
    const th = i / rows * Math.PI, st = Math.sin(th), ct = Math.cos(th);
    for (let j = 0; j <= cols; j++) {
      const ph = j / cols * Math.PI * 2, x = st * Math.cos(ph), z = st * Math.sin(ph);
      v.push(x, ct, z, x, ct, z);
    }
  }
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    const a = i * (cols + 1) + j, b = a + cols + 1;
    ix.push(a, a + 1, b, a + 1, b + 1, b);
  }
  return mesh(new Float32Array(v), new Uint16Array(ix));
}
function buildDisc(seg) {                                     // radius 1 at y = 0, faces up
  const v = [0, 0, 0, 0, 1, 0], ix = [];
  for (let j = 0; j <= seg; j++) { const a = j / seg * Math.PI * 2; v.push(Math.cos(a), 0, Math.sin(a), 0, 1, 0); }
  for (let j = 0; j < seg; j++) ix.push(0, j + 2, j + 1);
  return mesh(new Float32Array(v), new Uint16Array(ix));
}
const M = {
  cube: buildCube(),
  cyl: buildCyl(20, 1, 1, true, true),
  cone: buildCyl(16, 0, 1, false, true),
  pyr: buildCyl(4, 1, 0.22, false, true),
  sphere: buildSphere(12, 18),
  disc: buildDisc(24)
};

/* ---------------- state + drawing ---------------- */
const colorCache = new Map();
function rgb(hex, k) {
  const m = k || 1, key = hex + '|' + m;
  let c = colorCache.get(key);
  if (!c) {
    const n = parseInt(hex.slice(1), 16);
    c = [((n >> 16) & 255) / 255 * m, ((n >> 8) & 255) / 255 * m, (n & 255) / 255 * m];
    colorCache.set(key, c);
  }
  return c;
}

let W = 1, H = 1, fovY = 1, boundMesh = null;
const P = mat(), V = mat(), VPm = mat(), Nm = new Float32Array(9);
gl.enableVertexAttribArray(0); gl.enableVertexAttribArray(1);
const pbuf = gl.createBuffer();

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(2, Math.floor(canvas.clientWidth * dpr)), h = Math.max(2, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  W = w; H = h;
  return w / h;
}

function beginFrame(ex, ey, ez, tx, ty, tz, fovDeg) {
  const aspect = resize();
  fovY = fovDeg * Math.PI / 180;
  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE); gl.frontFace(gl.CW);   // CW because the projection mirrors X
  gl.disable(gl.BLEND); gl.depthMask(true);
  perspective(P, fovY, aspect, 0.2, 700);
  lookAt(V, ex, ey, ez, tx, ty, tz);
  mul(VPm, P, V);
  VPm[0] = -VPm[0]; VPm[4] = -VPm[4]; VPm[8] = -VPm[8]; VPm[12] = -VPm[12];
  gl.useProgram(PL);
  gl.uniformMatrix4fv(U.uVP, false, VPm);
  gl.uniform3f(U.uEye, ex, ey, ez);
  gl.uniform3f(U.uSky, 0.64, 0.66, 0.74);
  gl.uniform3f(U.uGround, 0.50, 0.45, 0.62);
  gl.uniform3f(U.uSunCol, 0.40, 0.38, 0.34);
  gl.uniform3f(U.uSun, 0.4, 0.8, -0.45);
  gl.uniform3f(U.uFogCol, SKY[0], SKY[1], SKY[2]);
  gl.uniform2f(U.uFog, 90, 340);
  gl.uniform1f(U.uAlpha, 1);
  boundMesh = null; sp = 0; ident(stack[0]);
}

function bind(m) {
  if (m === boundMesh) return;
  boundMesh = m;
  gl.bindBuffer(gl.ARRAY_BUFFER, m.vb);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ib);
}

/* draw a mesh with the current matrix. col: [r,g,b]; pat: 0 none, 1 top checker,
   2 fine checker, 3 hazard stripes (needs sx,sy,sz = box size); em: [r,g,b] glow or null */
function draw(m, col, pat, em, sx, sy, sz) {
  const t = stack[sp];
  const ax = t[0], ay = t[1], az = t[2], bx = t[4], by = t[5], bz = t[6], cx = t[8], cy = t[9], cz = t[10];
  Nm[0] = by * cz - bz * cy; Nm[1] = bz * cx - bx * cz; Nm[2] = bx * cy - by * cx;
  Nm[3] = cy * az - cz * ay; Nm[4] = cz * ax - cx * az; Nm[5] = cx * ay - cy * ax;
  Nm[6] = ay * bz - az * by; Nm[7] = az * bx - ax * bz; Nm[8] = ax * by - ay * bx;
  gl.uniformMatrix4fv(U.uM, false, t);
  gl.uniformMatrix3fv(U.uN, false, Nm);
  gl.uniform3f(U.uColor, col[0], col[1], col[2]);
  if (em) gl.uniform3f(U.uEmis, em[0], em[1], em[2]); else gl.uniform3f(U.uEmis, 0, 0, 0);
  gl.uniform1f(U.uPat, pat || 0);
  if (pat) gl.uniform3f(U.uSize, sx, sy, sz);
  bind(m);
  gl.drawElements(gl.TRIANGLES, m.n, gl.UNSIGNED_SHORT, 0);
}

function blendOn() { gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
function beginTransparent() { blendOn(); gl.depthMask(false); gl.disable(gl.CULL_FACE); }
function outlineBegin() { gl.cullFace(gl.FRONT); }
function outlineEnd() { gl.cullFace(gl.BACK); }
function endTransparent() { gl.disable(gl.BLEND); gl.depthMask(true); gl.enable(gl.CULL_FACE); gl.uniform1f(U.uAlpha, 1); }
function setAlpha(a) { gl.uniform1f(U.uAlpha, a); }

/* data: Float32Array, 8 floats per particle: x y z r g b a size(world units) */
function drawParticles(data, count) {
  if (count <= 0) return;
  gl.useProgram(PP);
  gl.uniformMatrix4fv(UP.uVP, false, VPm);
  gl.uniform1f(UP.uScale, H / (2 * Math.tan(fovY / 2)));
  gl.bindBuffer(gl.ARRAY_BUFFER, pbuf);
  gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, count * 8), gl.DYNAMIC_DRAW);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 12);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 32, 28);
  gl.enableVertexAttribArray(2);
  blendOn(); gl.depthMask(false);
  gl.drawArrays(gl.POINTS, 0, count);
  gl.depthMask(true); gl.disable(gl.BLEND);
  gl.disableVertexAttribArray(2);
  gl.useProgram(PL);
  boundMesh = null;
}

return { gl, mesh: M, rgb, resize, beginFrame, push, pop, translate, scale, rotX, rotY, rotZ, draw,
         beginTransparent, endTransparent, outlineBegin, outlineEnd, setAlpha, drawParticles, SKY };
})();
