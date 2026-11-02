# Bonk Race internals

The canonical project documentation is the repository-root
[`README.md`](../README.md). It contains the current architecture audit,
runtime topology, build commands, test commands, simulation contract, and
known risks.

This directory contains the shared simulation and client build sources:

- `sim.js` — deterministic movement, collision, hazards, combat, bots, and
  events.
- `inputbuf.js` — stamped multiplayer input buffering.
- `tests.js` — simulation invariants and bot statistics.
- `client/` — shared UI/runtime sources, WebGL1 and Babylon renderers, build
  script, generated clients, and browser tests.
- `reference/` — the original reference project kept for comparison.
