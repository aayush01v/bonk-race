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
| Multiplayer (Colyseus rooms, netcode) | Not started |

Both clients share one `game.js` (input, HUD, audio, menu, results) taken unchanged from your reference project; only the renderer differs. **The honest gap: nobody has seen the Babylon build render with the real Babylon.js**, because my sandbox could not download it. Open it in a browser first (section 8).

---

## 2. Start the next session

Upload `README.md`, `sim.js`, and the `client/` folder (or just the bundle zip).

Paste something like:

> Continue the project described in README.md. Read it, run `node tests.js`, then in `client/` run `python3 build.py`. I opened client/dist/sim-race-babylon.html in my browser and this is what I saw: [describe it, or paste the on-screen error / browser console text; adding `?debug` to the URL shows a status badge]. Fix client/bjs.js, rebuild, run `node test_clients.js`, and tell me honestly what you could and could not verify.

Check the new session's environment first (`node --version`, is there a browser, is the network on). Last time: Node 22, Python 3.12, **no network**, but a headless Chromium was usable through Playwright (software WebGL), which is what `client/test_clients.js` drives.

---

## 3. Files

```
bonk/
  README.md                 this file
  sim.js                    game simulation, ~540 lines, no rendering code
  tests.js                  Node checks for the sim (node tests.js)
  client/                   the two playable clients (section 8)
    ui.html  gl.js  game.js           copied unchanged from your reference project
    bjs.js                            the Babylon.js renderer (new)
    build.py                          builds both clients from the shared sources + ../sim.js
    mock_babylon.js                   a stand-in for the Babylon API, for headless testing only
    test_clients.js                   browser tests (Playwright)
    dist/sim-race-babylon.html        built Babylon client (needs internet for the library)
    dist/sim-race-webgl.html          built WebGL1 client (no network needed)
  reference/
    game_Babylon_js/        the "Sim Race" project you supplied, unchanged
      ui.html  gl.js  game.js  sim-1.js  build.py
      sim-race-1.html       the built game (one file)
      sim-race-tests.zip    its own test scripts
```

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
5. Netcode: server-authoritative, client prediction, interpolation for remote players
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

## 10. Multiplayer notes (later)

- `humanId` / `humanInp` only supports **one** human. For multiplayer, change `sub()` and `S.step()` to take **per-player input** (for example `p.input`, or a map keyed by id).
- Moving solids (`spin`, `slide`, `piston`) are pure functions of `S.t`; only crumble tiles carry a state machine. So a client needs the server time offset plus tile states to render the world identically.
- `p.ground` is an object reference; send its `id` over the wire. Add snapshot serialisation, input sequence numbers, client prediction with reconciliation, and interpolation for remote players (about 100 ms).
- The sim is deterministic for a given seed and input stream (tested with bots), which makes server-authoritative play with client prediction realistic.
