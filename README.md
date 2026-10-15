# Cloudflare Agent Runtime POC — Orca first, Herdr later

**Status (2026-10-15):** Source scaffold + static tests only. **Not deployed or end-to-end validated.**

Goal: A single on-demand Cloudflare Container running an actual `orca serve` process, controlled from Orca desktop and mobile, including when the MacBook is off. It should later become a client-neutral agent runtime for Herdr. This POC deliberately has one workspace, one running Container, and no full job queue or durable filesystem yet.

## Contents

- `container/`: Docker image with Orca Linux AppImage (extracted for headless Docker), Xvfb, Git, Node, and Codex CLI (not logged in). `supervisor.mjs` runs `orca serve` and exposes private health/pairing diagnostics on port 8080.
- `src/`: Cloudflare Worker + Durable Object Container API. Admin routes use an HTTP Bearer secret; WebSocket pass-through uses an unguessable path segment suitable for Orca mobile pairing URL.
- `src/budget.mjs`: pessimistic CPU-at-100%-utilization per-session *reservation* accounting. Existing plan's included quota is intentionally ignored, but this is not an account-level spending cap.
- `docs/TEST_PLAN.md`: stop/go gates and runbook.
- `docs/architecture-intent.md`: longer-term intent and guardrails. `AGENTS.md` is the short set of agent instructions.

## POC quick start

### Step 0: cheap local compatibility gate — no Cloudflare spend

Prerequisites on your Mac: Docker Desktop or a compatible Docker engine, and latest Orca Desktop + Mobile.

```bash
# Build the container locally. This downloads the latest Orca Linux AppImage.
docker build -f container/Dockerfile -t orca-agent-poc .

# The Mac/phone must be on the same LAN. Substitute Mac's actual LAN IP.
export MAC_LAN_IP=192.168.1.123

docker run --rm --name orca-local-poc \
  -p 6768:6768 -p 127.0.0.1:8080:8080 \
  -e ORCA_PAIRING_ADDRESS="$MAC_LAN_IP" \
  orca-agent-poc

# In a SECOND terminal:
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8080/__pairing
```

Paste the Orca-generated pairing link (or scan its QR code) into Orca Mobile, and pair Orca Desktop as a remote server. Do not assume a mobile pairing link can be converted to a desktop pairing link. Complete the tests in `docs/TEST_PLAN.md`.

### Step 1: public WSS gate, no Container billing

Use **Cloudflare Quick Tunnel only as a temporary test harness**, with local Docker still running. Start the tunnel before Docker so you can set `ORCA_PAIRING_ADDRESS` to its WSS hostname. This briefly exposes Orca's listener via a public URL — close it immediately after testing.

```bash
cloudflared tunnel --url http://localhost:6768
# Note the hostname, e.g. https://<random>.trycloudflare.com
# Stop and recreate the Docker container using:
docker run --rm --name orca-local-poc \
  -p 6768:6768 -p 127.0.0.1:8080:8080 \
  -e ORCA_PAIRING_ADDRESS='wss://<random>.trycloudflare.com' \
  orca-agent-poc
```

Pair **from mobile over cellular** and test auth/reconnect. If this fails, **stop here**; Cloudflare Containers cannot repair Orca protocol/pairing bugs.

### Step 2: Cloudflare Container POC — paid action, user-run

Requires Cloudflare Workers Paid ($5 already subscribed), Node.js, Wrangler auth, and an active Docker-compatible engine for image builds.

```bash
npm install
npm test
npx wrangler login
npx wrangler deploy
./scripts/setup-secrets.sh --confirm

# Set your exact workers.dev URL reported by Wrangler.
export POC_WORKER_URL='https://orca-agent-poc.<your-subdomain>.workers.dev'
./scripts/poc.sh start
./scripts/poc.sh status
./scripts/poc.sh pairing
# Pair from desktop/mobile, test when Mac is shut down (Cloudflare continues running).
./scripts/poc.sh stop
```

To get an interactive shell for Codex device login or debugging, optionally add your Mac's **public** `ssh-ed25519` key to the `containers[0].authorized_keys` array of `wrangler.jsonc` **before deploying**:

```json
"authorized_keys": [{ "name": "macbook", "public_key": "ssh-ed25519 AAAA..." }]
```

Then, after Container start:

```bash
npx wrangler containers list
npx wrangler containers instances <APPLICATION_ID>
npx wrangler containers ssh <INSTANCE_ID>
# In the container, using an interactive terminal:
cd /workspace
codex login --device-auth
codex # give it a small task, then inspect Git status/diff
```

Cloudflare supports only `ssh-ed25519` keys here. Alternatively, use a remote terminal supplied by Orca after desktop/mobile pairing. **Never store Codex session credentials in the Dockerfile or a published snapshot.** Container stops wipe any unsaved login and files in this v0.

Security notes: initial deploy refuses requests until both secrets exist. The connection token is embedded in the mobile pairing address and should be treated as sensitive. Admin auth and remote pairing credentials are distinct. Do not expose `__pairing` through the public WebSocket route. Rotate secrets and redeploy when finished. No secrets are included in this archive.

## Hard gates

1. No more than one running Container. Only authenticated `POST /api/start` may wake it.
2. 60-minute hard lease with a Durable Object alarm; explicit stop at any time. DO inactivity timeout is **90 minutes**, deliberately longer than the 60-minute lease so a quiet running agent is not stopped simply because a mobile client disconnects. A host restart/platform maintenance may still stop it.
3. Only `standard-1` and `standard-2` can be selected. Default `standard-1` for cheaper feasibility checks. Change `INSTANCE_SIZE` to `standard-2` in Wrangler config if needed, redeploy before starting.
4. Conservative reservations of worst-case CPU/RAM/disk allocation with a POC reservation cap of **$4/month** (`POC_MONTHLY_RESERVATION_USD`). Excludes Workers, Durable Objects, logs, image/snapshot storage, egress, and models. **Not a hard Cloudflare billing cap.**
5. Filesystem is ephemeral; no guaranteed checkpoints in v0. Do not run important work or store secrets without backups.
6. Do not call the platform functional until **real mobile pairing, actual Codex execution, >20min background liveness, and reconnect with Mac off** are observed.

## Exit / emergency stop

```bash
./scripts/poc.sh stop
# If administrative API fails, use the Cloudflare dashboard to delete/stop the container instance.
# For complete shutdown after testing:
npx wrangler delete
```

`wrangler delete` removes the Worker and may affect the deployment's state; use it only after extracting anything needed. Deploying, deleting, rotating secrets, and starting a Container are explicit user actions. Do not turn this into unattended production until kill/recovery paths are verified.

## Source of truth

- https://developers.cloudflare.com/containers/api/durable-object-container/
- https://developers.cloudflare.com/containers/examples/websocket/
- https://developers.cloudflare.com/containers/platform/pricing/
- https://github.com/stablyai/orca/blob/main/docs/reference/headless-linux-server.md
- https://github.com/stablyai/orca/blob/main/docs/site/content/docs/remote-servers.mdx
- https://github.com/stablyai/orca/blob/main/skill-guides/orca-per-workspace-env.md
- https://github.com/herdrdev/herdr
