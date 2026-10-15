# AGENTS.md — Cloudflare Agent Runtime POC

## Mission
Deliver **actual working on-demand agent execution** on Cloudflare Workers Paid + Containers. Orca desktop/mobile is the first client. Preserve the option to add Herdr later. The Cloudflare control plane must not depend on Orca domain objects.

## Priorities (strict)
1. Validate Orca `serve` mobile/desktop pairing locally in Docker first, then public WSS via a temporary Cloudflare Tunnel, **before deploying a paid Container**.
2. Prove Cloudflare Worker → Durable Object → Container WebSocket forwarding with Orca running and Mac off.
3. Validate an actual agent coding task and its Git output; validate idle/no-client liveness >20 minutes and reconnection.
4. Collect billing evidence. Stop/kill the experiment if the budget or functionality criteria fail.
5. Add persistent Git/R2 checkpointing and Herdr adapters only after the previous gates pass.

## Current budget/limits
- Workers Paid $5/month is already purchased. Accept at most **$5 additional** monthly spending.
- POC reserves no more than **$4/month** estimated worst-case Container compute (ignore included quotas for safety). Budget reserve is **not a Cloudflare account-wide spending cap**.
- Only one Container, maximum 60 minutes per start; `standard-1` default, `standard-2` if needed; no background keepalive that bypasses the fixed expiry alarm.
- Explicit consent and actual account access needed before any live deploy, paid provisioning, or destructive operation.

## Engineering rules
- Use `ctx.container` direct Durable Object Container API with the `durable_object` scheduling policy; do not use deprecated SDK APIs without clear justification.
- Do not call an SSH session a mobile pairing solution. Orca `serve` + `--mobile-pairing` + `--pairing-address` is the test target.
- Cloudflare Containers are ephemeral. Snapshot only filesystem; processes and agent auth/session state need separate treatment. No snapshot/recovery claims in v0.
- Do not preserve or duplicate Orca pairing identity in a shared base image. Do not commit auth tokens, copy host token files, or bake agent credentials into Docker layers.
- Never auto-start a Container from a public connection path. All starts require authenticated admin requests. No embedded tokens in Git URLs.
- Do not invent deployment URLs, account identifiers, pairing codes, region, CLI output, or passing test results. Label scaffold, static tests, local Docker tests, and deployed E2E tests distinctly.
- Changes must stay minimal and testable. Avoid Workflows, Queues, multi-tenant auth, R2/FUSE, and Herdr until functionality warrants them.

## Checks before declaring success
- `npm test` and `npm run check` pass.
- Local Docker engine builds image; `orca serve` starts and prints a mobile pairing code, desktop and phone can pair.
- Public WSS tunnel pairs and re-pairs over cellular. Test exact Orca versions.
- Cloudflare Worker/Container boots and forwards WebSocket without breaking Orca authentication.
- An actual coding agent can edit files, run tests, and produce a Git change; verify that results are exported before stop.
- Disconnect clients for 20 minutes and confirm agent remains alive; Mac off, reconnect phone; 60min alarm and manual stop both terminate the Container.
- Record measured cold start, RAM/CPU/disk, session cost, failure cases and actual Cloudflare billing.

## Where to read
- `README.md`: runbook and safety/commands.
- `docs/TEST_PLAN.md`: numbered kill gates, test records.
- `docs/architecture-intent.md`: architecture and longer-term product intent (not an implemented contract).
- Official docs linked in `README.md`; verify exact API/version before changes.

## Autonomy boundaries
Reading files, editing code, local static tests are allowed. Any external deploy, paid provisioning, rotating secrets, changes to the account, destructive operations, or commits require explicit approval and available authentication. Never mistake a generated artifact for a live deployment.
