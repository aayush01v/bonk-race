/* Node-only checks for sim.js (no browser needed).
   usage:  node tests.js                run invariants + bot statistics
           node tests.js invariants     physics / input / determinism checks
           node tests.js stats          6-bot packs x 12 seeds, plus solo runs
           node tests.js race [seed]    one verbose 6-bot race
           node tests.js falls          why do bots fall in the crumble-tile section?
           node tests.js trace [z0 z1]  frame-by-frame history of the first falls between z0..z1 */
const Sim = require('./sim.js');
const KINDS = ['zombie', 'student'];
const bucket = z => z < 45 ? 'alley(0-45)' : z < 56 ? 'rest(45-56)' : z < 70 ? 'sliders(56-70)' : z < 85 ? 'tiles(70-85)'
  : z < 120 ? 'bridge(85-120)' : z < 135 ? 'launch(120-135)' : z < 165 ? 'disc(135-165)' : 'final(165+)';
const fmt = (a, n = 1) => a.map(v => v.toFixed(n)).join(' / ');

function pack(seed, n) {
  const S = Sim.create(seed); S.humanId = -1;
  for (let i = 0; i < n; i++) S.addPlayer({ name: 'B' + i, bot: true, kind: KINDS[i % 2], skill: 0.55 + 0.4 * ((i * 37 % 10) / 10) });
  S.begin(); return S;
}

function race(seed, nBots, maxT, verbose) {
  const S = pack(seed, nBots), ev = {}, falls = [];
  let t = 0, nan = false;
  while (t < maxT) {
    S.step(1 / 60, null); t += 1 / 60;
    for (const e of S.ev) { ev[e.t] = (ev[e.t] || 0) + 1; if (e.t === 'fall') falls.push([+S.raceT.toFixed(1), e.id, +e.z.toFixed(1)]); }
    S.ev.length = 0;
    for (const p of S.players) if (![p.x, p.y, p.z, p.vx, p.vy, p.vz].every(Number.isFinite)) nan = true;
    if (S.phase === 'race' && S.players.every(p => p.finished)) break;
  }
  const fin = S.players.filter(p => p.finished).map(p => +p.finishT.toFixed(1)).sort((a, b) => a - b);
  if (verbose) {
    console.log('seed', seed, 'sim time', t.toFixed(1), 'finished', fin.length + '/' + nBots, 'times', fin.join(','));
    console.log(' events', JSON.stringify(ev));
    console.log(' falls (raceT,id,z):', JSON.stringify(falls.slice(0, 30)));
  }
  return { fin: fin.length, n: nBots, nan, falls, S };
}

function stats() {
  const tot = { fin: 0, n: 0, falls: 0, times: [] }, by = {};
  for (let seed = 1; seed <= 12; seed++) {
    const r = race(seed, 6, 200, false);
    tot.fin += r.fin; tot.n += r.n; tot.falls += r.falls.length;
    r.S.players.filter(p => p.finished).forEach(p => tot.times.push(p.finishT));
    r.falls.forEach(f => { const b = bucket(f[2]); by[b] = (by[b] || 0) + 1; });
    if (r.nan) console.log('NaN in seed', seed);
  }
  tot.times.sort((a, b) => a - b);
  console.log('PACKS (6 bots x 12 seeds): finished', tot.fin + '/' + tot.n, ' falls/bot', (tot.falls / tot.n).toFixed(2));
  console.log(' finish time p10/p50/p90:', fmt([0.1, 0.5, 0.9].map(q => tot.times[Math.floor(q * (tot.times.length - 1))])));
  console.log(' falls by section:', JSON.stringify(by));
  const solo = { fin: 0, n: 0, falls: 0 }, soloBy = {}, soloT = [];
  for (const skill of [0.55, 0.75, 0.95]) for (let seed = 1; seed <= 6; seed++) {
    const S = Sim.create(seed); S.humanId = -1; S.addPlayer({ bot: true, skill }); S.begin();
    let fl = 0;
    for (let t = 0; t < 200 * 60; t++) {
      S.step(1 / 60, null);
      for (const e of S.ev) if (e.t === 'fall') { fl++; const b = bucket(e.z); soloBy[b] = (soloBy[b] || 0) + 1; }
      S.ev.length = 0; if (S.players[0].finished) break;
    }
    const p = S.players[0]; solo.n++; solo.falls += fl; if (p.finished) { solo.fin++; soloT.push(p.finishT); }
  }
  console.log('SOLO (3 skills x 6 seeds): finished', solo.fin + '/' + solo.n, ' falls/run', (solo.falls / solo.n).toFixed(2),
    ' time min/max', fmt([Math.min(...soloT), Math.max(...soloT)]), ' falls by section:', JSON.stringify(soloBy));
}

function invariants() {
  let bad = 0; const ok = (c, m) => { if (!c) { bad++; console.log('FAIL', m); } };
  { // standing still on every static slab never falls through
    const S = Sim.create(3); S.humanId = 0;
    const h = S.addPlayer({ bot: false, kind: 'student' }); S.begin();
    for (let i = 0; i < 200; i++) S.step(1 / 60, { mx: 0, mz: 0 });
    ok(S.phase === 'race', 'race phase reached');
    for (const s of S.solids.filter(s => s.kind === 'static' && !s.bounce)) {
      h.x = s.cx + (s.name === 'launch' ? -3 : 0); h.z = s.cz; h.y = s.cy + s.hy + 0.5;
      h.vx = h.vy = h.vz = 0; h.ground = null; h.stun = 0; h.dead = 0; h.protect = 9;
      const top = s.cy + s.hy;
      for (let i = 0; i < 90; i++) S.step(1 / 60, { mx: 0, mz: 0 });
      ok(Math.abs(h.y - top) < 1e-6 && h.ground === s, `stand on ${s.name || s.shape} (y=${h.y.toFixed(2)} top=${top})`);
    }
  }
  { // human input: run, jump, dive, fire, fall, respawn
    const S = Sim.create(5); S.humanId = 0;
    const h = S.addPlayer({ bot: false, kind: 'zombie' }); S.begin();
    const seen = {};
    const run = (n, inp) => { for (let i = 0; i < n; i++) { S.step(1 / 60, inp); for (const e of S.ev) if (e.id === 0 || e.id === -1) seen[e.t] = (seen[e.t] || 0) + 1; S.ev.length = 0; } };
    run(190, { mx: 0, mz: 0 });
    const z0 = h.z; run(30, { mx: 0, mz: 1 }); ok(h.z - z0 > 3.0, 'runs forward (' + (h.z - z0).toFixed(1) + ')');
    run(1, { mx: 0, mz: 1, jump: true }); run(12, { mx: 0, mz: 1 }); ok(h.y > 0.5 && !h.ground, 'jump leaves ground y=' + h.y.toFixed(2));
    run(60, { mx: 0, mz: 0 }); ok(h.ground, 'lands again');
    run(1, { mx: 0, mz: 1, dive: true }); ok(h.diveT > 0, 'dive started'); run(60, { mx: 0, mz: 0 });
    h.ammo = 3; h.stun = 0; h.diveT = 0; h.getup = 0; run(1, { mx: 0, mz: 0, fire: true });
    ok(S.bullets.length >= 1 || seen.fire, 'fire spawns bullet'); ok(h.ammo === 2, 'ammo spent');
    h.x = 20; h.y = 0; h.ground = null; h.vy = 0; run(120, { mx: 0, mz: 0 }); ok(h.dead > 0 || h.y > -9, 'falls off the side');
    run(120, { mx: 0, mz: 0 }); ok(h.dead <= 0 && h.y > -1, 'respawned at checkpoint y=' + h.y.toFixed(2) + ' z=' + h.z.toFixed(1));
    console.log('human events seen:', JSON.stringify(seen));
  }
  { // crumble cycle returns to idle and is solid again
    const S = Sim.create(9); S.humanId = -1; S.addPlayer({ bot: true }); S.begin();
    const t = S.solids.find(s => s.kind === 'crumble');
    S.phase = 'race'; t.state = 'shake'; t.timer = 0.2;
    const seq = []; for (let i = 0; i < 60 * 8; i++) { S.step(1 / 60, null); if (seq[seq.length - 1] !== t.state) seq.push(t.state); }
    ok(seq.join('>') === 'shake>fall>gone>idle', 'crumble cycle ' + seq.join('>'));
    ok(t.active && Math.abs(t.cy - t.b.cy) < 1e-9, 'tile restored in place');
  }
  { // determinism: same seed -> same result
    const go = () => { const S = Sim.create(11); S.humanId = -1; for (let i = 0; i < 4; i++) S.addPlayer({ bot: true, skill: .7 }); S.begin();
      for (let i = 0; i < 60 * 30; i++) { S.step(1 / 60, null); S.ev.length = 0; } return S.players.map(p => p.x.toFixed(4) + ',' + p.z.toFixed(4)).join('|'); };
    ok(go() === go(), 'deterministic');
  }
  console.log(bad ? bad + ' FAILURES' : 'all invariants pass');
  if (bad) process.exitCode = 1;
}

function falls() { // classify falls inside the crumble-tile section (z 68..86)
  const causes = { stunned: 0, onTileGone: 0, missedJump: 0, other: 0 }; let n = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const S = pack(seed, 6), ls = S.players.map(() => -99), lg = S.players.map(() => null), lj = S.players.map(() => -99);
    for (let t = 0; t < 120 * 60; t++) {
      S.step(1 / 60, null);
      S.players.forEach((p, i) => { if (p.stun > 0) ls[i] = S.t; if (p.ground) lg[i] = p.ground; });
      for (const e of S.ev) {
        if (e.t === 'jump') lj[e.id] = S.t;
        if (e.t === 'fall' && e.z > 68 && e.z < 86) {
          n++; const i = e.id;
          if (S.t - ls[i] < 1.2) causes.stunned++;
          else if (lg[i] && lg[i].kind === 'crumble') causes.onTileGone++;
          else if (S.t - lj[i] < 1.2) causes.missedJump++;
          else causes.other++;
        }
      }
      S.ev.length = 0; if (S.players.every(p => p.finished)) break;
    }
  }
  console.log('tile-section falls (8 seeds x 6 bots):', n, JSON.stringify(causes));
}

function trace(z0 = 55, z1 = 90, maxShown = 4) {
  const S = pack(7, 6), hist = S.players.map(() => []); let shown = 0;
  for (let t = 0; t < 60 * 60 && shown < maxShown; t++) {
    S.step(1 / 60, null);
    S.players.forEach((p, i) => {
      hist[i].push({ T: +S.raceT.toFixed(2), x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), vx: +p.vx.toFixed(1), vz: +p.vz.toFixed(1),
        ground: p.ground ? (p.ground.name || p.ground.kind) : '-', stunned: p.stun > 0 });
      if (hist[i].length > 200) hist[i].shift();
    });
    for (const e of S.ev) if (e.t === 'fall' && e.z > z0 && e.z < z1 && shown < maxShown) {
      shown++; const h = hist[e.id];
      console.log('--- FALL id', e.id, 'raceT', S.raceT.toFixed(2), 'z', e.z.toFixed(1));
      for (let k = Math.max(0, h.length - 150); k < h.length; k += 10) console.log(JSON.stringify(h[k]));
    }
    S.ev.length = 0;
  }
}

if (require.main === module) {
  const cmd = process.argv[2] || 'all', a = process.argv.slice(3).map(Number);
  if (cmd === 'all') { invariants(); stats(); }
  else if (cmd === 'invariants') invariants();
  else if (cmd === 'stats') stats();
  else if (cmd === 'race') race(a[0] || 7, 6, 180, true);
  else if (cmd === 'falls') falls();
  else if (cmd === 'trace') trace(a[0], a[1]);
  else console.log('unknown command', cmd);
}
module.exports = { race, stats, invariants, falls, trace, pack };
