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
build_ref() {
  node -e '
    const mod = await import("./container/image-ref.mjs");
    const kind = process.argv[1];
    const tag = process.argv[2];
    const digest = process.argv[3] || "";
    const accountId = process.argv[4] || "";
    const args = { owner: process.argv[5], repo: process.argv[6], tag, digest, accountId };
    if (kind === "ghcr") process.stdout.write(mod.ghcrRef(args));
    else if (kind === "staging") process.stdout.write(mod.localStagingTag(args));
    else if (kind === "cf-tag") process.stdout.write(mod.cloudflareTagRef(args));
    else if (kind === "cf-digest") process.stdout.write(mod.cloudflareDigestRef(args));
  ' "$1" "$TAG" "$2" "$3" "$OWNER" "$REPO"
}

GHCR_REF="$(build_ref ghcr)"
STAGING_TAG="$(build_ref staging)"
CF_TAG="$(build_ref cf-tag)"

log() { printf 'promote: %s\n' "$*" >&2; }

log "pulling ${GHCR_REF}"
docker pull "$GHCR_REF"

log "retagging as ${STAGING_TAG} for wrangler containers push"
docker tag "$GHCR_REF" "$STAGING_TAG"

log "pushing ${STAGING_TAG} → Cloudflare managed registry"
# wrangler prints the registry URI; capture both stdout and stderr defensively.
PUSH_OUT="$( (cd "$REPO_PATH" && npx wrangler containers push "$STAGING_TAG") 2>&1 | tee /dev/stderr)"

# The push target is <STAGING_TAG> rewritten to registry.cloudflare.com/<account>/<name>:<tag>
# where <name> is the local staging name. Resolve the Cloudflare-side tag name
# from the staging tag so we do not invent an account-specific path.
CF_IMAGE_NAME="orca-agent-poc-${REPO}"
CF_TAG_ACTUAL="registry.cloudflare.com/${CF_ACCOUNT_ID}/${CF_IMAGE_NAME}:${TAG}"

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

CF_DIGEST_REF="$(build_ref cf-digest "$DIGEST" "$CF_ACCOUNT_ID")"
# Build the digest ref from the actual Cloudflare image name (staging name),
# not the GitHub repo name, so it matches what push produced.
CF_DIGEST_REF="registry.cloudflare.com/${CF_ACCOUNT_ID}/${CF_IMAGE_NAME}@${DIGEST}"

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
