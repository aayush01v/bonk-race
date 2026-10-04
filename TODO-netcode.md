# Multiplayer Netcode — To-Do List

Goal: eliminate choppiness on slow connections (high latency / jitter / loss).
Context: server ticks 30 Hz but broadcasts state at 15 Hz (`mp-server.js`);
client renders everyone except you from interpolated snapshots with a fixed
100 ms delay (`INTERP_DELAY` in `sim-race-webgl.html`). Fixed delay + 15 Hz
stream + no starvation extrapolation = freeze-jump at any realistic internet
latency. Bandwidth is **not** the issue (~15–30 KB/s down); latency/jitter/loss is.

## Status (2026-10-04)

Phases 1–3 implemented and covered by automated tests. All suites pass:
`test_mp_client_sim.js`, `test_mp_e2e.js`, `test_mp_latency.js` (4 line
scenarios), `test_mp_init.js`, `npm test` (physics). Remaining: manual
playtest matrix (4.2) and the optional revert flag (4.3).

## Phase 1: Client smoothing fixes (highest impact, low risk, client-only)

- [x] **1.1 — Adaptive interpolation delay** (`sim-race-webgl.html`)
  - `interpDelay` eases toward `clamp(0.15 + rtt/2 + jitter×0.5, 0.1, 0.4)`
    (τ ≈ 1 s, no delay pops); target refreshed on each state arrival from the
    RTT probe + p95−mean of the arrival-gap window
- [x] **1.2 — Extrapolate when starved** (`lerpPair()` / `applyNet()`)
  - render time ≥ newest sample → advance newest sample at vx/vy/vz (+ yaw
    rate), capped at `EXTRAP_MAX = 0.2`; sample discontinuity guard (> 8 u)
    unchanged; crumble `cy` extrapolates at its recent fall rate
- [x] **1.3 — Time-based buffer cap**
  - `BUF_AGE = 1.0 s` replaces the 10-packet cap; extra buffer becomes
    headroom for the adaptive delay
- [x] **1.4 — Self-player correction tuning**
  - extrapolation weight decays `exp(−age/0.3)` (no 0.2 s cap); hard-snap
    threshold raised to 8 u² = 64 (instant snap kept for phase change / death
    via `needHardSnapMe`); velocity eased toward the server's too (τ ≈ 167 ms)
    so position correction isn't undone by a stale local velocity
- [x] **1.5 — Soften local clock snap**
  - `srvOffset` smoothed per-arrival; `sim.t` eases toward server time
    (τ ≈ 100 ms, only when |err| > 50 ms) instead of hard-snapping; substep
    cap raised 5 → 10

## Phase 2: Server-side pacing & bandwidth (`mp-server.js`)

- [x] **2.1 — Deadline-based tick**
  - `nextTickAt` wall-clock deadline; runs every due tick (≤ 3 catch-up
    sub-steps, then resync); consecutive state packets are exactly 1/30 s
    apart in sim time — verified by `test_mp_e2e.js` (100% tick-aligned under
    a live race)
- [x] **2.2 — 30 Hz state broadcast**
  - `STATE_EVERY = 1`; e2e confirms ~366 B/state at 4 players (~11 KB/s)
- [x] **2.3 — Tag events with sample time**
  - every relayed event carries `st = sim.t`; verified in e2e (all packets
    stamped)

## Phase 3: Event/state time alignment (client)

- [x] **3.1 — Delay remote effects to render time**
  - relayed fire/jump/dive queued in `evQueue` keyed on `ev.st`;
    `flushNetEvents()` releases them when render time reaches `st`, drops
    anything > 250 ms stale
- [x] **3.2 — Verify countdown sync**
  - asserted in `test_mp_latency.js` S1: p95 cd step 40 ms (≈1 tick) on the
    throttled line — the 3-2-1 display advances in tick-sized steps

## Phase 4: Verification

- [x] **4.1 — Latency/loss test** (`test_mp_latency.js`, multi-scenario)
  - S1 slow line: 167 ms one-way, ±2 tick jitter, 5% drop → delay grows to
    0.38 s, p99 frame jump 0.40 u, 0 starvation freezes, own p95 0.21 u
  - S2 low-latency baseline: delay shrinks to 0.22 s on a good line
  - S3 extreme line: 400 ms one-way, ±4 tick jitter, 10% drop → delay
    saturates at the 0.4 s cap, p99 jump 0.39 u, own p95 0.21 u
  - S4 one-second delivery outage → remote freezes at the EXTRAP cap (no
    runaway), resume catch-up eased over ~150 ms (max 9.2 u step, was a
    28 u teleport before the catch-up ease), own prediction stays under the
    8 u snap guard, correction converges to 0.08 u p95 after recovery
- [ ] **4.2 — Manual playtest matrix**
  - Chrome DevTools throttling: "Slow 3G" and "Fast 3G" + real remote
    connection (Codespaces port)
  - Watch `?net=1` overlay: rtt, gap p95, snaps, corr, delay (tgt) — confirm
    `snaps` stays near 0 under load and `delay` tracks the line
- [ ] **4.3 — Revert guard** *(optional — only if a regression shows up)*
  - keep adaptive-delay / buffer behavior behind one flag if anything
    regresses in playtest

## Notable design decisions from testing

- **Catch-up ease** (`applyNet`, client): when the time-based buffer trims
  the whole pre-outage history, the new sample pair looks continuous even
  though the displayed position (held at the EXTRAP cap) is far behind —
  the sample discontinuity guard can't see it. The target is therefore
  eased over ~150 ms (τ ≈ 83 ms, first step ≈ 1/3 of the gap) instead of
  teleporting. Verified by S4: 28 u one-frame pop → 9.2 u max step.
- **Freezes vs fall**: a falling corpse moves up to ~15 u/s (0.7 u/frame) —
  the smoothness metric skips `dead` remotes; what matters is no freeze
  *while alive and moving*.
- **Own-player during total loss**: the local sim is the only authority;
  stale crumble state can cause a local-only fall/respawn (~7 u divergence,
  under the 8 u snap guard) that the decaying-weight correction absorbs in
  < 1 s once samples flow again. Bounded and acceptable for a 1 s outage.

## Suggested order & checkpoints (historical)

1. Phase 1.1 + 1.2 + 1.3 → playtest on a throttled connection
2. Phase 1.4 + 1.5 → playtest rubber-banding and scene-jump cases
3. Phase 2 → playtest bot motion smoothness and race-start sync
4. Phase 3 + 4 → polish effects alignment, lock in with tests
