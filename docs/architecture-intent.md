# AGENTS.md — Cloudflare Agent Runtime & Orchestration Platform

> Repository-level engineering instructions for AI coding agents.
> Last reviewed: 2026-10-15.
> Status: architecture intent and delivery constraints, **not** a claim that integrations already work.

## 1. North star

Build a **Cloudflare-native, on-demand execution and orchestration platform for coding agents**. It must provision isolated agent workspaces only when needed, coordinate interactive and autonomous work, preserve recoverable state, and clean up resources safely.

The platform is the product; **Orca AIDE is the first integration, not the architecture**. Orca desktop and mobile access are first-class goals. **Herdr (`herdrdev/herdr`) is a future client/runtime integration**, not a requirement for the first milestone. Make later integrations possible without rewriting the Cloudflare control plane.

### Target outcomes

1. Start an isolated Linux agent environment on demand from a client request or accepted task.
2. Run existing coding-agent CLIs (e.g., Codex, OpenCode, Pi) without creating a new LLM harness.
3. Support **interactive sessions** (terminal/IDE/mobile steering) and **autonomous jobs** (plan/execute/test/report), with different lifecycle rules.
4. Observe task and workspace state, resume or reconnect where technically possible, and safely recover code/artifacts after interruption.
5. Scale down idle compute and expose per-task resource usage and estimated cost.
6. Add future clients through thin adapters instead of embedding Orca or Herdr concepts in platform core.

### Non-negotiable constraints

- **Cloudflare-only remote infrastructure.** No VPS, EC2, Hetzner, Fly.io, persistent self-hosted machine, Kubernetes, or separately hosted control plane. The user's Mac can run a client/development tools, not the platform's required server.
- Leverage the existing **Workers Paid** plan, but do not assume Container, CPU, RAM, disk, storage, network, Workflow, or model usage is unlimited or included.
- Avoid always-on Containers by default. Preserve logical agent/workspace identity **outside** the ephemeral running process.
- Prefer native Cloudflare services and official examples to writing custom infrastructure primitives.
- Do **not** tie platform domain models, APIs, database schemas, or orchestration rules to any particular client.
- Do not provision paid infrastructure, deploy, change account-level settings, expose services publicly, or destroy real user data without explicit approval.

## 2. Understand the domains: client, agent, job, workspace

Use these meanings consistently:

- **Client adapter:** translates an external client protocol or lifecycle contract to/from platform operations. Examples: Orca adapter, later Herdr adapter, optionally HTTP/CLI.
- **Agent:** an existing executable coding agent/harness inside a Container. Its model, credentials, prompts, and skills are not owned by the cloud platform unless explicitly scoped.
- **Job:** a durable unit of requested work with an owner, input, progress, bounded execution, result, and a terminal outcome. A job may coordinate multiple bounded tasks; distinguish a job from an interactive terminal.
- **Workspace:** a logical, isolated repo/filesystem/toolchain context. Its identity survives Container replacement if data was durably preserved.
- **Execution lease:** a time-bounded claim that a running Container is working for a specific workspace/job. Avoid duplicate competing workers.
- **Session:** client/runtime interaction state. **Client sessions, OS processes, and filesystem snapshots have different persistence guarantees.** Never use these terms interchangeably.

Do not assume a single Container must equal an agent, a task, an Orca worktree, or a Herdr session. Define the cardinality explicitly for each implementation; start with one active agent task per workspace if no evidence favors multiplexing.

## 3. Proposed Cloudflare architecture

```text
Clients (not Cloudflare-managed):
  Orca AIDE desktop + mobile (first)          Herdr CLI/TUI (later)
          |                                           |
     Orca adapter                                Herdr adapter
          +------------------+------------------------+
                             |
                   Versioned Platform API
                       Cloudflare Workers
                authentication / authorization
                             |
             +---------------+------------------+
             |                                  |
    Cloudflare Workflows                  Durable Objects
    durable job steps, retry,            workspace registry,
    approval, scheduling                 lifecycle, locking,
    and completion                       leases, instance mapping
             |                                  |
             +----------------+-----------------+
                              |
                  Cloudflare Containers
                 isolated agent environments
                  / terminal / tests / Git
                              |
       R2 (durable artifacts/backups) + Git (code history)
       Container snapshots (short-term filesystem resume)
       Workers Observability; AI Gateway if needed
```

### Service selection rules

| Service | Use it for | Do not use it for |
| --- | --- | --- |
| Workers | External API, auth, routing, small request logic | Arbitrary shell execution or a perpetual agent process |
| Workflows | Durable **multi-step** jobs, retry, wait/approval, async coordination | Every keystroke or remote terminal packet |
| Durable Objects | Per-workspace serialization, state transitions, leases, Container startup/shutdown, connection lookup | An unbounded general-purpose workflow engine or durable filesystem |
| Containers | Real Linux processes, coding agents, builds/tests, interactive runtime | Permanent source of truth for code/secrets/state |
| R2 | Artifacts, backups, exports, logs needing retention | Live synchronization of mutable POSIX workspaces without a proven layer |
| Container snapshots | Fast short-term filesystem recovery where supported | Process/memory preservation or durable long-term backups |
| AI Gateway | Optional model API control, telemetry/cost routing | An assumption that model subscriptions grant transferable API access |

Use **Cloudflare Sandbox SDK 1.x** when it simplifies Container-based agent execution; use the **Durable Object Container API** when finer per-instance lifecycle/snapshot control is needed. Evaluate before committing to a library. Do not start new work on deprecated Sandbox SDK 0.x. Prefer the `durable_object` scheduling policy when per-instance image, size, or snapshots are required; it is beta, so track risks and check current limitations. Add Queues, D1, KV, Agents SDK, Browser Rendering, or additional products **only after a concrete requirement**; no decorative service proliferation.

## 4. Interface independence: adapters, not forks

**The platform must expose a small, stable application contract.** The following is a **conceptual API**, not deployed routes or a finalized schema:

```text
CreateWorkspace(spec) -> workspaceId, status
StartWorkspace(workspaceId) -> status
GetWorkspace(workspaceId) -> status, capabilities, connectionDescriptor?
SubmitJob(workspaceId?, taskSpec, idempotencyKey) -> jobId
GetJob(jobId) -> status, progress, resultRef?
StreamEvents(workspaceId | jobId, cursor?) -> events
SuspendWorkspace(workspaceId) -> durable checkpoint metadata
ResumeWorkspace(workspaceId) -> new connectionDescriptor
DestroyWorkspace(workspaceId, retentionPolicy) -> result
CancelJob(jobId) -> cancellation status
```

Do not implement all endpoints in phase one. Prefer the minimum required by the chosen Orca path. The transport descriptor is **adapter-specific**, generated at the edge from a neutral runtime record (instance ID, image, supported transports, expiry, readiness); do not persist an Orca `pairingCode` or Herdr SSH profile as the platform's canonical domain entity.

For each operation define: authenticated principal/owner, input validation, idempotency, expected lifecycle state, concurrency rule, timeout, billing consequence, and error/compensation behavior. All destructive operations must have explicit scopes.

### State machine baseline

```text
requested -> provisioning -> ready -> active
                |                     |
                v                     v
              failed             checkpointing -> suspended
                                     |               |
                                     v               v
                                   failed         restoring -> ready

ready/active/suspended -> deleting -> destroyed
job: accepted -> queued -> running -> {succeeded, failed, cancelled}
```

State names can evolve after a tested API contract. Distinguish *desired state* from *observed state*. A Worker/DO restart, API retry, or lost response must not create a duplicate running environment. On startup reconcile actual Container state with durable metadata. A suspend action must never silently kill an active process or lose uncommitted code.

## 5. Integration priority #1 — Orca AIDE, including mobile

Official references:
- https://github.com/stablyai/orca
- https://github.com/stablyai/orca/blob/main/skill-guides/orca-per-workspace-env.md
- https://www.onorca.dev/docs/ways-to-run
- https://www.onorca.dev/docs/remote-servers
- https://www.onorca.dev/docs/mobile

**Do not equate Orca SSH worktrees with Remote Orca Servers.** They have different runtime ownership and mobile/multi-client behavior. Compare **both** against the primary goal of remote mobile access before selecting a phase-one transport:

| Mode | Who owns the Orca runtime? | First integration questions |
| --- | --- | --- |
| Orca SSH worktree | Orca on the desktop; Container executes remote work | Wrangler ProxyCommand, worktree checkout, terminal/file sync, wake/reconnect |
| Headless `orca serve` in Container | Remote Container owns Orca runtime, workspaces and sessions | Reachable authenticated connection, pairing, websocket behavior, mobile support, cold start and snapshot safety |

An Orca **mobile companion normally pairs with an Orca runtime**. Do not claim that mobile can launch a stopped Container or manage a worktree without verifying the supported workflow. For truly Mac-independent mobile access, **prioritize feasibility testing of headless `orca serve`** and the mobile pairing/reconnect path. This is a hypothesis to validate, **not a guarantee that Orca's beta remote-server features work unchanged behind Cloudflare networking**.

Orca recipes expose `environmentRecipes` and lifecycle scripts (`create`, `suspend`, `resume`, `destroy`). For Orca-server mode, scripts must emit the version-matched server/pairing result; for SSH mode, emit `connection.type: "ssh"` and the correct SSH target. Consult the installed version's `orca-per-workspace-env` skill and `orca vm recipe doctor` **before** authoring schemas, CLI arguments or scripts. Keep stdout reserved for the recipe JSON and diagnostics on stderr.

Cloudflare `wrangler containers ssh` and OpenSSH ProxyCommand are currently supported for **running** Containers; they neither start stopped instances nor keep them running. It is an **optional transport**, not the orchestration API and not a promise of mobile connectivity. Validate each SSH option against current Wrangler CLI/docs.

For headless Orca: isolate each runtime identity. **Never clone/snapshot a previously initialized `orca serve` identity into multiple workspaces**: persistent device keys, pairing credentials and session authority must not be shared. Document safe identity initialization, rotation, secrets handling, and snapshot boundaries. Pairing URLs/tokens are sensitive and must not be logged, stored unencrypted, or broadly exposed. Do not expose the Orca runtime directly to the internet without a validated authenticated transport; check native desktop/mobile client compatibility with the chosen Cloudflare access layer.

Acceptance for phase-one Orca must explicitly cover **desktop and mobile separately**: connect, monitor, steer/reply, disconnect/reconnect, suspend/resume where supported, status after cold start, and behavior while the Mac is off. Clearly identify unsupported cases rather than implementing insecure bypasses.

## 6. Integration priority #2 — Herdr (future)

Official references:
- https://github.com/herdrdev/herdr
- https://herdr.dev/docs/connecting-machines/
- https://herdr.dev/docs/persistence-remote/
- https://herdr.dev/docs/socket-api/

Herdr is a Rust terminal/agent workspace runtime with remote machine support via **SSH**, CLI tooling, and a **local socket API**. Its detached server can keep panes running **while the Container process exists**; a stopped/evicted Container does not preserve OS processes. Herdr can restore saved layouts and, where supported, agent sessions after restart; validate exactly which state is recoverable.

A later Herdr adapter may:
- Provision a Herdr-capable Container from the same workspace API.
- Produce an authorized SSH target / local client profile and hand off to `herdr machine add`, `herdr --remote`, or the version-matched CLI interface.
- Use Herdr CLI wrappers for task/pane/status operations; access the raw socket only from inside the trusted runtime when truly needed.
- Translate working/blocked/idle/done signals into **optional** platform events without making them the canonical job state.

**Do not prematurely implement Herdr integration** or modify/fork Herdr or Orca upstream. Preserve optionality using a contract test and a brief adapter design note. Never expose Herdr's local Unix socket as a public unauthenticated service.

## 7. Runtime execution, orchestration, and recovery

- Use official/runtime-provided agent CLIs and configurations. Pin base images/toolchain versions, avoid Docker-in-Docker and unnecessary background daemons.
- Handle interactive sessions and autonomous jobs separately: long-lived user-driven sessions should not be interrupted by the timeout policy used for unattended tasks.
- One logical workspace must have a controlled owner and at most one active writer/lease by default. Use Git branches/worktrees and conflict checks where concurrent edits are explicitly supported.
- Prefer **Workflows** for durable async steps, backoff, wait-for-approval and failure compensation; **Durable Objects** for serialized environment control. Do not duplicate retry/state machines at multiple layers without a stated reason.
- Ensure work can be retried: idempotency keys, operation IDs, exponential backoff with bounds, terminal failure classification, fencing stale worker leases, and a clear cancel/cleanup path.
- Checkpoint after quiescing writes and exporting uncommitted diffs. Source code belongs in Git (or explicit R2 backup), not only a temporary filesystem.
- Container snapshots preserve a **filesystem**, not memory, running processes, or terminal continuity. They are image-version dependent and have retention constraints; check current documentation before promising restore. Resume means rehydrate files and **restart or natively resume** compatible runtimes, not magically continue a killed process.
- A disconnected client is not equivalent to an idle agent. Track activity/leases explicitly before scale-down. Define bounded max runtime, idle timeout, maximum concurrent workspaces, and emergency kill/cleanup.
- Do not claim exactly-once task execution without proof. Design for durable at-least-once control requests plus idempotent observable effects.

## 8. Security and cost discipline

- Authenticate and authorize every control-plane API operation and streamed event; enforce ownership, workspace ACLs, bounded inputs, and scoped, revocable tokens.
- Separate control-plane permissions from Container execution permissions. Assume coding agents can execute untrusted repository code; constrain egress and sensitive mounts.
- Never commit or print secrets: Cloudflare tokens, SSH private keys, Git credentials, OAuth refresh tokens, pairing links, or model API keys. Store only permitted secret references in durable metadata. Never bake credentials into reusable images or shared snapshots.
- Treat ingress to a headless Orca server and any WebSocket/terminal relay as privileged; verify end-to-end auth, TLS, per-client revocation, connection routing, and mobile compatibility before making it accessible.
- Use user-approved authentication flows; never assume a consumer model subscription supports unattended, duplicated, or transferable logins. Prefer scoped API credentials where the provider allows them.
- Keep a cleanup path for every paid resource. Show marginal pricing and estimated billable exposure based on measured Container size/uptime; record cold-start latency, task duration, retries, storage, egress and model token spend separately.
- Set telemetry, idle shutdown, concurrency quotas, task timeouts, and user-level cost policy; Cloudflare alerts are not necessarily a hard billing cap.
- Do not deploy, create paid test instances, grant public access, modify account settings, push/merge, or delete durable state without the user's explicit approval. Read-only research, code edits, unit tests, and non-provisioning validation are permitted.

## 9. Repository design — preserve boundaries

**Illustrative target layout** (adapt to the actual repository, do not create empty scaffolding):

```text
AGENTS.md
src/
  api/                 # Cloudflare Worker HTTP/auth/routing
  domain/              # Neutral workspace/job models, validation, errors
  orchestration/       # Workflow definitions, step coordination
  compute/             # Durable Object lifecycle + Container runtime control
  adapters/
    orca/              # Orca-specific recipes and connection translation
    herdr/             # Future; do not scaffold until justified
  observability/       # Events, metrics, redaction
container/
  Dockerfile            # Minimal versioned agent image
scripts/
  orca-vm/             # Mac-side Orca recipe lifecycle scripts
  smoke/               # Independent transport/runtime checks
tests/
  unit/
  contracts/
  integration/
docs/
  architecture.md       # Decisions + rationale when needed
  runbook.md            # Provision/restore/delete/incident procedures
```

Code in `src/domain`, `src/orchestration`, and `src/compute` **must not import Orca/Herdr modules**. Adapter-specific logic depends on the neutral platform contract, not the reverse. Keep schemas versioned and avoid client-specific names in persistent identifiers. Begin as a small modular monolith (one Worker project is acceptable); split into services only on demonstrated operational need.

## 10. Delivery plan and evidence gates

**Phase 0 — Research and contracts (no paid work).** Inspect existing repository and tooling. Confirm current Cloudflare Containers, Sandbox SDK 1.x, Durable Object scheduling, Workflows, pricing/quotas, SSH, snapshots, and Orca/Herdr capabilities from official sources. Record design choices in short ADRs: Orca-server vs SSH; workflow vs DO responsibilities; persistent state; network/pairing; user authentication; target budget. Produce a minimal platform API contract and falsifiable POC test plan.

**Phase 1 — One on-demand Container, one real Orca integration.** With approval, deploy a minimal Container and secure routing. Test `orca serve` **and mobile pairing** as feasibility gates; test Wrangler SSH separately as fallback/desktop path. Evaluate Mac-off access and WebSocket/reconnect. Stop and report clearly if the chosen approach conflicts with Orca's beta client protocol. Do not build a general orchestrator until at least one end-to-end client path works.

**Phase 2 — Neutral lifecycle control.** Implement authenticated Worker API, a single per-workspace Durable Object, state reconciliation, `create/start/status/stop/destroy`, idempotency, readiness, bounded timeouts, and actual cleanup. Wire the Orca recipe adapter. Unit/contract tests first, then approved cloud smoke tests.

**Phase 3 — Job orchestration.** Introduce Workflows only for real asynchronous multi-step tasks: enqueue/start agent job, await completion/approval, retry bounded failures, stream durable status, cancel, and report. Keep agent CLI/tool selection separate from orchestrator business logic.

**Phase 4 — Recovery, cost and operations.** Safe filesystem snapshots, R2/Git exports, cold restore, failure injection, idle scale-down, metrics, model cost tracking where available, minimal operator runbook, and verified cost/resource limits.

**Phase 5 — Herdr adapter (only when requested).** Reuse the same platform API; investigate Herdr version, remote SSH, local socket API/CLI, detach/reconnect behavior, runtime restore. Show a second client can use the same cloud workspace abstraction without changing core domain models.

### Definition of done (do not substitute demos for proof)

- On-demand provisioning and authenticated access with no VPS and no required always-on Container.
- At least one Orca interaction succeeds end-to-end; clearly report whether native **mobile** can monitor/steer with Mac powered off.
- Distinct workspace and job identity, observable status, safe lifecycle transitions, idempotent retries and recovery from partial failure.
- Agent actually edits a test repository, runs a test command, returns a diff/result, and survives client disconnect to the extent claimed.
- Stop/suspend behavior preserves promised data; reconnect/restore semantics verified without pretending OS processes survived.
- No secret leakage, no public unauthenticated agent console, no orphaned billable resources; cleanup and cost evidence recorded.
- Core does not depend on Orca or Herdr types; adapter contract tests pass.

## 11. Agent working protocol

For every nontrivial change:

1. **Discover first:** inspect repo, dependencies, versions, tests, and official documentation. Do not guess API schema, CLI commands, project region, billing tier, or environment capabilities.
2. **Plan narrowly:** define the user outcome, smallest vertical slice, unresolved choices, risks/cost, and explicit acceptance criteria. Separate verified facts from hypotheses.
3. **Implement incrementally:** keep domain boundaries, avoid duplicated state machines, premature abstractions, noisy scaffolding, unnecessary dependencies, and code smell. Existing conventions win over this illustrative layout.
4. **Verify:** formatting, types, unit tests, contract tests, and negative/failure paths. Perform billable/live cloud tests only with approval.
5. **Review independently:** security, orchestration retries, races/leases, transport trust boundaries, credential persistence, data loss, mobile behavior, resource leaks, and operating cost.
6. **Report facts:** files changed, commands/tests executed, observed evidence, known limitations, next steps, and any action requiring explicit user approval. Never present an untested design as deployed/working.

Use strong reasoning for architectural decisions and review, faster models for bounded implementation when appropriate. The quality gate is **observable working behavior**, not agent-generated confidence.

## 12. Official source-of-truth index

- Cloudflare Containers scheduling: https://developers.cloudflare.com/containers/configuration/scheduling-policy/
- Durable Object Container API: https://developers.cloudflare.com/containers/api/durable-object-container/
- Containers SSH: https://developers.cloudflare.com/containers/guides/ssh/
- Containers snapshots: https://developers.cloudflare.com/containers/guides/snapshots/
- Cloudflare Sandbox SDK: https://developers.cloudflare.com/sandbox/
- Cloudflare Workflows durable agents: https://developers.cloudflare.com/workflows/get-started/durable-agents/
- Cloudflare Workflows events: https://developers.cloudflare.com/workflows/build/events-and-parameters/
- Orca per-workspace environment skill: https://github.com/stablyai/orca/blob/main/skill-guides/orca-per-workspace-env.md
- Orca Remote Servers: https://www.onorca.dev/docs/remote-servers
- Orca mobile: https://www.onorca.dev/docs/mobile
- Herdr repository: https://github.com/herdrdev/herdr
- Herdr remote machines: https://herdr.dev/docs/connecting-machines/
- Herdr socket API: https://herdr.dev/docs/socket-api/

If current official documentation conflicts with these instructions, **surface the discrepancy and amend the plan before implementation**. Do not silently treat a speculative integration as supported.
