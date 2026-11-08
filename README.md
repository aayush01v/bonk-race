# Bonk Race

Bonk Race is a browser-based low-poly obstacle race with knockback combat. The
game runs without a build toolchain in production: the playable clients are
single HTML files, and the multiplayer server is a small Node.js process.

## Architecture audit

**Audit scope:** repository structure, runtime flow, build process, multiplayer
server, simulation boundaries, and automated verification.

### Runtime topology

```text
                         ┌──────────────────────────────┐
                         │        mp-server.js          │
                         │ HTTP static files + WebSocket│
                         │ rooms + authoritative Sim    │
                         └──────────────┬───────────────┘
                                        │ /ws
                         ┌──────────────▼───────────────┐
                         │          lobby.html          │
                         │ room UI + WS relay           │
                         └──────────────┬───────────────┘
                                        │ postMessage
                         ┌──────────────▼───────────────┐
                         │ sim-race-webgl.html?mp=1      │
                         │ local prediction + netcode    │
                         └──────────────┬───────────────┘
                                        │
                         ┌──────────────▼───────────────┐
                         │        bonk/sim.js            │
                         │ deterministic movement,       │
                         │ collisions, hazards, combat,  │
                         │ pickups, bots, and events     │
                         └──────────────────────────────┘
```

Solo mode skips the lobby and WebSocket layers. `index.html` launches the
WebGL client; `sim-race-babylon.html` is the Babylon.js solo client.

### Component responsibilities

| Component | Responsibility |
|---|---|
| `bonk/sim.js` | Shared deterministic simulation and public state/event model. It has no rendering or browser API dependencies. |
| `mp-server.js` | Room lifecycle, host settings, bots, input validation, authoritative 30 Hz simulation, compact snapshots, event relay, and static serving. |
| `lobby.html` | Multiplayer UI and transport relay. It does not own game physics. |
| `bonk/client/game.js` | Shared client input, HUD, audio, menus, results, camera, and frame loop. |
| `bonk/client/gl.js` | Hand-written WebGL1 renderer and offline-safe baseline. |
| `bonk/client/bjs.js` | Babylon.js renderer and optional visual effects. |
| `bonk/client/build.py` | Inlines the shared sources into the two single-file client artifacts. |
| `bonk/inputbuf.js` | Server-side stamped-input buffering and acknowledgement tracking. |
| `server.js` / `server.py` | Solo/static development servers; `mp-server.js` is the multiplayer entry point. |

### Multiplayer data flow

1. The authoritative server owns one `Sim` instance per room and advances it
   at 30 Hz using a deadline-based ticker.
2. Clients send changed input plus a 100 ms keepalive. The server clamps and
   buffers stamped input before applying it to the matching player.
3. The server broadcasts fixed-point, positional-array snapshots every tick.
   Events carry the server simulation timestamp so clients can schedule remote
   effects against interpolated time.
4. The WebGL multiplayer client runs a local copy of the simulation at fixed
   1/60 sub-steps. It predicts the local player, interpolates remote players,
   reconstructs remote bullets, extrapolates briefly during packet starvation,
   and applies decaying corrections to the local player.
5. The lobby forwards WebSocket messages to the game iframe with
   `postMessage`; it is intentionally not an authority boundary.

### Architectural strengths

- Simulation and rendering are separated, so the same physics runs in Node,
  WebGL, and Babylon clients.
- The server is authoritative while local prediction keeps own-player input
  responsive.
- Fixed simulation steps, stamped input, aligned snapshots, and compact
  serialization make the netcode testable and bandwidth-efficient.
- Procedural geometry keeps the client small and avoids an asset pipeline.
- The WebGL client provides a no-CDN fallback when Babylon.js is unavailable.

### Risks and follow-up

- **Generated-client drift:** `bonk/client/dist/*.html` are built artifacts,
  while the root `sim-race-webgl.html` and `sim-race-babylon.html` are also
  tracked copies used by the server/tests. Rebuild and keep both locations in
  sync after changing `bonk/sim.js`, `game.js`, or a renderer.
- **Babylon verification boundary:** automated Babylon coverage uses
  `bonk/client/mock_babylon.js`; real Babylon CDN rendering and device/GPU
  performance still require a browser with network access.
- **Single-process scaling:** all rooms and simulations live in one Node
  process and in-memory maps. Horizontal scaling would require shared room
  discovery/state or session affinity.
- **Transport hardening:** the current server is suitable for a prototype;
  authentication, abuse/rate limiting, origin policy, persistence, and
  production TLS/reverse-proxy deployment are not implemented.
- **Gameplay tuning:** bot packs pass simulation tests, but obstacle difficulty
  and combat feel still need human playtesting.

## Repository layout

```text
.
├── mp-server.js                    Multiplayer HTTP + WebSocket server
├── server.js / server.py           Solo static servers
├── lobby.html                      Multiplayer lobby and relay
├── index.html                      Solo launcher
├── sim-race-webgl.html             WebGL client used by server/tests
├── sim-race-babylon.html           Babylon solo client
├── bonk/
│   ├── sim.js                      Shared simulation source of truth
│   ├── inputbuf.js                 Stamped input buffer
│   ├── tests.js                    Simulation invariants/statistics
│   ├── client/
│   │   ├── ui.html                 Shared page shell and CSS
│   │   ├── game.js                 Shared client runtime
│   │   ├── gl.js / bjs.js          WebGL1 and Babylon renderers
│   │   ├── build.py                Single-file client builder
│   │   ├── test_clients.js         Browser smoke tests
│   │   └── dist/                   Generated client artifacts
│   └── reference/                  Original reference project
└── test_mp_*.js                    Multiplayer pipeline and latency tests
```

## Run locally

```bash
npm install
npm start                         # multiplayer server on http://localhost:8000
npm run solo                      # solo static server
```

Open `http://localhost:8000/` for the launcher or
`http://localhost:8000/lobby.html` for multiplayer. Set `PORT` to use another
port, for example `PORT=3000 npm start`.

The Babylon client loads Babylon.js from a CDN. Use the WebGL client for an
offline run.

## Build and test

```bash
npm run build                     # rebuild both bonk/client/dist/*.html
node bonk/tests.js                # simulation invariants and bot statistics
npm test                          # simulation + multiplayer pipeline suites
npm run test:e2e                  # live WebSocket end-to-end tests
node bonk/client/test_clients.js  # browser tests (requires Playwright/Chromium)
```

`npm test` is offline apart from the installed `ws` dependency. The browser
suite validates WebGL in Chromium and Babylon against the mock Babylon API; it
does not prove that the real Babylon CDN build renders correctly.

## Simulation contract

```js
const Sim = require('./bonk/sim.js');
const state = Sim.create(seed);
state.addPlayer({ name, bot, kind, skill });
state.begin();
state.step(dt, { mx, mz, jump, dive, fire });
```

The simulation uses `+Z` as course-forward and exposes read-only state for
renderers: players, bullets, moving solids, pickups, checkpoints, events,
`finishZ`, and `length`. `S.step` clamps large frame times and sub-steps at
1/60 or smaller. One-shot actions are consumed on the first sub-step.

The course is approximately 193 units long with spinner bars, moving
platforms, crumbling tiles, pistons, a bounce-pad gap, a spinning disc, a final
spinner, seven checkpoints, and six ammo pickups. Combat is knockback-only;
falling respawns the player at the last checkpoint.

## Multiplayer latency

The shipped multiplayer client is the root `sim-race-webgl.html`. Its clock is
aligned to snapshot arrival, so it already includes downlink transit. Remote
interpolation adds a 150 ms safety buffer plus half the measured arrival-gap
jitter, capped at 400 ms; it does not add RTT/2 again. RTT remains available
for diagnostics and legacy reconciliation.

The deterministic slow-line test (167 ms base one-way delay, up to 67 ms
additional jitter, 5% snapshot loss) settles near 180 ms of extra buffering,
down from 380 ms, with no moving-player starvation freezes. This improves
rendering latency, not network ping. Real-device multiplayer playtesting is
still needed.

The shared `bonk/client/game.js` and its generated `dist` files currently
contain an older multiplayer implementation. Rebuilding them does not update
the specialized root multiplayer client; do not overwrite that client with
the generated WebGL file.

## Verification status

The current automated baseline passes:

- simulation invariants, determinism, obstacle cycles, movement/combat events,
  and bot-pack statistics;
- client netcode against the authoritative simulation;
- release-before-edge regression coverage;
- real-server WebSocket end-to-end flow;
- lossy-line scenarios covering latency, jitter, packet loss, starvation,
  outage recovery, interpolation delay, and countdown pacing.

The remaining verification gap is visual: real Babylon.js rendering and
low-end/mobile performance need a browser/device pass.

## License

MIT

