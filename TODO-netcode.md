# Multiplayer Netcode — To-Do List

Goal: eliminate choppiness on slow connections (high latency / jitter / loss).
Context: server ticks 30 Hz but broadcasts state at 15 Hz (`mp-server.js`);
client renders everyone except you from interpolated snapshots with a fixed
100 ms delay (`INTERP_DELAY` in `sim-race-webgl.html`). Fixed delay + 15 Hz
stream + no starvation extrapolation = freeze-jump at any realistic internet
latency. Bandwidth is **not** the issue (~15–30 KB/s down); latency/jitter/loss is.

## Status (2026-10-05)

Phases 1–3 implemented and covered by automated tests. All suites pass:
`test_mp_client_sim.js`, `test_mp_release.js`, `test_mp_e2e.js`,
`test_mp_latency.js` (4 line scenarios), `test_mp_init.js`, `npm test`
(physics).

**Playtest round 1** surfaced "sticky" jumps + slight drag while moving in MP
mid-race (solo unaffected) even though all aggregate metrics were green. Root
cause: the own-player correction pulled the airborne player toward server
samples that predated the latest input, extrapolated the ballistic arc with a
straight line, and eased `vy` toward stale samples. Fixed with the
four-layer own-player correction (input-confirmation gate, airborne arc
ownership ×0.2 + `vy` protection, ballistic target `y + vy·t − ½gt²`,
grounded-only velocity ease) and a new solo-arc regression test in
`test_mp_client_sim.js` (3-tick delivery so sample age is realistic; solo
reference sim; arc Δy < 0.2 u, takeoff Δvy < 2 u/s, landing ±2 ticks — with
the fix: 0.07 u / 0.45 u/s; reverted: 0.56 u / 4.6 u/s). See README §10.

**Playtest round 2** (2026-10-05):

- **RTT probe**: surfaced "actions don't render quickly, they render after a delay" in normal MP play on a real internet line. Root cause: the 1 Hz RTT probe was gated on the `?net=1` debug overlay, so in normal play `netStats.rtt` stayed -1 forever — the adaptive-delay target saw zero one-way latency (stayed line-independent at ~0.17 s) and the input-confirmation uplink gate clamped to the 33 ms floor, opening before the server had received the latest input on any line slower than ~LAN. The relay chain (iframe → lobby → server pong) was already fully wired; the probe simply never fired. Fixed by moving the probe out of the `netOn` gate (`update()` in `sim-race-webgl.html`): `?net=1` still only controls the overlay. Verified with a headless pipe repro driving the shipped `sendMPInput` + 1 Hz probe against a 30 Hz server sim (slow line, 167 ms one-way): probe ON measures RTT ~0.4 s, grows the interpolation delay to 0.37 s (vs 0.18 s line-independent), and cuts stop-coast drift from 3.2 u to 2.4 u in the first 300 ms; jump response stays at solo parity (the airborne layers already cover it). Residual stop-coast is the documented compromise of the confirmation-window design, not the probe.

- **Edge slide / release lag**: surfaced the "release with room to spare, then the character slides forward over the edge and falls" bug (analysis.txt). The own-player x/z correction chased the server sample, which reflects inputs a full round trip old, so on-screen trailed the pure local prediction by ~v·rtt (the correction read as "bounded" because it measured the error *to the stale target*, not to the prediction). Fixed by splitting the own-player correction into vertical (unchanged: sample-age gate, ballistic target, gravity-owns-`vy`) and horizontal (x/z): the x/z target is extrapolated ahead of the sample by a damped fraction of the RTT (`LOOKAHEAD = 0.3`, capped at `LOOKAHEAD_MAX = 0.12 s` so high-latency lines don't lead by several units), and the x/z correction is held off for a full `rtt + 1 tick` after any real input change. Verified against a solo-sim reference, not just `corr`: new hard assertion in `test_mp_client_sim.js` (on-screen vs solo, last-third mean < 0.75 u — fix: 0.61 u; pre-fix: 0.84 u) and a new `test_mp_release.js` (run toward a platform edge, release with a margin sized to beat uplink+coast; asserts on-screen tracks the solo prediction and the authoritative body makes the landing). The look-ahead is deliberately damped to 0.3 (not the full RTT from the analysis): a full-RTT lead shifts the local sim's own trajectory enough to change bonk/arc timing on obstacle courses and breaks the solo-arc guard.

**Frontend audit round** (2026-10-05): a full pass over the client + lobby MP
logic (client netcode block, relay chain, room messaging) found four gaps, all
fixed and covered by new assertions in `test_mp_client_sim.js` / reviewed in the
lobby:

- **Smoothed RTT estimate** (`updateRtt()` in `sim-race-webgl.html`): the
  `mp_pong` handler assigned the raw single-ping RTT. One GC pause or tab switch
  showed up as a 3–5 s sample that clamped the input-confirmation gates to their
  1.2 s worst case and pushed the adaptive-delay target to its 0.4 s cap for a
  full second (pings are 1 Hz, so recovery was ≥1 s) — the same "actions render
  after a delay" symptom on spiky lines. Samples are now clamped to 1200 ms
  (the gates' own worst case, so a truly slow line behaves as before), non-
  positive samples dropped, and fed through an EMA (α = 0.4). New assertions:
  a 4 s spike leaves gate rtt at 0.66 s (vs 1.20 s raw), recovery to 328 ms in
  5 clean pings, and sustained degradation still tracks up (762 ms after 5× 800
  ms pings).
- **`evQueue` time ordering** (`flushNetEvents()`): the stale-drop/release loops
  only look at the queue head, but an event can arrive late with an older `st`
  (or the st-less fallback stamped at the later arrival time) and sit in front
  of a due event — the VFX would play late. The queue is now sorted by `at`
  before processing. New assertion: out-of-order arrival releases in time order.
- **`resetNet()` clears RTT state** (`rttEst`, `netStats.rtt`, `lastPing`): a
  rematch no longer inherits the previous race's RTT estimate, and the probe
  re-fires promptly after a fresh race.
- **Lobby flow fixes** (`lobby.html` + `sim-race-webgl.html`): `kicked` now
  hides the still-running game iframe (the `raceEnd` path did, `kicked` didn't
  — a kicked player saw the live race under the menu). And the game re-sends
  `mp_ready` after a successful rematch re-init, so the lobby's 500 ms init
  retry loop stops instead of re-initing the running race forever.

Remaining: manual playtest matrix (4.2) and the optional revert flag (4.3).

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

## Phase 5: Own-player horizontal correction (release/edge fix)

- [x] **5.1 — Split the "me" correction into vertical + horizontal**
  - `applyNet()` "me" block in `sim-race-webgl.html`. Vertical (y) is
    unchanged (sample-age gate, ballistic target, gravity-owns-`vy`).
    Horizontal (x/z/yaw) now: target extrapolated ahead of the sample by
    `lookAhead = min(rtt·LOOKAHEAD, LOOKAHEAD_MAX)` (`LOOKAHEAD = 0.3`,
    `LOOKAHEAD_MAX = 0.12 s`); correction gated off for `rtt + 1 tick` after
    any real input change (`wInpXZ`), vs the vertical's `uplink` gate.
- [x] **5.2 — Verify against the solo-sim reference, not just `corr`**
  - `test_mp_client_sim.js`: hard assertion that on-screen tracks the pure
    local (solo) prediction — last-third mean |Δz| < 0.75 u (fix: 0.61 u,
    pre-fix 0.84 u). The old `corr` metric stayed green pre-fix because it
    measured the error to the *stale target* the correction was chasing.
  - `test_mp_release.js` (new): a clean course (start+alley only), run toward
    a platform edge, perception-based release with a margin that clears
    uplink+coast. Asserts on-screen tracks solo through the approach and the
    authoritative server makes the landing.
- [x] **5.3 — Keep the look-ahead damped + capped**
  - A full-RTT look-ahead (the analysis's literal suggestion) shifts the local
    sim's own trajectory enough to change bonk/arc timing on the spinner bars
    (z≈34) and breaks the solo-arc guard; it also leads the authoritative
    sample by several units on high-latency lines (S3). Damping to 0.3·rtt
    (cap 0.12 s) keeps the arc, keeps on-screen within a fraction of an RTT of
    the server sample, and still recovers the release margin.

## Phase 7: Acked inputs + aligned reconciliation (release/edge fix, round 2)

Phase 5 still dropped players off edges on slow lines. Root causes, found by replaying the real
client code against a 30 Hz server over a simulated link (`test_mp_pipeline.js`):

- **`rtt/2` alignment.** `reconcileOwn` compared a sample with the local history at `base - rtt/2`.
  `srvOffset` is learned from *arrival* times, so `base` already contains the downlink; the inputs a
  sample reflects were sent a full round trip before it arrived. `rtt/2` leaves a phantom error of
  about `v * rtt/2`, which the correction drags the player toward (stop, then lurch forward).
- **`input.t = sim.t`.** `sim.t` is slewed toward the server clock in `applyNet`, so differences
  between stamps do not equal elapsed time; the server then replays inputs with distorted durations.
- **The server's first timestamped queue** had a playhead that locked to the first packet, applied
  inputs in arrival order (head-of-line blocking on a stamp jump), never caught up after a burst, and
  had no queue cap or validation. It also added lag the client could not observe, so any
  RTT-based alignment was wrong by that backlog.

Protocol now:

1. Inputs are stamped with the client's monotonic clock (`performance.now()/1000`), once per frame.
2. `bonk/inputbuf.js` (`InputBuffer`, one per client in `mp-server.js`) maps stamps to server time
   with a relaxing-minimum offset filter and plays each input out at `stamp + offset + buf`, where
   `buf` (40–300 ms) adapts to the observed jitter. Durations are reproduced; the queue is sorted,
   capped (120) and validated; un-stamped (legacy) clients still use last-input-wins.
3. Each snapshot row for a human carries `ack` (ms, index 19): the client-stamp time up to which that
   client's inputs are included in the row (0 = none: bots / legacy).
4. The client labels its predicted history by the same stamps and compares each own-player sample
   with the prediction **at `ack`**. Only the part of the position error beyond `OWN_DZ` (0.35 u) and
   of the velocity error beyond `OWN_DV` (2.5 u/s) is eased in; the same offset is added to the
   history so it is not counted twice. y is only reconciled while grounded. Hard snaps (death/respawn,
   phase change, |err| > 8 u) are unchanged. Without an ack (old server) the loop delay is estimated
   as a full RTT (never `rtt/2`).

Verification: `node test_mp_pipeline.js` (edge release, no post-stop lurch, real divergence still
absorbed, jump arcs local, steering on the solo prediction; RTT 200 ms–2 s, ±150 ms jitter,
asymmetric links), `node test_mp_ack_e2e.js` (real server over WebSockets; needs `ws`), plus the
older suites, whose own-player references were moved off "the server position at now" (that
reference rewards sitting on a stale sample, i.e. the bug).

Known limits: jitter beyond the 300 ms playout cap (e.g. ±200 ms each way at 600 ms RTT) can still
produce some server-side falls; the local sim predicts remote-caused bonks from stale samples, so on
very slow lines the screen is off until the server's authoritative result lands; after "go" the
server's body leads the client's by the one-way phase delay and the screen aligns to it once.

## Phase 6: Frontend robustness (audit round, 2026-10-05)

- [x] **6.1 — Smoothed RTT estimate** (`updateRtt()`, pong handler)
  - raw single-ping RTT → clamped (≤ 1200 ms = the gates' own worst case) EMA
    (α = 0.4); non-positive samples dropped. A 4 s tab-switch/GC spike now
    leaves gate rtt at 0.66 s instead of pinning the 1.2 s worst case for a
    full second; recovers to 328 ms in 5 clean pings; sustained degradation
    still tracks up (762 ms after 5× 800 ms).
- [x] **6.2 — `evQueue` sorted before flush** — stale-drop/release loops only
  see the head; a late-arriving older event used to block a due one.
- [x] **6.3 — `resetNet()` clears RTT state** (`rttEst`, `netStats.rtt`,
  `lastPing`) so rematches start cold and the probe re-fires promptly.
- [x] **6.4 — Lobby flow fixes** — `kicked` hides the game iframe; the game
  re-acks `mp_ready` after a rematch re-init so the lobby's 500 ms init retry
  loop stops.
- [x] **6.5 — Regression tests** in `test_mp_client_sim.js` (5 new assertions).

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
