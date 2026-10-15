// Image reference helpers for the GHCR → Cloudflare managed registry bridge.
//
// Why this exists: `durable_object` scheduling cannot pull GHCR directly
// (Cloudflare docs: "The durable_object scheduling policy does not support
// direct image references from external registries"). GHCR is the source of
// truth; a promote step mirrors the digest into Cloudflare's managed registry,
// and wrangler.jsonc pins that digest. Pure functions only — no network.

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const NAME_RE = /^[a-z0-9]+([._-][a-z0-9]+)*$/;

function requireName(value, label) {
  // Reject non-strings before any coercion: String(null) === 'null' would pass.
  if (typeof value !== 'string' || !NAME_RE.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

function requireDigest(digest) {
  if (typeof digest !== 'string' || !SHA256_RE.test(digest)) {
    throw new Error(`Invalid digest: ${JSON.stringify(digest)}`);
  }
  return digest;
}

function requireTag(tag) {
  if (typeof tag !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) {
    throw new Error(`Invalid tag: ${JSON.stringify(tag)}`);
  }
  return tag;
}

/** ghcr.io/<owner>/<repo>:<tag> — GHCR requires lowercase owner/repo. */
export function ghcrRef({ owner, repo, tag }) {
  const o = requireName(typeof owner === 'string' ? owner.toLowerCase() : owner, 'owner');
  const r = requireName(typeof repo === 'string' ? repo.toLowerCase() : repo, 'repo');
  return `ghcr.io/${o}/${r}:${requireTag(tag)}`;
}

/** ghcr.io/<owner>/<repo>@sha256:<digest> — digest-pinned pull from GHCR. */
export function ghcrDigestRef({ owner, repo, digest }) {
  const o = requireName(typeof owner === 'string' ? owner.toLowerCase() : owner, 'owner');
  const r = requireName(typeof repo === 'string' ? repo.toLowerCase() : repo, 'repo');
  return `ghcr.io/${o}/${r}@${requireDigest(digest)}`;
}

/**
 * registry.cloudflare.com/<accountId>/<repo>@sha256:<digest>
 * The only form accepted as a named `image` source for `durable_object`.
 */
export function cloudflareDigestRef({ accountId, repo, digest }) {
  const a = requireName(typeof accountId === 'string' ? accountId.toLowerCase() : accountId, 'accountId');
  const r = requireName(typeof repo === 'string' ? repo.toLowerCase() : repo, 'repo');
  return `registry.cloudflare.com/${a}/${r}@${requireDigest(digest)}`;
}

/** registry.cloudflare.com/<accountId>/<repo>:<tag> — form emitted by `wrangler containers push`. */
export function cloudflareTagRef({ accountId, repo, tag }) {
  const a = requireName(typeof accountId === 'string' ? accountId.toLowerCase() : accountId, 'accountId');
  const r = requireName(typeof repo === 'string' ? repo.toLowerCase() : repo, 'repo');
  return `registry.cloudflare.com/${a}/${r}:${requireTag(tag)}`;
}

/**
 * Parse a docker-style reference into its parts.
 * Returns { registry, path, tag, digest } with tag/digest null when absent.
 * A ref may carry tag, digest, or both (tag@digest).
 */
export function parseImageRef(ref) {
  if (typeof ref !== 'string' || !ref.trim()) {
    throw new Error(`Invalid image ref: ${JSON.stringify(ref)}`);
  }
  let rest = ref.trim();
  let digest = null;
  const at = rest.indexOf('@');
  if (at !== -1) {
    digest = requireDigest(rest.slice(at + 1));
    rest = rest.slice(0, at);
  }
  let tag = null;
  const lastSlash = rest.lastIndexOf('/');
  const lastColon = rest.lastIndexOf(':');
  if (lastColon > lastSlash) {
    tag = rest.slice(lastColon + 1);
    rest = rest.slice(0, lastColon);
  }
  const slash = rest.indexOf('/');
  if (slash <= 0) throw new Error(`Invalid image ref (no registry): ${JSON.stringify(ref)}`);
  return {
    registry: rest.slice(0, slash),
    path: rest.slice(slash + 1),
    tag,
    digest,
  };
}

/** True only for refs that pin an immutable sha256 digest. */
export function isDigestPinned(ref) {
  try {
    return parseImageRef(ref).digest !== null;
  } catch {
    return false;
  }
}

/** Replace or add the digest on an existing ref, keeping registry/path/tag. */
export function withDigest(ref, digest) {
  const { registry, path, tag } = parseImageRef(ref);
  const base = tag ? `${registry}/${path}:${tag}` : `${registry}/${path}`;
  return `${base}@${requireDigest(digest)}`;
}

/** Local tag used as the staging name before `wrangler containers push`. */
export function localStagingTag({ repo, tag }) {
  const r = requireName(typeof repo === 'string' ? repo.toLowerCase() : repo, 'repo');
  return `orca-agent-poc-${r}:${requireTag(tag)}`;
}
