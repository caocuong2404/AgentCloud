# POC gate tests and evidence ledger

Status: NOT EXECUTED on user's Mac/Cloudflare account.

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

- Date/time and Orca Desktop version:
- Orca Linux AppImage version / SHA256:
- Orca mobile version and OS:
- Mac OS / Docker version:
- Container instance size / image size:
- Cloudflare region inferred from observed telemetry (if available):
- `docker build` duration:
- Local cold start to `/health`:
- Cloudflare cold start to `/api/status` ready:
- WSS pairing result and error logs:
- Reconnect time (LAN / cellular):
- No-traffic 20min test result:
- Agent CLI, authentication approach, real work, Git diff / test report:
- Manual stop & alarm test:
- Real Containers usage (GiB-hrs, vCPU-min, GB-hrs):
- Worker/DO request charges, egress/logs, model tokens:
- Marginal spend compared to baseline:
- Decision: GO / FIX / STOP:

## Notes

- **No claim of safe work preservation**: POC Container deletion loses unpushed changes.
- Orca prints pairing credentials; store and view `/api/pairing` privately, do not paste into issue trackers.
- Runtime lifecycle may be interrupted by platform maintenance even before the user lease ends.
- The fixed expiry is a safety net, not a graceful agent checkpoint. During its last few minutes, export/commit work before stop.
