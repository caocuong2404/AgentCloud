#!/usr/bin/env bash
# Mirror a GHCR image into Cloudflare's managed registry and pin its digest.
#
# durable_object containers cannot pull GHCR directly (Cloudflare docs), so the
# pipeline is: GitHub Actions builds → GHCR (source of truth) → this script →
# Cloudflare managed registry → digest-pinned ref in wrangler.jsonc.
#
# Usage:
#   GITHUB_REPOSITORY=owner/repo CF_ACCOUNT_ID=<id> \
#     ./scripts/promote-image.sh <tag> [--update-wrangler]
#
# Inputs:
#   tag                Image tag published by .github/workflows/container-image.yml
#   GITHUB_REPOSITORY  owner/repo (defaults to caocuong2404/AgentCloud)
#   CF_ACCOUNT_ID      Cloudflare account id used in registry.cloudflare.com/<id>/...
#   --update-wrangler  Rewrite containers.images.base.image in wrangler.jsonc
#
# Requires: docker, npx wrangler (authenticated to Cloudflare), read access to GHCR.
set -euo pipefail

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
TAG="$1"
UPDATE_WRANGLER=0
if [[ "${2:-}" == "--update-wrangler" ]]; then UPDATE_WRANGLER=1; fi

REPO_PATH="$(cd "$(dirname "$0")/.." && pwd)"
OWNER_REPO="${GITHUB_REPOSITORY:-caocuong2404/AgentCloud}"
OWNER="${OWNER_REPO%%/*}"
REPO="${OWNER_REPO##*/}"
CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-}"
CF_REPO="agentcloud"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
[[ -n "$CF_ACCOUNT_ID" ]] || { echo "CF_ACCOUNT_ID is required" >&2; exit 1; }

# Build refs through the unit-tested module so names stay consistent.
# Optional args must default under `set -u`; node needs --input-type=module for await.
build_ref() {
  local kind="$1" digest="${2:-}" account="${3:-}" repo_override="${4:-}"
  local repo="${repo_override:-$REPO}"
  node --input-type=module -e '
    const mod = await import("./container/image-ref.mjs");
    const [kind, tag, digest, accountId, owner, repo] = process.argv.slice(1);
    const args = { owner, repo, tag, digest, accountId };
    if (kind === "ghcr") process.stdout.write(mod.ghcrRef(args));
    else if (kind === "staging") process.stdout.write(mod.localStagingTag(args));
    else if (kind === "cf-tag") process.stdout.write(mod.cloudflareTagRef(args));
    else if (kind === "cf-digest") process.stdout.write(mod.cloudflareDigestRef(args));
    else { console.error("unknown ref kind: " + kind); process.exit(1); }
  ' "$kind" "$TAG" "$digest" "$account" "$OWNER" "$repo"
}

# The name wrangler pushes is the local staging name (see localStagingTag),
# so the Cloudflare repository is orca-agent-poc-<repo>, not <repo>.
CF_IMAGE_NAME="orca-agent-poc-${REPO}"

GHCR_REF="$(build_ref ghcr)"
STAGING_TAG="$(build_ref staging)"
CF_TAG="$(build_ref cf-tag "" "$CF_ACCOUNT_ID" "$CF_IMAGE_NAME")"

log() { printf 'promote: %s\n' "$*" >&2; }

# Orca's AppImage is x86_64-only, so the image is published linux/amd64.
# An arm64 host cannot pull the default platform match; pin amd64. We only
# retag and push here — never run the container on this machine.
log "pulling ${GHCR_REF} (linux/amd64)"
docker pull --platform linux/amd64 "$GHCR_REF"

log "retagging as ${STAGING_TAG} for wrangler containers push"
docker tag "$GHCR_REF" "$STAGING_TAG"

log "pushing ${STAGING_TAG} → Cloudflare managed registry"
# wrangler prints the registry URI; capture both stdout and stderr defensively.
PUSH_OUT="$( (cd "$REPO_PATH" && npx wrangler containers push "$STAGING_TAG") 2>&1 | tee /dev/stderr)"

# The push target is <STAGING_TAG> rewritten to registry.cloudflare.com/<account>/<name>:<tag>
# where <name> is the local staging name. Resolve the Cloudflare-side tag name
# from the staging tag so we do not invent an account-specific path.
log "inspecting local tag for RepoDigests"
DIGEST="$(docker image inspect --format '{{join .RepoDigests "\n"}}' "$STAGING_TAG" 2>/dev/null \
  | grep -E '^registry\.cloudflare\.com/' | head -1 | sed 's/^.*@//' || true)"

if [[ -z "$DIGEST" ]]; then
  # Fallback: some pushers leave the digest only on the source ref.
  DIGEST="$(docker image inspect --format '{{join .RepoDigests "\n"}}' "$GHCR_REF" 2>/dev/null \
    | grep -E '@sha256:' | head -1 | sed 's/^.*@//' || true)"
fi
if [[ -z "$DIGEST" ]]; then
  log "ERROR: could not resolve sha256 digest after push"
  log "push output was:"
  printf '%s\n' "$PUSH_OUT" >&2
  exit 1
fi

# Digest-pinned ref is the durable_object-writable form. Pass the CF
# repository (staging name) so it matches what wrangler actually pushed.
CF_DIGEST_REF="$(build_ref cf-digest "$DIGEST" "$CF_ACCOUNT_ID" "$CF_IMAGE_NAME")"

log "Cloudflare digest-pinned image:"
printf '%s\n' "$CF_DIGEST_REF"

if [[ "$UPDATE_WRANGLER" == "1" ]]; then
  WRANGLER="${REPO_PATH}/wrangler.jsonc"
  [[ -f "$WRANGLER" ]] || { echo "wrangler.jsonc not found" >&2; exit 1; }
  node -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    const digestRef = process.argv[2];
    let text = fs.readFileSync(path, "utf8");
    const re = /"base":\s*\{[^}]*\}/s;
    if (!re.test(text)) { console.error("Could not find containers.images.base in wrangler.jsonc"); process.exit(1); }
    text = text.replace(re, `"base": { "image": "${digestRef}" }`);
    fs.writeFileSync(path, text);
    console.error(`promote: wrangler.jsonc now pins ${digestRef}`);
  ' "$WRANGLER" "$CF_DIGEST_REF"
fi

log "done. Next: npx wrangler deploy (needs explicit approval)."
