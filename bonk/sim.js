/* =====================================================================
   SIM  -  pure JavaScript, no Babylon. Rendering only reads this state.
   The same file can later run unchanged inside a Colyseus room.
   Axes: +Z is forward along the course, +Y up. yaw 0 faces +Z.
   ===================================================================== */
const Sim = (() => {
'use strict';

const PR = 0.42, PH = 1.5, STEP = 0.42, KILL_Y = -9;
const RUN = 7.4, ACC_G = 55, DEC_G = 65, ACC_A = 15, SLIDE = 7;
const GRAV = 27, JUMP_V = 9.8, MAX_FALL = 32, COYOTE = 0.12, JBUF = 0.14;
const DIVE_T = 0.5, DIVE_V = 11.5, DIVE_CD = 1.4;
const BULLET_V = 26, BULLET_LIFE = 0.9, FIRE_CD = 0.3, MAX_AMMO = 5;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const hyp = Math.hypot;

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------------------
   Course. Every solid is an oriented box (centre, half sizes, yaw).
   kinds: static | slide | spin | piston | crumble
   --------------------------------------------------------------------- */
function buildCourse() {
  const solids = [], deco = [], pickups = [], route = [];
  let uid = 0;
  const add = o => {
    const s = Object.assign({
      id: uid++, kind: 'static', shape: 'slab', color: '#ffd23f', yaw: 0,
      vx: 0, vy: 0, vz: 0, om: 0, dyaw: 0, active: true, hazard: false, e: 0,
      bounce: 0, cp: -1, state: 'idle', timer: 0, fvy: 0
    }, o);
    s.rad = s.round ? s.hx : hyp(s.hx, s.hz);
    s.b = { cx: s.cx, cy: s.cy, cz: s.cz, yaw: s.yaw };
    solids.push(s);
    return s;
  };
  const slab = (x, top, z, w, d, o) =>
    add(Object.assign({ cx: x, cy: top - 0.5, cz: z, hx: w / 2, hy: 0.5, hz: d / 2 }, o));
  const bar = (x, bottom, z, len, h, om, yaw) =>
    add({ cx: x, cy: bottom + h / 2, cz: z, hx: len / 2, hy: h / 2, hz: 0.3, yaw, kind: 'spin',
          om, hazard: true, e: 0.3, shape: 'bar', color: '#ff3d6e' });

  const cps = [
    { x: 0, y: 0, z: 0.5 }, { x: 0, y: 0, z: 12 }, { x: 0, y: 0, z: 51 },
    { x: 0, y: 1.5, z: 87 }, { x: 0, y: 1.5, z: 123 }, { x: 0, y: 3, z: 140 }, { x: 0, y: 3, z: 166.5 }
  ];

  // start + spinner alley
  slab(0, 0, 2, 16, 14, { color: '#ff8fb8', cp: 0, name: 'start' });
  slab(0, 0, 27, 14, 36, { color: '#b79cff', cp: 1, name: 'alley' });
  bar(0, 0, 20, 13.8, 1.1, 1.15, 0.3);
  bar(0, 0, 34, 13.8, 1.1, -0.85, 0);
  bar(0, 0, 34, 13.8, 1.1, -0.85, Math.PI / 2);
  deco.push({ shape: 'hub', x: 0, y: 0, z: 20 }, { shape: 'hub', x: 0, y: 0, z: 34 });

  // slime hops: rest, two sliders, three crumbling tiles
  slab(0, 0, 51, 6, 5, { color: '#ffd23f', cp: 2, name: 'rest' });
  const m1 = slab(0, 0, 58.5, 6, 4, { kind: 'slide', ax: 3.2, w: 0.8, ph: 0, color: '#ff7a59', shape: 'mover' });
  const m2 = slab(0, 0, 65, 6, 4, { kind: 'slide', ax: 3.2, w: 0.8, ph: Math.PI, color: '#ff7a59', shape: 'mover' });
  const t1 = slab(-3, 0.4, 72, 3.6, 3.6, { kind: 'crumble', color: '#ffb86b', shape: 'tile' });
  const t2 = slab(0, 0.8, 76, 3.6, 3.6, { kind: 'crumble', color: '#ffb86b', shape: 'tile' });
  const t3 = slab(3, 1.2, 80, 3.6, 3.6, { kind: 'crumble', color: '#ffb86b', shape: 'tile' });
  slab(0, 1.5, 87, 8, 6, { color: '#ff8fb8', cp: 3, name: 'rest2' });

  // pusher bridge
  slab(0, 1.5, 105, 4, 30, { color: '#8bd3ff', name: 'bridge' });
  [95, 101, 107, 113].forEach((z, i) => {
    const left = i % 2 === 0;
    add({ cx: left ? -3.4 : 3.4, cy: 2.2, cz: z, hx: 0.5, hy: 0.7, hz: 1.1, kind: 'piston',
          dir: left ? 1 : -1, amp: 4.3, w: 2.1, ph: i * 1.4, hazard: true, e: 0.2,
          shape: 'piston', color: '#ff4f6d' });
    deco.push({ shape: 'rail', x: left ? -4.6 : 4.6, y: 1.5, z });
  });

  // bounce pad gap
  slab(0, 1.5, 124, 8, 8, { color: '#b79cff', cp: 4, name: 'launch' });
  add({ cx: 0, cy: 1.625, cz: 125.2, hx: 1.6, hy: 0.125, hz: 1.6, bounce: 17.5, shape: 'pad', color: '#5ef2a5' });
  slab(0, 3, 139.75, 10, 16.5, { color: '#ffd23f', cp: 5, name: 'landing' });

  // spin cycle, final cross spinner, finish
  add({ cx: 0, cy: 2.5, cz: 157, hx: 5, hy: 0.5, hz: 5, round: true, kind: 'spin', om: 0.5, shape: 'disc', color: '#ff8fb8' });
  slab(0, 3, 171, 10, 12, { color: '#6fe3b8', cp: 6, name: 'final' });
  bar(0, 3, 171, 9.8, 1.1, -1.0, 0.5);
  bar(0, 3, 171, 9.8, 1.1, -1.0, 0.5 + Math.PI / 2);
  deco.push({ shape: 'hub', x: 0, y: 3, z: 171 });
  slab(0, 3, 185, 14, 16, { color: '#ffd23f', name: 'finish' });

  [[0, 1.1, 27], [0, 1.1, 51], [0, 2.6, 87], [-2.4, 2.6, 123], [0, 4.1, 141], [0, 4.1, 166]]
    .forEach(([x, y, z]) => pickups.push({ x, y, z, on: true, t: 0 }));

  // bot racing line
  const R = (x, z, o) => route.push(Object.assign({ x, z }, o));
  R(0, 5); R(0, 14); R(0, 27); R(0, 41); R(0, 51);
  R(0, 58.5, { s: m1, narrow: true }); R(0, 65, { s: m2, narrow: true });
  R(-3, 72, { narrow: true, tile: t1 }); R(0, 76, { narrow: true, tile: t2 }); R(3, 80, { narrow: true, tile: t3 });
  R(0, 87, { narrow: true });
  R(0, 96, { narrow: true }); R(0, 118, { narrow: true });
  R(0, 124.6, { narrow: true }); R(0, 140);
  R(0, 157, { narrow: true }); R(0, 171); R(0, 184); R(0, 190);

  return { solids, deco, pickups, cps, route, finishZ: 183, length: 193 };
}

/* ------------------------------ helpers ------------------------------ */
const toLocal = (s, x, z) => {
  const dx = x - s.cx, dz = z - s.cz, c = Math.cos(s.yaw), n = Math.sin(s.yaw);
  return [dx * c - dz * n, dx * n + dz * c];
};
const toWorld = (s, lx, lz) => {
  const c = Math.cos(s.yaw), n = Math.sin(s.yaw);
  return [s.cx + lx * c + lz * n, s.cz - lx * n + lz * c];
};
const pointVel = (s, x, z) => [s.vx + s.om * (z - s.cz), s.vz - s.om * (x - s.cx)];

/* footprint test shared by player collision, bullets and bot sensing.
   Result is written into _q (no allocation): local coords, outside distance d,
   outward local normal (nx,nz), and depth when the point is inside the shape. */
const _q = { lx: 0, lz: 0, d: 0, nx: 0, nz: 0, inside: false, depth: 0 };
function footprint(s, x, z) {
  const dx = x - s.cx, dz = z - s.cz, c = Math.cos(s.yaw), n = Math.sin(s.yaw);
  const lx = dx * c - dz * n, lz = dx * n + dz * c;
  _q.lx = lx; _q.lz = lz;
  if (s.round) {
    const r = hyp(lx, lz);
    _q.d = r > s.hx ? r - s.hx : 0;
    _q.inside = r <= s.hx; _q.depth = s.hx - r;
    if (r > 1e-5) { _q.nx = lx / r; _q.nz = lz / r; } else { _q.nx = 1; _q.nz = 0; }
    return _q;
  }
  const ex = Math.abs(lx) - s.hx, ez = Math.abs(lz) - s.hz;
  const qx = ex > 0 ? ex : 0, qz = ez > 0 ? ez : 0, d = hyp(qx, qz);
  _q.d = d;
  if (d > 1e-5) { _q.inside = false; _q.depth = 0; _q.nx = (lx < 0 ? -qx : qx) / d; _q.nz = (lz < 0 ? -qz : qz) / d; }
  else {
    _q.inside = true;
    if (-ex < -ez) { _q.nx = lx < 0 ? -1 : 1; _q.nz = 0; _q.depth = -ex; }
    else { _q.nx = 0; _q.nz = lz < 0 ? -1 : 1; _q.depth = -ez; }
  }
  return _q;
}
/* where a moving solid will be at absolute sim time t (used by bots to lead their jumps) */
function solidAt(s, t, out) {
  out.cx = s.cx; out.cz = s.cz; out.yaw = s.yaw;
  if (s.kind === 'spin') out.yaw = s.b.yaw + s.om * t;
  else if (s.kind === 'slide') out.cx = s.b.cx + s.ax * Math.sin(t * s.w + s.ph);
  else if (s.kind === 'piston') { const u = clamp(0.5 + 0.9 * Math.sin(t * s.w + s.ph), 0, 1); out.cx = s.b.cx + s.dir * s.amp * (u * u * (3 - 2 * u)); }
  return out;
}


/* ------------------------------ the sim ------------------------------ */
function create(seed) {
  const R = mulberry(seed || 7);
  const C = buildCourse();
  const S = {
    t: 0, raceT: 0, phase: 'menu', cd: 0, finishCount: 0, humanId: 0, bid: 1,
    players: [], bullets: [], ev: [],
    solids: C.solids, deco: C.deco, pickups: C.pickups, cps: C.cps, route: C.route,
    finishZ: C.finishZ, length: C.length
  };
  const EMPTY = { mx: 0, mz: 0, jump: false, dive: false, fire: false };
  const SLOTS = [-4.75, -2.85, -0.95, 0.95, 2.85, 4.75];
  const emit = (t, p, extra) => S.ev.push(Object.assign({ t, id: p ? p.id : -1, x: p ? p.x : 0, y: p ? p.y : 0, z: p ? p.z : 0 }, extra));

  function resetPlayer(p, slot) {
    Object.assign(p, {
      x: SLOTS[slot % 6], y: 0.02, z: 0.5, vx: 0, vy: 0, vz: 0, yaw: 0, ground: null, coyote: 0, jbuf: 0,
      stun: 0, stunMax: 0, getup: 0, flop: 1, diveT: 0, diveCd: 0, fireCd: 0, hitCd: 0, protect: 0,
      dead: 0, ammo: 0, cp: 0, finished: false, finishT: 0, place: 0, blocked: false, gvx: 0, gvz: 0,
      falls: 0, bonks: 0
    });
    p.ai.react = 0.15 + R() * 0.3; p.ai.jcd = p.ai.dcd = p.ai.fcd = 0;
  }
  function resetWorld() {
    for (const s of S.solids) {
      s.cx = s.b.cx; s.cy = s.b.cy; s.cz = s.b.cz; s.yaw = s.b.yaw;
      s.vx = s.vy = s.vz = 0; s.dyaw = 0; s.active = true; s.state = 'idle'; s.timer = 0;
    }
    for (const k of S.pickups) { k.on = true; k.t = 0; }
    S.bullets.length = 0;
  }

  S.addPlayer = def => {
    const p = Object.assign({ id: S.players.length, name: 'Racer', bot: true, kind: 'zombie', skill: 0.8 }, def);
    p.ai = { skill: p.skill, lane: (R() - 0.5) * 6, ph: R() * 6.28, look: 2.2 + R() * 1.2, react: 0, jcd: 0, dcd: 0, fcd: 0 };
    S.players.push(p);
    resetPlayer(p, p.id);
    return p;
  };
  S.reset = phase => {
    S.t = 0; S.raceT = 0; S.finishCount = 0; S.ev.length = 0;
    resetWorld();
    S.players.forEach((p, i) => resetPlayer(p, i));
    S.phase = phase || 'menu';
    S.cd = 3;
  };
  S.begin = () => S.reset('countdown');
  S.ranking = () => S.players.slice().sort((a, b) =>
    (b.finished - a.finished) || (a.finished && b.finished ? a.finishT - b.finishT : b.z - a.z));

  /* ---------------- solids ---------------- */
  function updateSolid(s, dt) {
    const ox = s.cx, oy = s.cy, oz = s.cz, oyaw = s.yaw;
    switch (s.kind) {
      case 'spin': s.yaw = s.b.yaw + s.om * S.t; break;
      case 'slide': s.cx = s.b.cx + s.ax * Math.sin(S.t * s.w + s.ph); break;
      case 'piston': {
        const u = clamp(0.5 + 0.9 * Math.sin(S.t * s.w + s.ph), 0, 1);
        s.cx = s.b.cx + s.dir * s.amp * (u * u * (3 - 2 * u));
        break;
      }
      case 'crumble':
        if (s.state === 'shake') {
          s.timer -= dt;
          if (s.timer <= 0) { s.state = 'fall'; s.active = false; s.fvy = 0; s.timer = 1.0; emit('crumble', null, { x: s.cx, y: s.cy, z: s.cz }); }
        } else if (s.state === 'fall') {
          s.fvy -= GRAV * 0.8 * dt; s.cy += s.fvy * dt; s.timer -= dt;
          if (s.timer <= 0) { s.state = 'gone'; s.timer = 0.8; }
        } else if (s.state === 'gone') {
          s.timer -= dt;
          if (s.timer <= 0) { s.state = 'idle'; s.cy = s.b.cy; s.active = true; }
        }
        break;
    }
    s.vx = (s.cx - ox) / dt; s.vy = (s.cy - oy) / dt; s.vz = (s.cz - oz) / dt;
    s.dyaw = wrap(s.yaw - oyaw);
  }

  /* ---------------- knock / hurt ---------------- */
  function leaveGround(p) {
    if (p.ground) { p.vx += p.gvx; p.vz += p.gvz; p.ground = null; }
  }
  function stunFor(p, t, vx, vz) {
    p.stun = Math.max(p.stun, t); p.stunMax = p.stun; p.diveT = 0;
    p.flop = (Math.sin(p.yaw) * vx + Math.cos(p.yaw) * vz) < 0 ? -1 : 1;
  }
  function knock(q, vx, vz, vy, stunT) {
    leaveGround(q);
    q.vx += vx; q.vz += vz; q.vy = Math.max(q.vy, vy);
    stunFor(q, stunT, vx, vz);
  }

  /* ---------------- collision ---------------- */
  function collide(p, prevY) {
    const was = p.ground;
    let ground = null, gtop = -1e9, hurt = null;
    const impact = -p.vy;
    p.blocked = false;
    for (const s of S.solids) {
      if (!s.active) continue;
      const dx = p.x - s.cx, dz = p.z - s.cz, rr = s.rad + PR + 0.05;
      if (dx * dx + dz * dz > rr * rr) continue;
      const top = s.cy + s.hy, bot = s.cy - s.hy;
      const q = footprint(s, p.x, p.z), d = q.d;

      if (p.vy <= 0.01 && d < PR * 0.8 && p.y <= top + 0.03 && prevY >= top - STEP) {
        if (top > gtop) { gtop = top; ground = s; }
        continue;
      }
      if (d < PR && p.y < top - STEP && p.y + PH > bot) {
        const nx = q.nx, nz = q.nz, pen = q.inside ? q.depth + PR : PR - d;
        const c = Math.cos(s.yaw), n = Math.sin(s.yaw);
        const wx = nx * c + nz * n, wz = -nx * n + nz * c;
        p.x += wx * pen; p.z += wz * pen;
        const sv = pointVel(s, p.x, p.z);
        const gx = was ? p.gvx : 0, gz = was ? p.gvz : 0;
        const rvn = (p.vx + gx - sv[0]) * wx + (p.vz + gz - sv[1]) * wz;
        if (rvn < 0) { const k = -(1 + s.e) * rvn; p.vx += wx * k; p.vz += wz * k; }
        p.blocked = true;
        if (s.hazard && p.hitCd <= 0 && p.protect <= 0 && rvn < -2) hurt = { wx, wz };
      }
    }

    if (ground && ground.bounce > 0) {
      p.vy = ground.bounce; p.y = gtop + 0.01; ground = null;
      emit('bounce', p);
    }
    if (ground) {
      const gv = pointVel(ground, p.x, p.z);
      if (was && was !== ground) { p.vx += p.gvx; p.vz += p.gvz; }
      if (ground !== was) {
        p.vx -= gv[0]; p.vz -= gv[1];
        if (impact > 6) emit('land', p, { power: impact });
      }
      p.gvx = gv[0]; p.gvz = gv[1];
      p.ground = ground; p.y = gtop; if (p.vy < 0) p.vy = 0;
      if (ground.kind === 'crumble' && ground.state === 'idle') { ground.state = 'shake'; ground.timer = 1.2; emit('shake', null, { x: ground.cx, y: ground.cy, z: ground.cz }); }
      if (ground.cp > p.cp) { p.cp = ground.cp; emit('cp', p, { cp: p.cp }); }
    } else if (was) { p.vx += p.gvx; p.vz += p.gvz; p.ground = null; }

    if (hurt) {
      leaveGround(p);
      p.vy = Math.max(p.vy, 5.5);
      p.hitCd = 0.4;
      stunFor(p, 0.8, hurt.wx, hurt.wz);
      emit('hit', p);
    }
  }

  /* ---------------- bot brain ---------------- */
  function groundAt(x, z, maxY) {
    let best = -Infinity;
    for (const s of S.solids) {
      if (!s.active) continue;
      const top = s.cy + s.hy;
      if (top > maxY || top <= best) continue;
      const dx = x - s.cx, dz = z - s.cz;
      if (dx * dx + dz * dz > s.rad * s.rad) continue;
      if (footprint(s, x, z).d <= 0) best = top;
    }
    return best;
  }
  const _sa = { cx: 0, cz: 0, yaw: 0 }, _sv = { cx: 0, cz: 0, yaw: 0, hx: 0, hz: 0, round: false };
  /* will a hazard overlap the player's path `ahead` seconds from now? */
  function hazardSoon(p, ahead) {
    const px = p.x + p.vx * ahead, pz = p.z + p.vz * ahead, T = S.t + ahead;
    for (const s of S.solids) {
      if (!s.hazard || !s.active || Math.abs(s.cy - p.y) > 2.2) continue;
      const m = solidAt(s, T, _sa);
      _sv.cx = m.cx; _sv.cz = m.cz; _sv.yaw = m.yaw; _sv.hx = s.hx; _sv.hz = s.hz; _sv.round = s.round;
      if (footprint(_sv, px, pz).d < PR + 0.55) return true;
    }
    return false;
  }
  function think(p, dt) {
    const inp = { mx: 0, mz: 0, jump: false, dive: false, fire: false };
    const A = p.ai;
    if (S.phase !== 'race' || p.finished || p.dead > 0) return inp;
    A.react -= dt; A.jcd -= dt; A.dcd -= dt; A.fcd -= dt;
    if (A.react > 0) return inp;

    const rt = S.route;
    let e = rt[rt.length - 1];
    for (let i = 0; i < rt.length; i++) if (rt[i].z > p.z + A.look) { e = rt[i]; break; }
    if (p.ground && e.tile && (e.tile.state === 'fall' || e.tile.state === 'gone' || (e.tile.state === 'shake' && e.tile.timer < 0.55)) && hyp(e.tile.cx - p.x, e.tile.cz - p.z) < 7) {
      // face the tile but hold position until it is back
      p.yaw += clamp(wrap(Math.atan2(e.tile.cx - p.x, e.tile.cz - p.z) - p.yaw), -6 * dt, 6 * dt);
      return inp;
    }
    let tx = (e.s ? e.s.cx : e.x) + (e.narrow ? 0 : A.lane), tz = e.s ? e.s.cz : e.z;
    if (e.s) { const m = solidAt(e.s, S.t + clamp((tz - p.z) / RUN, 0.15, 0.9) * (0.5 + 0.5 * A.skill), _sa); tx = m.cx; }
    const ang = Math.atan2(tx - p.x, tz - p.z) + Math.sin(S.t * 1.7 + A.ph) * (1 - A.skill) * 0.6;
    inp.mx = Math.sin(ang); inp.mz = Math.cos(ang);

    if (p.ground && A.jcd <= 0) {
      const gh = groundAt(p.x + inp.mx * 1.15, p.z + inp.mz * 1.15, p.y + STEP + 0.01);
      if (gh < p.y - 1.0 || p.blocked) { inp.jump = true; A.jcd = 0.45; }
      else if (hazardSoon(p, 0.34) && R() < 0.35 + 0.6 * A.skill) { inp.jump = true; A.jcd = 0.6; }
    }
    if (p.ground && A.dcd <= 0) {
      for (const q of S.players) {
        if (q === p || q.dead > 0) continue;
        const dx = q.x - p.x, dz = q.z - p.z, d = hyp(dx, dz);
        if (d < 1.9 && Math.abs(wrap(Math.atan2(dx, dz) - p.yaw)) < 0.5 && R() < 0.25 * A.skill) { inp.dive = true; A.dcd = 3.5; break; }
      }
    }
    if (p.ammo > 0 && p.fireCd <= 0 && A.fcd <= 0) {
      for (const q of S.players) {
        if (q === p || q.dead > 0 || q.finished) continue;
        const dx = q.x - p.x, dz = q.z - p.z, d = hyp(dx, dz);
        if (d > 2 && d < 15 && Math.abs(q.y - p.y) < 1.6 && Math.abs(wrap(Math.atan2(dx, dz) - p.yaw)) < 0.16) { inp.fire = true; A.fcd = 1.3 + R(); break; }
      }
    }
    return inp;
  }

  /* ---------------- one player ---------------- */
  function respawn(p) {
    const c = S.cps[p.cp];
    p.x = c.x + (R() - 0.5) * 3; p.z = c.z + (R() - 0.5) * 1.5; p.y = c.y + 0.6;
    p.vx = p.vy = p.vz = 0; p.yaw = 0; p.ground = null; p.protect = 1.5; p.hitCd = 0;
    p.stun = 0; p.getup = 0; p.diveT = 0;
    emit('respawn', p);
  }
  function stepPlayer(p, inp, dt) {
    if (p.dead > 0) { p.dead -= dt; if (p.dead <= 0) respawn(p); return; }
    p.coyote -= dt; p.jbuf -= dt; p.diveCd -= dt; p.fireCd -= dt; p.hitCd -= dt; p.protect -= dt;
    if (p.stun > 0) { p.stun -= dt; if (p.stun <= 0) { p.stun = 0; p.getup = 0.35; } }
    if (p.getup > 0) p.getup -= dt;
    if (p.diveT > 0) { p.diveT -= dt; if (p.diveT <= 0) { p.diveT = 0; p.stun = 0.5; p.stunMax = 0.5; p.flop = 1; } }

    const racing = S.phase === 'race';
    const stunned = p.stun > 0, diving = p.diveT > 0;
    const canAct = racing && !stunned && !diving && !p.finished;
    let mx = inp.mx, mz = inp.mz, mag = hyp(mx, mz);
    if (mag > 1) { mx /= mag; mz /= mag; mag = 1; }
    const moving = canAct && mag > 0.05, grounded = !!p.ground;

    const tvx = moving ? mx * RUN : 0, tvz = moving ? mz * RUN : 0;
    let acc;
    if (stunned || diving) acc = grounded ? (diving ? 4 : SLIDE) : 0.5;
    else if (moving) acc = grounded ? ACC_G : ACC_A;
    else acc = grounded ? DEC_G : 1.5;
    let dvx = tvx - p.vx, dvz = tvz - p.vz;
    const dl = hyp(dvx, dvz), md = acc * dt;
    if (dl > md) { dvx *= md / dl; dvz *= md / dl; }
    p.vx += dvx; p.vz += dvz;
    if (moving) p.yaw += clamp(wrap(Math.atan2(mx, mz) - p.yaw), -18 * dt, 18 * dt);

    // jump with coyote time + input buffer
    if (inp.jump && canAct) p.jbuf = JBUF;
    if (grounded) p.coyote = COYOTE;
    if (canAct && p.jbuf > 0 && p.coyote > 0) {
      p.vy = JUMP_V; p.jbuf = 0; p.coyote = 0; leaveGround(p); emit('jump', p);
    }
    // dive
    if (inp.dive && canAct && p.diveCd <= 0) {
      const a = moving ? Math.atan2(mx, mz) : p.yaw;
      p.yaw = a; p.vx = Math.sin(a) * DIVE_V; p.vz = Math.cos(a) * DIVE_V;
      p.vy = grounded ? 4.6 : Math.max(p.vy, 2);
      leaveGround(p); p.diveT = DIVE_T; p.diveCd = DIVE_CD; emit('dive', p);
    }
    // blaster
    if (inp.fire && canAct && p.ammo > 0 && p.fireCd <= 0) {
      p.ammo--; p.fireCd = FIRE_CD;
      const sx = Math.sin(p.yaw), cz = Math.cos(p.yaw);
      S.bullets.push({ id: S.bid++, x: p.x + sx * 0.7, y: p.y + 1.0, z: p.z + cz * 0.7, vx: sx * BULLET_V, vz: cz * BULLET_V, life: BULLET_LIFE, owner: p.id });
      emit('fire', p);
    }
    // dive bonks whoever it hits
    if (p.diveT > 0) {
      for (const q of S.players) {
        if (q === p || q.dead > 0 || q.hitCd > 0 || q.protect > 0) continue;
        const dx = q.x - p.x, dz = q.z - p.z;
        if (Math.abs(q.y - p.y) < 1.0 && dx * dx + dz * dz < 1.56) {
          knock(q, Math.sin(p.yaw) * 9.5, Math.cos(p.yaw) * 9.5, 5.2, 1.0);
          q.hitCd = 0.5; p.bonks++; p.vx *= 0.4; p.vz *= 0.4;
          emit('bonk', q, { by: p.id, y: q.y + 1 });
        }
      }
    }

    if (!p.ground) p.vy = Math.max(p.vy - GRAV * dt, -MAX_FALL);
    const prevY = p.y;
    p.x += p.vx * dt; p.z += p.vz * dt; p.y += p.vy * dt;
    collide(p, prevY);

    if (p.y < KILL_Y) { p.dead = 1.1; p.ground = null; p.stun = 0; p.diveT = 0; p.falls++; emit('fall', p); return; }
    if (!p.finished && racing && p.ground && p.z >= S.finishZ) {
      p.finished = true; p.finishT = S.raceT; p.place = ++S.finishCount; emit('finish', p, { place: p.place });
    }
  }

  function separate() {
    const P = S.players;
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
      const a = P[i], b = P[j];
      if (a.dead > 0 || b.dead > 0 || Math.abs(a.y - b.y) > PH * 0.75) continue;
      let dx = a.x - b.x, dz = a.z - b.z;
      const d = hyp(dx, dz), md = PR * 2;
      if (d >= md) continue;
      if (d < 1e-4) { dx = 1; dz = 0; } else { dx /= d; dz /= d; }
      const pen = md - Math.max(d, 1e-4);
      a.x += dx * pen * 0.5; a.z += dz * pen * 0.5; b.x -= dx * pen * 0.5; b.z -= dz * pen * 0.5;
      const rv = (a.vx - b.vx) * dx + (a.vz - b.vz) * dz;
      if (rv < 0) { const k = -rv * 0.6; a.vx += dx * k; a.vz += dz * k; b.vx -= dx * k; b.vz -= dz * k; }
    }
  }

  function stepBullets(dt) {
    for (let i = S.bullets.length - 1; i >= 0; i--) {
      const b = S.bullets[i];
      b.life -= dt; b.x += b.vx * dt; b.z += b.vz * dt;
      let dead = b.life <= 0;
      if (!dead) for (const s of S.solids) {
        if (!s.active || b.y < s.cy - s.hy || b.y > s.cy + s.hy) continue;
        const dx = b.x - s.cx, dz = b.z - s.cz, rr = s.rad + 0.3;
        if (dx * dx + dz * dz > rr * rr) continue;
        if (footprint(s, b.x, b.z).d < 0.15) { dead = true; emit('spark', null, { x: b.x, y: b.y, z: b.z }); break; }
      }
      if (!dead) for (const q of S.players) {
        if (q.id === b.owner || q.dead > 0 || q.protect > 0) continue;
        const dx = q.x - b.x, dz = q.z - b.z;
        if (b.y > q.y && b.y < q.y + PH && dx * dx + dz * dz < (PR + 0.22) * (PR + 0.22)) {
          knock(q, b.vx * 0.3, b.vz * 0.3, 5.5, 0.9);
          q.hitCd = 0.3; dead = true;
          const o = S.players[b.owner]; if (o) o.bonks++;
          emit('bonk', q, { by: b.owner, y: q.y + 1 });
          break;
        }
      }
      if (dead) S.bullets.splice(i, 1);
    }
  }
  function stepPickups(dt) {
    for (const k of S.pickups) {
      if (!k.on) { k.t -= dt; if (k.t <= 0) k.on = true; continue; }
      for (const p of S.players) {
        if (p.dead > 0 || p.finished || p.ammo >= MAX_AMMO) continue;
        const dx = p.x - k.x, dz = p.z - k.z;
        if (dx * dx + dz * dz < 1.0 && p.y < k.y + 0.6 && p.y + PH > k.y - 0.6) {
          p.ammo = Math.min(MAX_AMMO, p.ammo + 3); k.on = false; k.t = 9; emit('pickup', p); break;
        }
      }
    }
  }

  /* ---------------- public step ---------------- */
  function sub(dt, humanInp) {
    S.t += dt;
    if (S.phase === 'countdown') { S.cd -= dt; if (S.cd <= 0) { S.phase = 'race'; S.raceT = 0; emit('go', null); } }
    else if (S.phase === 'race') S.raceT += dt;

    for (const p of S.players) {
      p._cs = null;
      if (p.ground && p.ground.active) { const l = toLocal(p.ground, p.x, p.z); p._cs = p.ground; p._lx = l[0]; p._lz = l[1]; }
    }
    for (const s of S.solids) updateSolid(s, dt);
    for (const p of S.players) {
      if (!p._cs) continue;
      const s = p._cs;
      if (s.active) { const w = toWorld(s, p._lx, p._lz); p.x = w[0]; p.z = w[1]; p.y = s.cy + s.hy; p.yaw += s.dyaw; }
      else p.ground = null;
    }
    for (const p of S.players) {
      const inp = p._mpInput || (p.id === S.humanId ? humanInp : (p.bot ? think(p, dt) : EMPTY));
      stepPlayer(p, inp || EMPTY, dt);
    }
    separate(); stepBullets(dt); stepPickups(dt);
  }
  S.step = (dt, humanInp) => {
    dt = Math.min(dt, 1 / 20);
    const n = Math.max(1, Math.ceil(dt / (1 / 60))), h = dt / n;
    for (let i = 0; i < n; i++) sub(h, i === 0 ? humanInp : { mx: humanInp ? humanInp.mx : 0, mz: humanInp ? humanInp.mz : 0 });
  };
  return S;
}

return { create, K: { PR, PH, RUN, KILL_Y, MAX_AMMO, GRAV, JUMP_V } };
})();
if (typeof module !== 'undefined') module.exports = Sim;
