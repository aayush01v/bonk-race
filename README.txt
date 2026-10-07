Drop-in files for bonk-race (same paths as in the repo). Or: patch -p1 < ../bonk-race-fix.patch from the repo root.
Restart the running `node mp-server.js` afterwards (the server and the client must both be the new version).
Verify: node test_mp_pipeline.js   (no dependencies)
        npm test                   (all offline suites)
        npm run test:e2e           (needs `npm install` for ws)
Details: FIX-BRIEF-round2.md and the new "Phase 7" section in TODO-netcode.md.
