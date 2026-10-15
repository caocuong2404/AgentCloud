---
feature: ghcr-image-pipeline
status: deployed
updated: 2026-10-15
branch: master
commits: 0681481, b89337b, 6c1446f
---

# GHCR Image Pipeline + Deploy Walkthrough

End-to-end run of building the Orca agent image on GitHub, mirroring it into
Cloudflare's managed registry, and deploying the Worker. Every step below was
actually executed on 2026-10-15; what was **not** verified is called out
explicitly at the end.

## Why this shape

Two constraints force the design:

1. **The Orca Linux AppImage is x86_64-only.** An arm64 Mac cannot run the
   container locally. OrbStack fails with
   `Dynamic loader not found: /lib64/ld-linux-x86-64.so.2`. GitHub's
   `ubuntu-latest` runners are amd64 and build natively.
2. **`durable_object` containers cannot pull from GHCR directly.**
   Cloudflare's image-management docs are explicit: "The `durable_object`
   scheduling policy does not support direct image references from external
   registries. A named `image` source must use a digest-pinned reference from
   the Cloudflare managed registry."

So GHCR is the source of truth, and a promote step mirrors the digest into
Cloudflare's registry:

```
GitHub Actions (linux/amd64)
        │  build container/Dockerfile
        ▼
ghcr.io/caocuong2404/agentcloud   ← source of truth, public
        │  scripts/promote-image.sh
        │    docker pull --platform linux/amd64
        │    docker tag
        │    wrangler containers push
        ▼
registry.cloudflare.com/<account>/orca-agent-poc-agentcloud@sha256:…
        │  wrangler.jsonc pins this digest
        ▼
wrangler deploy  →  Worker + Durable Object container
```

## Step 1 — Unit tests first (95 scenarios)

Before touching the image path, the pure modules were covered
(`npm run check` → `node --check` + `node --test`).

| Suite | Scenarios | Module |
| --- | --- | --- |
| `test/budget.test.mjs` | 25 | `src/budget.mjs` — rate table, micro-dollar ceil, lease bounds, UTC month key, float epsilon |
| `test/identity.test.mjs` | 20 | `container/identity.mjs` — envelope pack/unpack, binary bytes, unknown-key isolation |
| `test/pairing.test.mjs` | 25 | `container/pairing.mjs` — base64url codec, v:2 pin, unicode/long tokens |
| `test/image-ref.test.mjs` | 25 | `container/image-ref.mjs` — GHCR/CF ref builders, digest validation |

**Result: 95/95 pass.**

### Bugs the scenarios caught

Writing the tests exposed real defects, not just coverage gaps:

| Bug | Impact | Fix |
| --- | --- | --- |
| `budgetAllows` accepted negative `used` | `used=-100, reservation=50, budget=4` returned `true` — the $4 cap was bypassable | require `used >= 0 && reservation >= 0` |
| `SIZES` nested objects not frozen | rate table was mutable at runtime | deep-freeze each size entry |
| `decodePairingUrl` accepted JSON arrays | `[]`/`[1,2]` returned as a valid pairing payload | reject non-plain-objects |
| `decodeIdentityEnv` accepted JSON arrays | an array envelope could reach `unpackIdentity` | same |
| `image-ref` coerced non-strings | `String(null)==='null'` passed name validation | reject non-strings before coercion |

## Step 2 — CI builds and pushes to GHCR

`.github/workflows/container-image.yml` runs on push to `master` or
`on-demand-wake` when `container/**` changes.

Key settings:

```yaml
platforms: linux/amd64
provenance: false   # see "Bugs" below — CF registry rejects attestation blobs
sbom: false
```

Published refs (metadata-action):

- `ghcr.io/caocuong2404/agentcloud:<branch>`
- `ghcr.io/caocuong2404/agentcloud:sha-<long>`

**Verified:** both branches built green in `1m50s`. Package
[`agentcloud`](https://github.com/caocuong2404/AgentCloud/pkgs/container/agentcloud)
is **public**. `docker manifest inspect` from the Mac confirms a
`linux/amd64` manifest.

## Step 3 — Promote GHCR → Cloudflare managed registry

```bash
CF_ACCOUNT_ID=<account-id> GITHUB_REPOSITORY=caocuong2404/AgentCloud \
  ./scripts/promote-image.sh master --update-wrangler
```

What it does:

1. `docker pull --platform linux/amd64 ghcr.io/caocuong2404/agentcloud:master`
   — the `--platform` flag is required on arm64 hosts.
2. `docker tag` to the staging name `orca-agent-poc-agentcloud:master`
   (see `localStagingTag` in `container/image-ref.mjs`).
3. `npx wrangler containers push <staging>` →
   `registry.cloudflare.com/<account>/orca-agent-poc-agentcloud:master`
4. Resolves the sha256 from `docker image inspect … RepoDigests`.
5. `--update-wrangler` rewrites `containers.images.base.image` in
   `wrangler.jsonc` to the digest-pinned form.

All ref construction goes through `container/image-ref.mjs` so the unit tests
are the source of truth for naming.

**Verified push output:**
```
cfpush: digest: sha256:a3b7b8ec2c664c443407362bb2abdf6e38d523cea57fc859d03c86fcad64f4b0 size: 856
Pushed image: registry.cloudflare.com/236e11ca7c49db525c48a5cd243dfb3d/orca-agent-poc-agentcloud:cfpush
```

`npx wrangler containers images list` confirms `orca-agent-poc-agentcloud`
is present.

## Step 4 — Pin the digest and deploy

`wrangler.jsonc` (the only form `durable_object` accepts):

```jsonc
"base": {
  "image": "registry.cloudflare.com/236e11ca7c49db525c48a5cd243dfb3d/orca-agent-poc-agentcloud@sha256:a3b7b8ec2c664c443407362bb2abdf6e38d523cea57fc859d03c86fcad64f4b0"
}
```

Then:

```bash
npx wrangler deploy
```

**Verified deploy output:**
```
├ Preparing base for Cloudflare Containers
│  registry.cloudflare.com/236e11ca…/orca-agent-poc-agentcloud@sha256:a3b7b8ec…
├ base is ready to run
Uploaded orca-agent-poc (94.67 sec)
Deployed orca-agent-poc triggers (2.36 sec)
  https://orca-agent-poc.vnai.workers.dev
Current Version ID: 2d19d5c9-a474-48b2-8d43-d5e20eee068d
```

## Step 5 — Live control-plane probe

Without `CONTROL_TOKEN`, every route must refuse:

```
401  /
401  /api/status
401  /api/start
401  /api/pairing
401  /api/stop
401  /connect/xyz
```

**Verified:** all six return `401 {"error":"unauthorized"}`. Secrets
`CONTROL_TOKEN` and `CONNECT_TOKEN` are configured
(`npx wrangler secret list`); values were not read or logged.

---

## Bugs found by actually running the pipeline

Static review would not have caught these. Each failed on first execution.

| # | Failure | Root cause | Fix |
| --- | --- | --- | --- |
| 1 | Workflow printed `Digest: ` (blank) | `steps.meta.outputs.digest` is empty outside bake flows | use `steps.build.outputs.digest` from `build-push-action`, assert non-empty |
| 2 | `./scripts/promote-image.sh: line 43: $2: unbound variable` | `build_ref` read `$2`/`$3` under `set -u` with one argument | default them (`${2:-}`) and take an optional repo override |
| 3 | `TypeError`/syntax in `node -e` | top-level `await` is illegal in `-e` (CJS) | `node --input-type=module -e` |
| 4 | `no matching manifest for linux/arm64/v8` | `docker pull` on arm64 Mac refuses an amd64-only image | `docker pull --platform linux/amd64` |
| 5 | `error from registry: blob unknown to registry` | `build-push-action` emits provenance/SBOM attestation manifests; CF's registry rejects those blobs | `provenance: false` + `sbom: false` in the workflow |
| 6 | CF refs used the wrong repository name | `wrangler containers push` publishes under the *local staging name* (`orca-agent-poc-<repo>`), not the GitHub repo name | pass `CF_IMAGE_NAME` as the repo override into `cloudflareTagRef`/`cloudflareDigestRef` |

## Reproduce from scratch

```bash
# 1. Tests
npm install
npm run check                      # 95/95

# 2. Image (or wait for CI on push)
#    .github/workflows/container-image.yml runs automatically

# 3. Promote into Cloudflare's managed registry
npx wrangler login                 # account must have containers:write
CF_ACCOUNT_ID=<account-id> GITHUB_REPOSITORY=caocuong2404/AgentCloud \
  ./scripts/promote-image.sh master --update-wrangler

# 4. Secrets (once)
./scripts/setup-secrets.sh --confirm   # writes .secrets.local, chmod 600

# 5. Deploy
npx wrangler deploy

# 6. Smoke
curl -i https://<your-worker>.workers.dev/api/status   # 401 without token
```

## Not verified (do not treat as passing)

Labeled per `AGENTS.md` — no claims beyond what was executed.

| Item | Status | Why |
| --- | --- | --- |
| T6 live E2E (spec `on-demand-wake.md`) | **not run** | needs a real paired Orca client; must confirm `cf-1` reconnects without 4001 and that Orca accepts the `cf-poc` recipe |
| Local Docker identity persistence | **not run on this Mac** | arm64 host cannot execute the x86_64 Orca binary; would need amd64 hardware or a CI job |
| Gates G0–G2 (LAN/WSS pairing) | **not run** | need Orca Desktop + Mobile on a LAN |
| Gates G4–G7 (work, liveness, Mac-off, cost) | **not run** | need a real agent task, 20-min idle, and billing inspection |
| `orca vm recipe doctor cf-poc` | previously 6/6 ok on `on-demand-wake` | re-run after these commits if the recipe surface changed (it did not) |

## Cost and safety notes

- Instance `standard-1`: worst-case **$0.074016/hr** (see `src/budget.mjs`);
  lease is hard-capped at 60 minutes by the Durable Object alarm.
- `POC_MONTHLY_RESERVATION_USD=4` is a *reservation* guard, not an
  account-wide spending cap. It is intentionally conservative and ignores
  included quotas.
- The image contains **no** identity, tokens, or credentials
  (`AGENTS.md` rule). Orca identity lives only in Durable Object storage and
  is restored via `ORCA_IDENTITY_B64`.
- `.secrets.local` is gitignored. Never commit it; never print tokens.
- Starting a container is billable. `POST /api/start` is admin-gated and is
  **never** triggered from the public `/connect/<token>` path.

## File map

| Path | Role |
| --- | --- |
| `container/Dockerfile` | image recipe (node:24-bookworm-slim + Orca AppImage extracted + Xvfb + Codex) |
| `container/image-ref.mjs` | pure ref builders — the naming contract, unit-tested |
| `container/pairing.mjs` | `orca://pair?code=` codec (base64url JSON, schema v2) |
| `container/identity.mjs` | identity envelope pack/unpack for cross-restart persistence |
| `container/supervisor.mjs` | boots `orca serve`, health/pairing/identity on :8080 |
| `.github/workflows/container-image.yml` | amd64 build + GHCR push |
| `scripts/promote-image.sh` | GHCR → Cloudflare managed registry + wrangler pin |
| `scripts/setup-secrets.sh` | generates `CONTROL_TOKEN`/`CONNECT_TOKEN`, writes `.secrets.local` |
| `src/budget.mjs` | reservation estimator + budget guard |
| `src/index.js` | Worker routes + Durable Object container lifecycle |
