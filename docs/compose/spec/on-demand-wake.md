---
feature: on-demand-wake
status: in-progress
updated: 2026-10-15
branch: on-demand-wake
commits:
---

# On-Demand Wake + Stable Orca Identity

## Report

**What was built** — Two coordinated pieces. (S2.1) A per-workspace identity bundle (`orca-devices.json`, `orca-e2ee-keypair.json`, `agent-session-authority.key`) is packed by `container/identity.mjs`, harvested by the Worker into DO storage via `GET /__identity`, and restored through `ORCA_IDENTITY_B64` before `orca serve` starts, so paired clients survive `container.destroy()`/`start()`. Empty envelopes never clobber stored identity; failed harvests are retried. (S2.2) An Orca `environmentRecipes` entry `cf-poc` (`orca.yaml` + `scripts/orca-vm/cf-poc-*`) wakes the container on workspace open (`POST /api/start`, poll ready, re-emit runtime `pairingCode`) and stops it on suspend/destroy — no auto-start from the public WSS path.

**Verification** — `npm run check` PASS (10/10). `orca vm recipe doctor cf-poc --repo-path . --json` PASS (6/6, ok:true). Local Docker (`orca-agent-poc:identity`): boot A tokens `fdd516c9…`/`885341a1…` identical after destroy/start with `ORCA_IDENTITY_B64` (label: local Docker). Review (1 critical-round + 1 re-review): three criticals found and fixed (empty-envelope clobber, harvest marker on failure, recipe poll abort-on-blip / masked start errors); re-review PASS on all three. T6 (deployed E2E: live `cf-1` reconnect without 4001, recipe accepted by Orca) is **not** run — needs explicit deploy approval.

**Journey log** —
1. `cf-1` saved hosts are connection-only (Devin wiki + Orca skill): no wake hook exists; recipes are the only supported on-demand path.
2. Root cause of live 4001: new Orca identity every boot (`crypto.randomBytes`/`randomUUID` in supervisor) + `destroy()` wipes the container FS; `cf-1` kept a stale `pairedDeviceId`.
3. Identity lives in DO storage only — never a baked image/snapshot (AGENTS.md).
4. Reviewer catch: `saveIdentity()` accepting `{}` would have reintroduced 4001 by wiping a good bundle on early stop.
5. `set -euo pipefail` + `var=$(curl|sed)` makes poll loops single-shot; wrap per-iteration fetches.

## [S1] Problem

1. **4001 Unauthorized on reconnect.** Every container boot mints a new Orca identity (`orca-devices.json` device tokens, `orca-e2ee-keypair.json`, `agent-session-authority.key`). `stop` runs `container.destroy()`, so nothing survives. `cf-1` (paired to `pairedDeviceId 0dee1726-…`) reconnects with a stale token against a new runtime (`fb654fcb-…`) and orcad closes the WebSocket with 4001.
2. **No on-demand wake.** `cf-1` is connection-only; opening a project cannot start a stopped container. Manual `./scripts/poc.sh start` is the only wake path. Waking from the public `/connect/<token>` route is forbidden by AGENTS.md.

## [S2] Design

Two coordinated pieces. Decisions (user-confirmed): persist identity in Durable Object storage; wake via Orca `environmentRecipes` `resume`; do both.

### [S2.1] Identity bundle (fixes 4001)

A **per-workspace identity bundle** restores Orca runtime identity across `container.destroy()` / `start()`. Never baked into an image (AGENTS.md).

Files (under `ORCA_USER_DATA_PATH`), taken from the `orca-per-workspace-env` skill's identity list:

| File | Why |
|---|---|
| `orca-devices.json` | device-token registry; keeps paired clients (cf-1) valid |
| `orca-e2ee-keypair.json` | E2EE keypair; `publicKeyB64` in pairing URLs must stay stable |
| `agent-session-authority.key` | session authority; avoids re-bootstrap on resume |

**Envelope** (opaque to the Worker): JSON object `{ "<filename>": "<base64 of raw bytes>", … }`. Omitted files are absent. Supervisor serializes/parses; Worker stores the envelope as a single DO-storage key `identityBundle` and passes it unchanged as env `ORCA_IDENTITY_B64` (base64 of the envelope JSON).

**Lifecycle:**

1. `container.start()` — if storage has `identityBundle`, set `ORCA_IDENTITY_B64`. Supervisor writes the files into `ORCA_USER_DATA_PATH` **before** spawning `orca serve`, then proceeds with the existing pending-device seeding (existing paired devices are preserved; `pending()` only matches `lastSeenAt === 0`).
2. First ready — Worker `GET :8080/__identity` (private health port, same as `__pairing`), stores the envelope. `status()` saves once per boot (`identitySavedAt` in storage keyed by `startedAt`); `stop()` and `alarm()` also save before `destroy()` so a crash between ready and stop loses at most one session of device updates.
3. No identity in storage (first boot) — supervisor generates identity as today; Worker harvests it at ready.

`/__identity` must never log file contents. Supervisor redaction rules unchanged.

### [S2.2] Recipe wake (click → start)

`environmentRecipes` entry `cf-poc` in `orca.yaml`, scripts under `scripts/orca-vm/`. Lifecycle contract (Orca skill §7–8):

| Script | Behavior | stdout |
|---|---|---|
| `cf-poc-create.sh` | same as resume (single shared container; see S3) | recipe JSON |
| `cf-poc-resume.sh` | `POST /api/start` (Bearer `CONTROL_TOKEN`), poll `GET /api/status` until `ready` (≤120s), `GET /api/pairing`, take the **runtime** `orca://pair?code=…` URL | `{schemaVersion:1, pairingCode, projectRoot:"/workspace", userData:{resourceId:"poc-single-workspace"}}` |
| `cf-poc-suspend.sh` | `POST /api/stop` | none |
| `cf-poc-destroy.sh` | `POST /api/stop` (idempotent) | none |

- All progress/errors → **stderr**; exactly one JSON object on stdout (skill rule).
- Inputs: `POC_WORKER_URL` and `CONTROL_TOKEN` from env, falling back to repo-root `.secrets.local` (`source` it). Never print tokens; never commit them.
- `resume` re-emits a fresh `pairingCode` every time (Orca requires this). With [S2.1] the **already-paired** `cf-1` token also keeps working, so resume is a safety net, not the only path.
- `userData.resourceId` = `poc-single-workspace` (the DO name) so resume stdin payloads round-trip.

Wake is **not** triggered from `/connect/<token>` (AGENTS.md: no auto-start on the public path).

### [S2.3] Control-plane surface (unchanged externally)

`POST /api/start`, `GET /api/status`, `POST /api/stop`, `GET /api/pairing` keep their request/response shapes. The only Worker change is internal identity harvest/restore. Container health port gains `GET /__identity` (never proxied publicly; same rule as `__pairing`).

## [S3] Out of Scope

- Shared multi-workspace containers; one recipe maps to the single POC container.
- R2/Git checkpointing, Herdr adapters, Workflows/Queues (AGENTS.md phase gates).
- Wake-on-connect from `/connect/<token>`.
- Snapshot-based resume; this is DO-storage identity only.
- Mobile-scope recipe output (recipe emits the runtime URL; mobile pairing stays via `/api/pairing`).
- Live deploy / paid verification (needs explicit approval; tracked as T6).

## Tasks

- [x] T1: `container/identity.mjs` (pack/unpack envelope) + supervisor restore-from-`ORCA_IDENTITY_B64` before `orca serve`, `GET /__identity` on :8080 — acceptance: `node --test test/identity.test.mjs` covers pack/unpack round-trip and missing-file handling; supervisor `node --check` passes (covers: S2.1)
- [x] T2: Worker DO identity harvest/restore in `src/index.js` (`start` passes env, `status`/`stop`/`alarm` harvest, opaque `identityBundle` key) — acceptance: `npm test` passes; code review shows `start` → `ORCA_IDENTITY_B64` and harvest-before-destroy on both `stop` and `alarm` (covers: S2.1; depends: T1)
- [x] T3: `scripts/orca-vm/cf-poc-{create,resume,suspend,destroy}.sh` + `orca.yaml` recipe `cf-poc` — acceptance: `orca vm recipe doctor cf-poc --repo-path <worktree> --json` reports no `fail`/`warn` for wiring (covers: S2.2)
- [x] T4: Local Docker identity persistence — acceptance: build image, start with a dummy pairing address, capture `__identity`, kill container, start again with that `ORCA_IDENTITY_B64`, assert `orca-devices.json` device tokens identical (label: local Docker) (covers: S2.1; depends: T1)
- [x] T5: `npm test` + `npm run check` green — acceptance: both commands exit 0 (covers: S2.1, S2.2)
- [ ] T6: Live verify — acceptance: deploy (needs approval), stop/start container, `cf-1` reconnects **without** 4001 and without re-pairing; `cf-poc-resume.sh` returns recipe JSON and Orca accepts it (label: deployed E2E) (covers: S2.1, S2.2; depends: T2, T3, T5)
