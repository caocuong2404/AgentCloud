# POC gate tests and evidence ledger

Status: G3 partially executed 2026-10-16 (CF deploy + start/ready/pairing/stop). G0-G2, G4-G7 NOT EXECUTED.

| Gate | Action | Pass criteria | Abort criterion |
| --- | --- | --- | --- |
| G0 Docker | `docker build`, `docker run`, `curl localhost:8080/health` | Orca reports ready, no segfault/OOM, pairing details produced | Cannot boot after 2 hours of investigation |
| G1 LAN Orca | Pair Orca desktop and mobile to local Docker; disconnect/reconnect twice | Terminal, files, basic steering work | Mobile auth fails reproducibly |
| G2 Public WSS | Quick Tunnel → local Docker, mobile on cellular | Mobile authenticates over WSS; disconnect/reconnect twice | 2 hours elapsed without successful pairing |
| G3 Cloudflare WS | Deploy Worker + `standard-1` Container and start once | `/api/status` ready, `/api/pairing` returns data, mobile E2E | Cold start >180sec three consecutive attempts, or auth broken |
| G4 Work | Run Codex or OpenCode in a workspace with actual task and tests | Git diff + tests recorded and exported | CLI cannot start or workspace too small |
| G5 Liveness | Start an agent task; disconnect all clients for ≥20 min | Task completes or continues, no forced shutdown before lease | Unexpected stop under no traffic |
| G6 Mac off | Power down Mac after session starts; connect phone on cellular | Phone can reconnect and steer agent | Phone requires desktop alive |
| G7 Cost + kill | Inspect Workers Paid usage + manual stop + expiry | Stop takes effect, spend guard records reservations, model cost separated | Unexpected spend or 60min hard cutoff ineffective |

## Metrics ledger (fill with measured results, not assumptions)

- Date/time and Orca Desktop version: 2026-10-16T15:47Z; version not queried
- Orca Linux AppImage version / SHA256: latest at image build (2026-10-16 GH Actions)
- Orca mobile version and OS: not tested
- Mac OS / Docker version: macOS arm64 / OrbStack Docker 29.8.2 (promote only, image not run locally)
- Container instance size / image size: standard-1; image digest sha256:83efdb6b… (single-platform amd64)
- Cloudflare region inferred from observed telemetry (if available): HKG colo for container logs; DO request colo NRT
- `docker build` duration: not measured (GitHub Actions `ubuntu-latest`, run 38926143756, ~31s job)
- Local cold start to `/health`: not tested (G0)
- Cloudflare cold start to `/api/status` ready: <5s after `POST /api/start` (202 → ready on first poll)
- WSS pairing result and error logs: runtime + mobile pairing URLs minted; `orca_server_ready` emitted. Benign noise only: dbus socket missing (no system bus in VM), Chromium keyring unencrypted fallback, agent-state-rules HTTP 404
- Reconnect time (LAN / cellular): not tested (G6)
- No-traffic 20min test result: not tested (G5)
- Agent CLI, authentication approach, real work, Git diff / test report: not tested (G4)
- Manual stop & alarm test: manual stop PASS (`{"state":"stopped","destroyed":true}`, lease cleared); alarm path not tested (G7)
- Real Containers usage (GiB-hrs, vCPU-min, GB-hrs): not measured
- Worker/DO request charges, egress/logs, model tokens: not measured
- Marginal spend compared to baseline: not measured; DO budget counter reserved 0.666 USD across 9 starts (8 pre-fix failures still reserve per design)
- Decision: GO / FIX / STOP: FIX (completed) → GO for remaining gates. Blocking bug found and fixed: `pairing.mjs` extracted in 0681481 was never COPY'd into the image (`ERR_MODULE_NOT_FOUND`, exit 1). Packaging regression tests added.

## Notes

- **No claim of safe work preservation**: POC Container deletion loses unpushed changes.
- Orca prints pairing credentials; store and view `/api/pairing` privately, do not paste into issue trackers.
- Runtime lifecycle may be interrupted by platform maintenance even before the user lease ends.
- The fixed expiry is a safety net, not a graceful agent checkpoint. During its last few minutes, export/commit work before stop.
