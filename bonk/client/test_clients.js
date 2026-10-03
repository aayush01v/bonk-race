/* Browser tests for the two builds in dist/. Needs Node, Playwright and a Chromium.

     node test_clients.js              run everything below
     node test_clients.js webgl        WebGL build: menu, race, finish, results, second race
     node test_clients.js babylon      Babylon build against mock_babylon.js (a stand-in, NOT real Babylon)
     node test_clients.js blocked      Babylon build with the CDN unreachable: must show a clear message
     node test_clients.js babylon "?lowfx=1"      same, with URL flags (smoke only: SMOKE=1)

   Environment:  PLAYWRIGHT_PATH  folder of the playwright package if `require('playwright')` fails
                 CHROME_PATH      a Chromium/Chrome binary (default: Playwright's own)
                 SOFTWARE_GL=0    do not force SwiftShader software WebGL (default is to force it,
                                  so it also runs on machines without a GPU)
   Screenshots go to ./shots. The simulation runs slower than real time in software GL, so every wait is
   on simulation state, never on a fixed delay. */
const path = require('path'), fs = require('fs');
let pw; try { pw = require('playwright'); } catch (_) { pw = require(process.env.PLAYWRIGHT_PATH || '/usr/lib/node_modules/playwright'); }
const DIST = path.join(__dirname, 'dist'), SHOTS = path.join(__dirname, 'shots');
const MOCK = fs.readFileSync(path.join(__dirname, 'mock_babylon.js'), 'utf8');
fs.mkdirSync(SHOTS, { recursive: true });

let bad = 0;
const ok = (c, m) => { if (!c) bad++; console.log((c ? 'ok   ' : 'FAIL ') + m); };
const waitFor = async (p, fn, ms, label) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p.evaluate(fn)) return true; await p.waitForTimeout(150); } console.log('     (timeout waiting for ' + label + ')'); return false; };

async function open(file, query, opts) {
  const args = ['--no-sandbox'];
  if (process.env.SOFTWARE_GL !== '0') args.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist');
  const browser = await pw.chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true, args });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errs = [];
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) errs.push(m.type() + ': ' + m.text().slice(0, 240)); });
  page.on('pageerror', e => errs.push('PAGEERROR: ' + String(e.message).slice(0, 240)));
  if (opts && opts.route) await page.route(/babylon\.js(\?.*)?$/, opts.route);
  await page.goto('file://' + path.join(DIST, file) + (query || ''));
  return { browser, page, errs };
}
const teleportToFinish = () => { const r = window.__race, s = r.sim, h = s.players[r.me], f = s.solids.find(o => o.name === 'finish'); h.x = 0; h.z = 178; h.y = f.cy + f.hy + 0.1; h.vx = h.vy = h.vz = 0; h.ground = null; h.stun = 0; h.dead = 0; h.cp = 6; };

/* the flow both builds must pass */
async function playThrough(p, tag, smoke) {
  await p.waitForTimeout(800);
  await p.screenshot({ path: path.join(SHOTS, tag + '_1_menu.png') });
  await p.evaluate(() => window.__race.start());
  ok(await waitFor(p, () => window.__race.sim.phase === 'race', 90000, 'race phase'), 'countdown ends and the race starts');
  await p.keyboard.down('KeyW');
  ok(await waitFor(p, () => { const r = window.__race; return r.sim.players[r.me].z > 8; }, 90000, 'run forward'), 'holding W runs the human racer forward');
  await p.keyboard.press('Space'); await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(SHOTS, tag + '_2_race.png') });
  if (smoke) return;
  await p.evaluate(teleportToFinish);
  ok(await waitFor(p, () => { const r = window.__race; return r.sim.players[r.me].finished; }, 90000, 'finish'), 'human racer crosses the finish line');
  ok(await waitFor(p, () => !document.getElementById('results').classList.contains('hidden'), 90000, 'results'), 'results card appears');
  await p.waitForTimeout(500);
  const res = await p.evaluate(() => ({ head: document.getElementById('resHead').textContent, rows: document.querySelectorAll('#resList li').length }));
  ok(res.rows === 6, 'results list has six racers (' + res.head + ')');
  await p.screenshot({ path: path.join(SHOTS, tag + '_3_results.png') });
  await p.evaluate(() => window.__race.menu()); await p.waitForTimeout(300);
  await p.evaluate(() => window.__race.start());
  ok(await waitFor(p, () => window.__race.sim.phase === 'race', 90000, 'second race'), 'a second race starts after returning to the menu');
}

async function testWebgl() {
  console.log('--- WebGL build ---');
  const { browser, page, errs } = await open('sim-race-webgl.html');
  await playThrough(page, 'webgl', false);
  ok(errs.length === 0, 'no console errors or warnings' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await browser.close();
}

async function testBabylon(query) {
  const smoke = !!process.env.SMOKE;
  console.log('--- Babylon build against the stand-in ' + (query || '') + (smoke ? ' (smoke)' : '') + ' ---');
  const { browser, page: p, errs } = await open('sim-race-babylon.html', query, { route: r => r.fulfill({ status: 200, contentType: 'application/javascript', body: MOCK }) });
  await p.waitForTimeout(800);
  ok(await p.evaluate(() => typeof BJS !== 'undefined' && BJS.ok === true), 'renderer initialised (BJS.ok)');
  console.log('     effects that switched themselves off: ' + JSON.stringify(await p.evaluate(() => BJS.failed)));
  await playThrough(p, 'babylon', smoke);
  const s = await p.evaluate(() => {
    const r = window.__race, sim = r.sim, sc = window.__bjsMock.scene, me = sim.players[r.me], st = window.__bjsMock.stats;
    const root = sc._nodes.find(n => n.name === 'racer' + r.me), w = root.getWorldMatrix();
    return { dx: Math.hypot(me.x - w[12], me.y - w[13], me.z - w[14]),
      solids: sc.meshes.filter(m => /^(slab|mover|tile|bar|piston|disc|pad)\d+$/.test(m.name)).length, simSolids: sim.solids.length,
      pickups: sc.meshes.filter(m => m.name === 'pickup' && m.isEnabled()).length, simPickups: sim.pickups.filter(k => k.on).length,
      rigs: sc._nodes.filter(n => /^racer\d+$/.test(n.name)).length, renders: st.renders, warnings: st.warnings, meshes: sc.meshes.length, created: st.created };
  });
  ok(s.dx < 0.5, 'the human racer node follows the simulation (' + s.dx.toFixed(2) + ' units apart)');
  ok(s.solids === s.simSolids, 'one mesh per sim solid (' + s.solids + '/' + s.simSolids + ')');
  ok(s.pickups === s.simPickups, 'enabled pickup meshes match the sim (' + s.pickups + '/' + s.simPickups + ')');
  ok(s.rigs === 6, 'six racer rigs, none duplicated after restart (' + s.rigs + ')');
  ok(s.renders > 30, 'scene.render() ran every frame (' + s.renders + ')');
  ok(s.warnings.length === 0, 'geometry passes the stand-in\'s checks (lengths, indices, unit normals)');
  console.log('     meshes ' + s.meshes + ', created ' + JSON.stringify(s.created));
  ok(errs.length === 0, 'no console errors or warnings' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await browser.close();
}

async function testBlocked() {
  console.log('--- Babylon build with the CDN unreachable ---');
  const blocked = [];
  const { browser, page: p, errs } = await open('sim-race-babylon.html', '', { route: r => { blocked.push(r.request().url()); r.abort('failed'); } });
  await p.waitForTimeout(1200);
  const st = await p.evaluate(() => ({ shown: !document.getElementById('err').classList.contains('hidden'), msg: document.getElementById('errMsg').textContent }));
  ok(blocked.length === 2, 'primary and fallback CDN were both tried (' + blocked.length + ')');
  ok(st.shown && /Babylon/.test(st.msg), 'a clear message is shown instead of a blank page');
  ok(errs.filter(e => /PAGEERROR/.test(e)).length === 0, 'no uncaught errors');
  await p.screenshot({ path: path.join(SHOTS, 'blocked.png') });
  await browser.close();
}

(async () => {
  const [cmd, query] = [process.argv[2] || 'all', process.argv[3]];
  if (cmd === 'webgl' || cmd === 'all') await testWebgl();
  if (cmd === 'babylon' || cmd === 'all') await testBabylon(query);
  if (cmd === 'blocked' || cmd === 'all') await testBlocked();
  console.log(bad ? bad + ' FAILURE(S)' : 'ALL CHECKS PASSED');
  process.exitCode = bad ? 1 : 0;
})().catch(e => { console.error('TEST RUNNER FAILED:', e.message.split('\n').slice(0, 3).join(' / ')); process.exit(1); });
