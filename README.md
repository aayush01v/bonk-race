# Bonk Race (working title): handoff README

A browser, low-poly, multiplayer game that mixes a **Stumble Guys-style obstacle race** with **Mini Militia-style combat** (a knockback blaster, no health bars). No download; friends join by link or room code.

There are now **two playable clients** built from one shared `game.js`: a **Babylon.js** build (new, section 8) and a hand-written **WebGL1** build (your reference game, rebuilt on the current `sim.js`). Both sit on `sim.js`, which holds all the game logic.

---

## 1. Status at a glance

| Part | State |
|---|---|
| Stack decision + roadmap | Done (sections 4, 5) |
| `sim.js` game simulation (course, movement, hazards, combat, bots) | **Done, tested in Node** |
| `tests.js` Node checks | Done, all pass |
| **Babylon.js client**, `client/dist/sim-race-babylon.html` | **Built. Tested only against my own stand-in for Babylon, never against the real library** (section 8) |
| **WebGL1 client**, `client/dist/sim-race-webgl.html` (your reference game on the current `sim.js`) | **Built and tested in headless Chromium** |
| Multiplayer (rooms, lobby, authoritative server) | **Done — `mp-server.js` + `lobby.html`, MP mode in the WebGL client** (section 10) |
| MP smoothness (latency / choppiness) | **Fixed and verified** — P0/P1/P2 landed and tested: `test_mp_client_sim.js` runs the shipped client netcode unmodified against a real 30 Hz server sim; `test_mp_e2e.js` drives the real server (section 10 is the record) |

Both clients share one `game.js` (input, HUD, audio, menu, results) taken unchanged from your reference project; only the renderer differs. **The honest gap: nobody has seen the Babylon build render with the real Babylon.js**, because my sandbox could not download it. Open it in a browser first (section 8).

---

## 2. Start the next session

Upload `README.md`, `sim.js`, and the `client/` folder (or just the bundle zip).

Paste something like:

> Continue the project described in README.md. Read it, run `node tests.js`, then in `client/` run `python3 build.py`. I opened client/dist/sim-race-babylon.html in my browser and this is what I saw: [describe it, or paste the on-screen error / browser console text; adding `?debug` to the URL shows a status badge]. Fix client/bjs.js, rebuild, run `node test_clients.js`, and tell me honestly what you could and could not verify.

Check the new session's environment first (`node --version`, is there a browser, is the network on). Last time: Node 22, Python 3.12, **no network**, but a headless Chromium was usable through Playwright (software WebGL), which is what `client/test_clients.js` drives.

Multiplayer smoothness is **done and tested** (section 10): `node test_mp_client_sim.js` runs the shipped client netcode against a real server sim, `node test_mp_e2e.js` drives the real server end-to-end; both are green. Add `?net=1` to the MP iframe URL for a live RTT / packet-arrival / snap / correction overlay.

---

## 3. Files

```
(repo root)
  README.md                 this file (current; bonk/README.md is the earlier handoff copy)
  mp-server.js              Node + ws multiplayer server (`npm start`): rooms, authoritative sim, state broadcast
  lobby.html                lobby UI + WS client; relays server state → game iframe, iframe input → server
  sim-race-webgl.html       WebGL client — solo, and MP iframe mode (?mp=1) driven by the lobby
  sim-race-babylon.html     Babylon client (solo only, no MP mode)
  index.html                solo game page
  test_mp_e2e.js            end-to-end MP test (real server + two WS clients: create/join/start/input/state, tick alignment, client agreement, payload size)
  test_mp_init.js           replays the client mp_init flow incl. bots
  test_mp_client_sim.js     runs the shipped client netcode (extracted verbatim from sim-race-webgl.html) against a real 30 Hz authoritative sim
  server.js, server.py      solo static servers
  bonk/
    README.md               earlier handoff copy of this document
    sim.js                  game simulation used by the server, ~542 lines, no rendering code
    tests.js                Node checks for the sim (node tests.js)
    client/                 the two playable clients (section 8)
      ui.html  gl.js  game.js           copied unchanged from your reference project
      bjs.js                        the Babylon.js renderer (new)
      build.py                      builds both clients from the shared sources + ../sim.js
      mock_babylon.js               a stand-in for the Babylon API, for headless testing only
      test_clients.js               browser tests (Playwright)
      dist/sim-race-babylon.html    built Babylon client (needs internet for the library)
      dist/sim-race-webgl.html      built WebGL1 client (no network needed)
    reference/
      game_Babylon_js/        the "Sim Race" project you supplied, unchanged
        ui.html  gl.js  game.js  sim-1.js  build.py
        sim-race-1.html       the built game (one file)
        sim-race-tests.zip    its own test scripts
```

**MP sim-duplication gotcha:** the client's sim is an *embedded copy* of `bonk/sim.js` (differs only in the `_mpInput` selection line and the Node export). Any sim change must be made in **both** or client/server physics diverge silently.

---

## 4. Decisions already made

- **Runs in the browser, no download.** Unity WebGL was considered and skipped for this goal.
- **Renderer: Babylon.js, plus the WebGL1 build as a safe baseline.** `client/build.py` makes both from the same `game.js`. The Babylon build loads the library from cdnjs, pinned to `8.20.0/babylon.js` (the cdnjs library page lists exactly that file; I did **not** confirm 8.20.0 is the newest release, so check), with `https://cdn.babylonjs.com/babylon.js` as a fallback if cdnjs fails.
- **Game logic lives in `sim.js`, separate from rendering.** The renderer only reads state. The same file is meant to run later inside a Colyseus room (server-authoritative).
- **Physics: a hand-rolled kinematic controller over oriented boxes**, not Rapier. The first advice listed Rapier (WASM); the prototype went simpler, since it is deterministic, tiny and easy to run on a server. Rapier is still an option if ragdolls or loose props are wanted.
- **Multiplayer: Colyseus (Node.js)** with room codes or share links; server-authoritative with client prediction. Start with 4 players, aim for 8 to 12.
- **Hosting:** static files on Cloudflare Pages or Netlify, game server on Fly.io or Railway.
- **Combat is knockback only.** Bullets, dives and hazards stun and shove; nobody dies. Falling off the course respawns you at your last checkpoint.
- Keep the total download **under ~20 MB**. Assets are procedural low-poly; Kenney free assets are an option for polish.

## 5. Roadmap

1. Movement prototype: done (sim)
2. Obstacles and course: done (sim)
3. **Babylon client: next**
4. Rooms and lobby (Colyseus, room code or link)
5. Netcode: server-authoritative + local prediction, interpolation + smooth own-player correction — **done** (section 10)
6. Combat polish: more pickups or weapon variants
7. Rounds: several courses, results, rematch
8. Polish: art pass, sound, music
9. Phone performance pass

---

## 6. `sim.js` reference

```js
const S = Sim.create(seed);                  // deterministic course and bot RNG
S.humanId = 0;                               // the id that takes humanInp (-1 = all bots)
S.addPlayer({ name, bot, kind, skill });     // kind is a free label for the renderer (default 'zombie'); skill 0..1 for bots
S.begin();                                   // reset, then a 3 s countdown, then the race
S.step(dt, { mx, mz, jump, dive, fire });    // call every frame
S.ranking();                                 // finished first (by time), then by z
S.reset('menu');                             // back to the menu state
// Browser: paste sim.js into a <script>; `Sim` is a global. Node: require('./sim.js').
```

- **Axes:** +Z is forward along the course, +Y is up. `yaw 0` faces +Z, heading is `(sin yaw, cos yaw)`. The reference project uses the same axes (its renderer mirrors X in the projection so +X is screen-right when looking down +Z).
- **Input** is in world axes. The client converts camera-relative stick or keys into `mx, mz`.
- **`S.step`** clamps `dt` to 1/20 and sub-steps at 1/60 or smaller. One-shot flags (`jump`, `dive`, `fire`) are given to the first sub-step only.
- **Phases:** `'menu'` (world animates, nobody can act), `'countdown'` (`S.cd` seconds left), `'race'`. There is **no race-end rule**; the client or room decides (for example, results a few seconds after the human finishes).
- **Read-only state for the renderer:** `t`, `raceT`, `phase`, `cd`, `finishCount`, `players[]`, `bullets[]`, `solids[]`, `deco[]`, `pickups[]`, `cps[]`, `finishZ` (183), `length` (193).

**Players** (feet position `x,y,z`): `id, name, bot, kind, yaw, vx,vy,vz, ground` (a solid, or null), `stun` and `stunMax` (seconds), `flop` (+1 or -1, which way to tumble), `getup`, `diveT`, `diveCd`, `fireCd`, `protect` (spawn protection seconds), `dead` (seconds until respawn; **hide the player while > 0**), `ammo`, `cp`, `finished`, `finishT`, `place`, `falls`, `bonks`.

**Solids** are oriented boxes: `id, kind, shape, name, color` (hex string), `cx,cy,cz` (centre), `hx,hy,hz` (half sizes; a `round` solid has radius `hx`), `yaw`, `hazard`, `bounce`, `active`, and for crumble tiles `state` (`idle | shake | fall | gone`). Positions already include motion; the renderer never simulates.
Shapes: `slab, bar, mover, tile, piston, pad, disc` (solid) and `hub, rail` (deco only).

**Rotation:** by hand from Babylon's row-vector `RotationY` I get that `mesh.rotation.y = solid.yaw` (and `= player.yaw`) matches the sim in Babylon's default left-handed system. This is derived, not tested. Verify visually.

**Events:** `S.ev` is a queue of `{ t, id, x, y, z, ...extra }`. **Drain and clear it every frame** (`S.ev.length = 0`). `id` is -1 for non-player events.

| type | extra | use |
|---|---|---|
| `go` |  | race start |
| `jump`, `dive`, `fire`, `hit`, `respawn`, `fall`, `pickup` |  | sounds, puffs |
| `land` | `power` | dust size |
| `bounce` |  | pad squash, whoosh |
| `bonk` | `by` | hit sparks, star burst (`y` is chest height) |
| `cp` | `cp` | checkpoint flag pop |
| `finish` | `place` | confetti |
| `shake`, `crumble` | tile x,y,z | tile jitter, debris |
| `spark` |  | bullet hit on a solid |

**Tuning constants:** run 7.4, ground accel 55, gravity 27, jump velocity 9.8 (about 1.8 high, about 5.4 far at run speed), coyote 0.12 s, jump buffer 0.14 s, dive 0.5 s then 0.5 s stun (cooldown 1.4 s), blaster 5 max ammo, pickup +3 ammo (respawns after 9 s), bullet speed 26 for 0.9 s, fire cooldown 0.3 s, kill height -9, spawn protection 1.5 s, death delay 1.1 s. Player collider: radius 0.42, height 1.5.

**Knockback:** bullet shove is 0.3x bullet speed, +5.5 up, 0.9 s stun. Dive hit is 9.5 shove, +5.2 up, 1.0 s stun. Hazard hit is 0.8 s stun and a hop.

**Bots:** follow a waypoint route with look-ahead, lane jitter and a skill-based wobble. They jump gaps, lead their jumps onto moving platforms, jump hazards using a predicted overlap check, wait on solid ground for an unavailable crumble tile, dive at nearby racers and shoot targets in front of them.

### Course (about 193 long, 7 checkpoints; top = surface height)

| z | piece | notes |
|---|---|---|
| -5 to 9 | start slab, 16 wide | six start slots |
| 9 to 45 | spinner alley, 14 wide | two spinning bars: one at z=20, a cross at z=34 |
| 48.5 to 53.5 | rest slab | 3.5 gap before it (first jump) |
| 56.5 to 67 | two sliding platforms | 6 wide, slide +/-3.2 each, opposite phase |
| 70 to 82 | three crumbling tiles, stepping up (0.4, 0.8, 1.2) | drop 1.2 s after first touch, back about 1.8 s after they drop |
| 84 to 90 | rest slab 2 (top 1.5) |  |
| 90 to 120 | pusher bridge, 4 wide (top 1.5) | four alternating pistons at z=95, 101, 107, 113 |
| 120 to 128 | launch slab with a bounce pad at z=125.2 | pad launches at 17.5 |
| 131.5 to 148 | landing slab (top 3) | you must keep moving forward over the pad |
| 152 to 162 | big spinning disc (round, radius 5) | slow, om 0.5 |
| 165 to 177 | final slab with a cross spinner at z=171 |  |
| 177 to 193 | finish slab | finish line at z=183 |

Six ammo pickups at z = 27, 51, 87, 123, 141, 166. Checkpoint respawn points are in `S.cps`. Palette used in the sim: pink `#ff8fb8`, lavender `#b79cff`, yellow `#ffd23f`, coral `#ff7a59`, orange `#ffb86b`, sky `#8bd3ff`, mint `#5ef2a5`/`#6fe3b8`, hazard red `#ff3d6e`/`#ff4f6d`.

---

## 7. Tests (Node only)

```
node tests.js              invariants + bot statistics
node tests.js invariants   standing on every slab, jump/dive/fire, fall + respawn, crumble cycle, determinism
node tests.js stats        6-bot packs x 12 seeds, plus solo runs
node tests.js race 7       one verbose race
node tests.js falls        why do bots fall in the crumble section?
node tests.js trace 55 90  frame-by-frame history of the first falls in a z range
```

Results at handoff:
- **All invariants pass:** no falling through any slab, human input works, crumble cycle is `shake > fall > gone > idle` and restores in place, same seed gives the same result.
- **Packs (6 bots x 12 seeds):** 72 of 72 finished. Finish time p10 / p50 / p90 = **27.7 / 41.8 / 70.7 s**. 3.86 falls per bot.
- **Solo bots:** 18 of 18 finished, 0.61 falls per run, **25 to 46 s**.

**Known tuning issues (not fixed):**
1. **Crumble tiles are the bottleneck in a pack:** about 2 falls per bot there. In the diagnostic (96 falls), 47 were bots stunned by a bonk just before falling, 15 stood on a tile as it dropped, 34 other. Solo bots almost never fall there. Ideas: bots stop shooting or diving near ledges, longer shake time, wider tiles.
2. **Pusher bridge:** 67 falls in packs, 5 in solo runs. Decide if that is too punishing.
3. **Dive and fire are not input-buffered** (jump is).
4. **Only 6 start slots** (more players wrap onto the same slots).
5. **Never human-playtested.** The feel of run speed, jump, dive and knockback is untested.
6. **No race-end rule or results screen** in the sim.

**Browser tests** (`client/test_clients.js`, needs Playwright and a Chromium; header comment explains the environment variables):
- WebGL build: menu, countdown, running, finish line, results card with six racers, second race. All pass, no console errors.
- Babylon build against `mock_babylon.js`: same flow, plus the racer node matches the sim position exactly, one mesh per sim solid (25 of 25), pickups match, six rigs with no duplicates after a restart, generated geometry passes length, index and unit-normal checks. All pass. The URL flags `?debug`, `?lowfx=1` and `?shadows=0&glow=0&outline=0` also pass a smoke run.
- Babylon build with the CDN unreachable: shows a clear on-screen message instead of a blank page.
- **The simulation runs slower than real time in software GL, so tests wait on sim state, not on timers.**

---

## 8. Babylon client (`client/`)

**Build:** `cd client && python3 build.py` writes `dist/sim-race-babylon.html` and `dist/sim-race-webgl.html` (it reads `../sim.js`; put a `sim.js` next to it to override). `python3 build.py babylon` or `webgl` builds one.

**How it is put together:** the Babylon build is `game.js` with two blocks swapped at build time (the renderer lookup at the top, and the drawing section), so input, HUD, audio, menu and results are the *same code* in both builds. `bjs.js` provides five calls: `rgb`, `beginFrame` (camera), `scene` (course), `actors` (racers, pickups, bullets) and `fx` (particles, then renders). If `bjs.js` fails to start, the page shows an error card with the reason.

**Babylon features used:** `StandardMaterial` with vertex colours (checker tiles, hazard stripes and disc wedges are baked into generated geometry, no textures), hemispheric + directional lights, `ShadowGenerator` (PCF, frustum follows the action), `GlowLayer` (pickups, bounce pad, bullets), the built-in outline renderer (racers only), one `SolidParticleSystem` for all particles, linear fog, hardware scaling, optional Inspector. A transparent canvas lets the page's CSS sky show through, as in the reference.

**URL flags:** `?debug` shows a badge (Babylon version, fps, mesh count, which effects are on, and any that switched themselves off), `?shadows=0`, `?glow=0`, `?outline=0`, `?lowfx=1` (smaller shadow map, no glow, lower resolution; this is the default on touch devices), `?inspector` loads the Babylon Inspector from its CDN (untested). Optional effects are wrapped so a failure turns that one effect off instead of stopping the game.

**What changed against the reference look:** real sun shadows plus a faint blob under each racer, glow on pickups, pad and bullets, Babylon's outline on racers. **Not reproduced:** the reference's black ink outline around every course piece. Babylon's outline works on smooth normals and breaks at the corners of boxes, so I left it off the world. Easiest fix later: draw slightly larger inverted-winding black copies.

### What was and was not verified

**Verified** (headless Chromium, software WebGL): the section 7 browser tests, and the WebGL build with a screenshot that looked right. I also rendered the Babylon scene through the stand-in's small rasteriser, which I wrote to follow Babylon's conventions as I understand them (left-handed, row-vector matrices, YXZ Euler order, `LookAtLH`); I could not check those conventions against the library. Layout, colours, characters and camera direction looked right in those images. Those screenshots are **not** what real Babylon draws.

**Not verified:**
- **Anything against the real Babylon.js.** The sandbox had no network, so the library could not be downloaded. I checked the riskiest usage against Babylon forum threads and example code found by web search (not by running the library): vertex colours multiply the material's `diffuseColor` (so diffuse is white on vertex-coloured meshes), the shadow frustum follows the action through `shadowFrustumSize` plus the directional light's `position`, and per-particle alpha in a `SolidParticleSystem` needs `mesh.hasVertexAlpha = true`. Everything else is from memory and has **not** been run against the library.
- How shadows, glow and outlines actually look and perform. Lighting values copy the reference's shader numbers, but real `StandardMaterial` may come out brighter or darker.
- Phones and low-end GPUs.
- That 8.20.0 is the right version to pin.

**First thing to do:** open `client/dist/sim-race-babylon.html` in a desktop browser with internet. Add `?debug`. If shadows look wrong, try `?shadows=0`; if it will not start, the card on screen says why. `sim-race-webgl.html` works with no internet.

### What is left
1. Look at the real Babylon output and tune: light intensities, shadow bias and darkness, glow strength, outline width.
2. Decide on world outlines (see above).
3. Phone test and performance pass.
4. The original Bob Zombie and Chibi Student characters are not in this bundle any more; the six capsule racers from the reference are used.
5. Multiplayer (section 10).

---

## 9. Reference project: Sim Race (`reference/game_Babylon_js/`)

This replaces the old Three.js character-viewer concept. It is a **playable single-file client** you supplied (`game_Babylon_js.zip`), kept here unchanged as a reference for look, UI and feel.

> **Despite the zip name, it does not use Babylon.js.** The renderer is `gl.js`, a hand-written WebGL1 engine ("no libraries"). Nothing in the project calls Babylon.

| File | Role |
|---|---|
| `ui.html` | page shell and CSS: menu with character picker, HUD, results, error screen. Candy palette in CSS variables (`--ink #2a1a5e`, pink `#ff8fb8`, lilac `#b79cff`, yellow `#ffd23f`, mint `#6fe3b8`, sky `#8bd3ff`, coral `#ff7a59`, paper `#fffdf7`), rounded system font stack, outlined display text, phone safe-area insets |
| `gl.js` | WebGL1 renderer: lit meshes with fog and procedural patterns, blob shadows, point-sprite particles. X is mirrored in the projection so +X is screen-right while the camera looks down +Z |
| `game.js` | input, camera, HUD, WebAudio and drawing; reads the sim every frame and feeds it `{ mx, mz, jump, dive, fire }` |
| `sim-1.js` | the sim it was built on (see "Sim version" below) |
| `build.py` | inlines `gl.js`, `sim.js` and `game.js` into `ui.html` and writes `sim-race.html` |
| `sim-race-1.html` | the built game, one file |
| `sim-race-tests.zip` | its test scripts (11 files) |

- **Characters:** six kinds drawn from primitives, each with a colour and a hat: Zombie, Pumpkin, Ghost, Robot, Bubblegum, Banana. The sim treats `kind` as an opaque label, so the renderer decides what it means. The old Bob Zombie and Chibi Student rigs are no longer part of this bundle.
- **Controls:** WASD or arrows to move, Space jump, Shift or K dive, F or J fire, R restart, Esc back to menu, Enter to start or race again. Touch joystick with buttons on phones. WebAudio sound, countdown, HUD, results card, and a best time kept for the session.
- **Build:** put `gl.js`, `sim.js`, `game.js`, `ui.html` and `build.py` in one folder and run `python3 build.py`. The zip's files carry download suffixes (`sim-1.js`, `sim-race-1.html`) but `build.py` reads `sim.js`, so **rename `sim-1.js` to `sim.js` first**. I did that in a scratch folder and the rebuilt `sim-race.html` was **byte-identical** to the supplied `sim-race-1.html`.
- **Sim version:** `sim-1.js` (509 lines) is the **earlier** version of this bundle's `sim.js` (542 lines). I diffed them. The differences are only the later tuning and bot changes: round disc collision (a `round` flag), shared `footprint()` and `solidAt()` helpers, predictive hazard jumping and tile waiting for bots, wider and slower sliders, slightly larger crumble tiles that hold 1.2 s instead of 0.6 s before dropping and return sooner, softer bullet knockback, calmer bot dive and fire cadence, and the final checkpoint respawn at z=166.5 instead of 169. Player fields, events and the step API are the same, so dropping the newer file in as `sim.js` and rebuilding works: `client/dist/sim-race-webgl.html` is this reference client built on the newer sim, and it passes the browser tests in section 7.
- **Its tests:** `sim-race-tests.zip` holds Node smoke scripts and Playwright / headless-Chromium scripts (title screen, desktop playthrough, phone emulation, obstacle tour, results card, 20 s random-input soak). Per its own README they have the original sandbox paths hard-coded (`/home/claude/build/sim-race.html`, `/mnt/user-data/uploads/sim.js`, the Playwright install path), so edit those first. **I did not run these scripts.** I did open `sim-race-1.html` in headless Chromium: it starts, races, and logs no console errors.

**How it is used now:** `client/` reuses its `ui.html`, `gl.js` and `game.js` unchanged and adds `bjs.js` (section 8). The reference folder stays as supplied, including its older `sim-1.js`.

---

## 10. Multiplayer netcode — current state, diagnosis record, verification

Multiplayer is **built and smooth**: rooms, lobby, authoritative 30 Hz server, tick-aligned compact 15 Hz snapshots, 100 ms interpolation for remotes, smooth own-player correction, change-detection input. **All P0/P1/P2 fixes have landed and are verified** by `test_mp_client_sim.js` and `test_mp_e2e.js` (10.6). The diagnosis below (10.1–10.5) is kept as the record of what was wrong and why each fix is shaped the way it is. Re-verify line numbers before editing — they move.

### 10.1 Architecture (current)

```
your keys ─(mp_input, on change + 100 ms keepalive)─▶ postMessage ─▶ lobby.html ─▶ WebSocket ─▶ mp-server.js
                                                                              │ authoritative sim, 30 ticks/s
      game iframe ◀─postMessage─ lobby.html ◀── WebSocket ── compact state broadcast, 15 Hz (every 2nd tick, tick-aligned)
```

- **`mp-server.js`** — Node + ws. One authoritative `bonk/sim.js` per room (`humanId = -1`; humans driven through `p._mpInput`). One `setInterval` for the 30 Hz sim tick; state is broadcast **from inside `tick()`** every 2nd tick (`mp-server.js:309`), so consecutive packets are always exactly two sim ticks (66.7 ms) apart and carry a fresh post-tick state. Payload is the compact fixed-point format documented above `broadcastState` (`mp-server.js:312-327`). Also: rooms, host settings, bots, kick, host transfer, results, rematch, and a 1 Hz `ping`/`pong` RTT probe (`mp-server.js:526`).
- **`lobby.html`** — the WS client and room UI. Pure relay: server `state`/`events`/`pong` → `postMessage` to the game iframe (one message per packet); iframe `mp_input`/`mp_ping` → WS, forwarded verbatim.
- **`sim-race-webgl.html?mp=1`** — the game in the iframe. Runs a full local sim (same seed + roster as the server) on **fixed `1/60` sub-steps** (rAF time accumulated) so its sub-step size matches the server's `h`. The netcode block is `sim-race-webgl.html:1577-1723`:
  - `decodeState()` inverts the compact wire format.
  - A ring of the last 10 snapshots (`snapBuf`); **remotes (other humans AND bots) are rendered 100 ms behind the local clock**, lerped between the two bracketing samples (`lerpPair`). Their pos/vel/yaw are written into the local sim before each step and re-applied after it, so local physics never owns their motion (it only resolves their collisions) — no more 15–20 Hz pulse. Discontinuities > 8 u (fall/respawn) snap to the newer sample instead of lerping across the map.
  - **Own player:** local prediction (your input applied the same frame) with a decaying correction toward the velocity-extrapolated server position (`f = 1 − exp(−10·dt)`); instant hard snap only on true discontinuities (fall/respawn, phase change, |err| > 4 u).
  - **Bullets:** your live bullets stay local; remotes are rebuilt by `id` between the two bracketing samples each frame (new bullets backdated to render time, held out until they clear the muzzle).
  - **Crumble tiles:** the falling `cy` is interpolated like player positions.
  - `sendMPInput()` posts input only on change (+ one-shot pulses + 100 ms keepalive) — not every frame.
  - `?net=1` shows a live overlay: RTT, packet-arrival gap p95, hard-snap count, current correction magnitude, interpolation delay.
- **`sim-race-babylon.html`** — solo only; no MP mode.

### 10.2 What already works

- Server-authoritative rooms, roster/order, bots, host settings (spinner speed, crumble hold, bounce force, gravity), kick, host transfer, results, rematch.
- **Your own input feels fine**: the local sim applies it the same frame (~1-frame latency); the correction is now the smooth decaying one (P0-C), not the old hard snap.
- Discrete events (bonk/fall/finish/fire/…) relayed by the server so effects play on other clients; the client filters to remote humans only.
- Tests: `test_mp_client_sim.js` (the shipped netcode, extracted verbatim from the HTML, run 15 s against a real 30 Hz server sim with 1-tick input + delivery latency), `test_mp_e2e.js` (real server, two WS clients through create/join/start/input/state, tick alignment, client agreement, payload size) and `test_mp_init.js` (the client `mp_init` flow incl. bots). All green.

### 10.3 Latency budget, as it stands (LAN)

| stage | time |
|---|---|
| key → local sim (your own motion) | 1 frame (~16 ms) — fine |
| key → lobby → server | ~2–5 ms + JSON overhead; input is sent only on change, so usually one small packet |
| server: wait for next tick | 0–33 ms (avg 17) |
| server: wait for next state broadcast | 0–33 ms (broadcast is tick-aligned, so always a whole tick; no independent timer drift) |
| **your action visible to other players** | ~50–90 ms + RTT/2 — arriving as uniform 66.7 ms samples that the clients interpolate, so it reads as one smooth 100 ms-delayed stream, not 20 Hz steps |
| their action visible to you | same, minus the snap artifact — remotes **are** the interpolation |

The iframe/postMessage hop is sub-millisecond and is **not** a problem. The remaining fixed cost is the deliberate 100 ms interpolation delay (`INTERP_DELAY`); drop it to 0.08 s if a LAN feel ever needs it.

### 10.4 Root causes of the choppiness (pre-fix state, by impact)

All eight are fixed (10.5); line numbers below point at the old code.

1. **Remote players are 20 Hz snap-steps.** For every player but yourself, the local sim gets `EMPTY` input (`bonk/sim.js:527`), so locally they friction-slide to a stop; each state packet snaps them back to server pos/vel, then local physics bleeds their velocity off again. At run speed (7.4 u/s, ground decel 65 u/s²) the local sim takes ~50 ms — exactly one update — to decay their speed to ~0. So **every remote player visibly re-pulses on every 50 ms packet**. The 0.2² threshold is exceeded almost every frame; the snap effectively fires on every packet.
2. **Two independent server timers.** Tick (33.3 ms) and state (50 ms) are separate `setInterval`s (`mp-server.js:251-252`): the sim-time gap between consecutive packets alternates 33/50/67 ms and drifts; packets carry no tick index. Even a good interpolator would judder on that cadence.
3. **Own-player rubber-band via hard snap.** Local prediction is right, but correction is an instant pos+vel overwrite once error² > 2.0 (`sim-race-webgl.html:1841-1843`). Divergence accumulates from (a) your input reaching the server ~RTT/2 + up to one tick after the local sim already applied it, and (b) mismatched sub-step size: the server always steps at exactly `h = 1/60` (`bonk/sim.js:532-536`: dt = 1/30 → 2 sub-steps), while the client feeds variable rAF `dt`, so its `h` jitters ~16.5–16.8 ms frame to frame. Slow drift → pop.
4. **Bullets snap at 20 Hz.** `sim.bullets = s.bullets` wholesale (`sim-race-webgl.html:1854`); a bullet at 26 u/s moves 1.3 units per packet. The local `stepBullets` happens to keep integrating the server's array objects between updates (accidental extrapolation), but the array is replaced every packet and your own just-fired bullet can vanish/reappear. Visible flicker.
5. **Input pipeline: 60 JSON msgs/s, no change detection.** `mp_input` is posted every frame (`sim-race-webgl.html:1575`) and the lobby forwards each one verbatim to the WS. Keyboard mx/mz ∈ {−1, 0, 1}, so ~50 of the 60/s are duplicates — wasted JSON at every hop (iframe clone → lobby stringify → server parse + handler).
6. **Crumble tiles desync while falling.** The client applies the server `state`/`active` but not `cy` (`sim-race-webgl.html:1850-1853`), then integrates its own fall from a stale height on its own clock — tiles fall at different heights/times on different clients.
7. **Bots double-simulated.** Local `think()` runs with a divergent PRNG stream (`R()` consumption depends on sub-step cadence) and timing → local-only bot decisions and events (a bonk that never happened on the server), later corrected by snaps. The "ghost" interactions.
8. **Minor:** the server logged 5% of inputs mid-tick (removed); `sim.t` only re-syncs when drift > 0.3 s (`sim-race-webgl.html`), so a throttled background tab drifts silently; `broadcastState` allocated a `toFixed` string per field per player at 20 Hz (GC churn on the server — fixed in P2 with fixed-point integer serialization, no strings).

### 10.5 Fix plan (all landed)

**P0-A · Server: one timer, broadcast aligned to ticks — DONE** as written; the input `console.log` went with it. `test_mp_e2e.js` asserts the resulting cadence (100% of gaps within 0.05–0.085 s, avg 66.7 ms).

**P0-B · Client: interpolation buffer for everything remote — DONE.** Ring is 10 snapshots; delay 100 ms. One addition the plan didn't name: the local `step`'s neutral-input physics bleeds the remotes' velocity, so the interpolated values are re-applied **after** the step too — what renders is the interpolation itself. Discontinuities > 8 u snap instead of lerp. This fixed 1, 4 (with the id-keyed bullet rebuild), 6 and 7, and makes 2 invisible.

**P0-C · Client: smooth own-player correction — DONE** as written, plus the server sample is velocity-extrapolated by its age before the correction, so the target stays on the moving player's line and the correction magnitude stays small (test p95 0.36 u over 15 s).

**P1 · Client: fixed-timestep local sim — DONE** as written; backlog past 5 sub-steps is dropped instead of spiralling.

**P1 · Input: send on change — DONE** as written (`sendMPInput`, 100 ms keepalive).

**P2 · Compact payloads — DONE.** State packets are now keyless positional arrays in fixed-point (positions ×100, velocities ×10, sim time in ms; player index = player id, no `id` field; documented above `broadcastState` in `mp-server.js`, reversed by `decodeState()` in `sim-race-webgl.html`). This is far smaller than the old per-field objects (e2e measures the average: 4 players + crumble tiles ≈ 370 bytes vs ~1.9 KB) and removes every `toFixed` from the 15 Hz hot path — `Math.round` integers instead of per-field string allocation. Event packets also quantize their x/y/z to 2 decimals on the wire (clients only use them to place effects). `test_mp_e2e.js` has a size regression guard. `perMessageDeflate` still considered only if measured to help — it trades CPU for bytes.

**Considered, not doing:**

- **Delta/diffed snapshots** — worthwhile at 32+ players; at ≤8 players full 15–30 Hz state is smaller in practice and far simpler. Revisit if rooms grow.
- **Binary payloads (Float32Array + binary WS frames)** — ~2× smaller and no parse cost, but only worth it once P2 shows JSON is actually a hotspot.
- **Server lag compensation (rewind to input timestamp)** — for frame-perfect hit resolution; this game's knockback physics is forgiving and 15–30 Hz authoritative state suffices.
- **Extrapolation of remote players** instead of interpolation — amplifies jitter and packet loss; interpolation is the standard for this game class.
- **Colyseus** (originally planned, section 4) — it's the same netcode model (tick + snapshot + client-side interpolation); the hand-rolled server is working, no reason to switch now.
- **WebRTC datachannel / P2P** — only if hosting cross-region with high RTT demands lower remote-player latency than the interpolation budget tolerates.

### 10.6 Verification (results)

- **`node test_mp_client_sim.js`** — extracts the shipped netcode block verbatim from `sim-race-webgl.html` and runs it, unmodified, against a real `bonk/sim.js` server at 30 Hz with 1-tick input delay and 1-tick delivery latency (15 s of race, 3 racers incl. a bot). All pass:
  - remotes track the server's interpolated position: p95 0.36 u, mean 0.20 u, **zero** velocity-decay frames;
  - own player's correction stays within p95 0.36 u;
  - remote bullets (rebuilt by id, ~20 shots) track the server to p95 0.01 u;
  - a just-fired own bullet survives the per-frame rebuild while the server hasn't seen it;
  - the snapshot ring stays bounded.
  (Test gotchas learned the hard way: the server copy of your own player needs ammo — the client's is synced down from it; bullets die fast on the spinner bars, so a few shots yield too few samples; and a fall→respawn teleport makes a linear reference meaningless, so those intervals are skipped.)
- **`node test_mp_e2e.js`** — real server, two WS clients: tick-aligned state (100% of gaps 0.05–0.085 s, avg 66.7 ms), compact payloads (avg ~367 B vs ~1.9 KB old), both clients agree on every player position to < 0.011 u at the same server time, all four racers advance, events relayed, no server errors.
- **`?net=1` overlay** — RTT (1 Hz ping relayed through the lobby), packet-arrival gap p95, hard-snap count, live correction magnitude, interpolation delay. How to prove it is actually smoother, not just different.
- **Two-window playtest (recommended, not run in the sandbox):** open the lobby in two browsers against the same server: remote players should move at 60 fps with no pulse, own player never pops except on respawn, crumble tiles fall in sync, bullets travel smoothly.
- **Solo mode untouched:** every P0/P1 change is gated behind `isMP` (`sim-race-webgl.html:1298`) or is server-side, so `index.html` and the Babylon client are unchanged.
