import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ghcrRef, ghcrDigestRef, cloudflareDigestRef, cloudflareTagRef,
  parseImageRef, isDigestPinned, withDigest, localStagingTag,
} from '../container/image-ref.mjs';

const DIGEST = 'sha256:' + 'a'.repeat(64);
const DIGEST_B = 'sha256:' + 'b'.repeat(64);

// ---------------------------------------------------------------------------
// ghcrRef
// ---------------------------------------------------------------------------

test('ghcrRef builds a lowercase ghcr.io tag reference', () => {
  assert.equal(
    ghcrRef({ owner: 'caocuong2404', repo: 'AgentCloud', tag: 'latest' }),
    'ghcr.io/caocuong2404/agentcloud:latest',
  );
});

test('ghcrRef lowercases owner and repo (GHCR requirement)', () => {
  assert.equal(
    ghcrRef({ owner: 'CaoCuong2404', repo: 'AgentCloud', tag: 'v1' }),
    'ghcr.io/caocuong2404/agentcloud:v1',
  );
});

test('ghcrRef accepts git-SHA style tags', () => {
  const tag = 'sha-851e02a';
  assert.equal(
    ghcrRef({ owner: 'caocuong2404', repo: 'agentcloud', tag }),
    `ghcr.io/caocuong2404/agentcloud:${tag}`,
  );
});

test('ghcrRef rejects empty/invalid owner, repo, tag', () => {
  assert.throws(() => ghcrRef({ owner: '', repo: 'r', tag: 't' }), /Invalid owner/);
  assert.throws(() => ghcrRef({ owner: 'o', repo: '', tag: 't' }), /Invalid repo/);
  assert.throws(() => ghcrRef({ owner: 'o', repo: 'r', tag: '' }), /Invalid tag/);
  assert.throws(() => ghcrRef({ owner: 'o', repo: 'r', tag: 'has space' }), /Invalid tag/);
  assert.throws(() => ghcrRef({ owner: 'o', repo: 'r', tag: 'has/slash' }), /Invalid tag/);
  assert.throws(() => ghcrRef({ owner: 'o/r', repo: 'r', tag: 't' }), /Invalid owner/);
  assert.throws(() => ghcrRef({ owner: null, repo: 'r', tag: 't' }), /Invalid owner/);
  assert.throws(() => ghcrRef({ owner: undefined, repo: 'r', tag: 't' }), /Invalid owner/);
  assert.throws(() => ghcrRef({ owner: 123, repo: 'r', tag: 't' }), /Invalid owner/);
});

// ---------------------------------------------------------------------------
// ghcrDigestRef / cloudflare refs
// ---------------------------------------------------------------------------

test('ghcrDigestRef pins a sha256 digest', () => {
  assert.equal(
    ghcrDigestRef({ owner: 'caocuong2404', repo: 'agentcloud', digest: DIGEST }),
    `ghcr.io/caocuong2404/agentcloud@${DIGEST}`,
  );
});

test('cloudflareDigestRef is the durable_object-writable form', () => {
  assert.equal(
    cloudflareDigestRef({ accountId: 'abc123def456', repo: 'agentcloud', digest: DIGEST }),
    `registry.cloudflare.com/abc123def456/agentcloud@${DIGEST}`,
  );
});

test('cloudflareTagRef matches wrangler containers push output shape', () => {
  assert.equal(
    cloudflareTagRef({ accountId: 'abc123def456', repo: 'agentcloud', tag: 'latest' }),
    'registry.cloudflare.com/abc123def456/agentcloud:latest',
  );
});

test('digest helpers reject malformed digests', () => {
  for (const digest of ['', 'sha256:', 'sha256:xyz', 'sha1:' + 'a'.repeat(40), 'a'.repeat(64), DIGEST.toUpperCase()]) {
    assert.throws(() => ghcrDigestRef({ owner: 'o', repo: 'r', digest }), /Invalid digest/, `digest=${digest}`);
    assert.throws(() => cloudflareDigestRef({ accountId: 'a1', repo: 'r', digest }), /Invalid digest/, `digest=${digest}`);
  }
});

test('digest helpers require exactly 64 hex chars after sha256:', () => {
  assert.throws(() => ghcrDigestRef({ owner: 'o', repo: 'r', digest: 'sha256:' + 'a'.repeat(63) }), /Invalid digest/);
  assert.throws(() => ghcrDigestRef({ owner: 'o', repo: 'r', digest: 'sha256:' + 'a'.repeat(65) }), /Invalid digest/);
});

// ---------------------------------------------------------------------------
// parseImageRef
// ---------------------------------------------------------------------------

test('parseImageRef splits registry, path, tag', () => {
  assert.deepEqual(
    parseImageRef('ghcr.io/caocuong2404/agentcloud:latest'),
    { registry: 'ghcr.io', path: 'caocuong2404/agentcloud', tag: 'latest', digest: null },
  );
});

test('parseImageRef splits registry, path, digest', () => {
  assert.deepEqual(
    parseImageRef(`registry.cloudflare.com/abc123/agentcloud@${DIGEST}`),
    { registry: 'registry.cloudflare.com', path: 'abc123/agentcloud', tag: null, digest: DIGEST },
  );
});

test('parseImageRef keeps tag and digest together', () => {
  assert.deepEqual(
    parseImageRef(`ghcr.io/o/r:v1@${DIGEST}`),
    { registry: 'ghcr.io', path: 'o/r', tag: 'v1', digest: DIGEST },
  );
});

test('parseImageRef keeps host:port as registry, not tag', () => {
  assert.deepEqual(
    parseImageRef('localhost:5000/team/app:dev'),
    { registry: 'localhost:5000', path: 'team/app', tag: 'dev', digest: null },
  );
});

test('parseImageRef rejects garbage', () => {
  for (const ref of ['', '   ', 'noseparator', '/leading']) {
    assert.throws(() => parseImageRef(ref), /Invalid/, `ref=${JSON.stringify(ref)}`);
  }
  // Single-component path is still a valid docker ref (implicit docker.io).
  assert.deepEqual(
    parseImageRef('nodot/app'),
    { registry: 'nodot', path: 'app', tag: null, digest: null },
  );
  assert.throws(() => parseImageRef(null), /Invalid/);
  assert.throws(() => parseImageRef(42), /Invalid/);
});

test('parseImageRef rejects a bad digest in the ref', () => {
  assert.throws(() => parseImageRef('ghcr.io/o/r@sha256:short'), /Invalid digest/);
});

// ---------------------------------------------------------------------------
// isDigestPinned / withDigest
// ---------------------------------------------------------------------------

test('isDigestPinned is true only when a digest is present', () => {
  assert.equal(isDigestPinned(`ghcr.io/o/r@${DIGEST}`), true);
  assert.equal(isDigestPinned(`ghcr.io/o/r:v1@${DIGEST}`), true);
  assert.equal(isDigestPinned('ghcr.io/o/r:v1'), false);
  assert.equal(isDigestPinned('ghcr.io/o/r'), false);
  assert.equal(isDigestPinned('garbage'), false);
  assert.equal(isDigestPinned(''), false);
});

test('withDigest adds a digest to a tag-only ref', () => {
  assert.equal(withDigest('ghcr.io/o/r:latest', DIGEST), `ghcr.io/o/r:latest@${DIGEST}`);
});

test('withDigest replaces an existing digest', () => {
  assert.equal(withDigest(`ghcr.io/o/r:latest@${DIGEST}`, DIGEST_B), `ghcr.io/o/r:latest@${DIGEST_B}`);
});

test('withDigest works on untagged refs', () => {
  assert.equal(withDigest('ghcr.io/o/r', DIGEST), `ghcr.io/o/r@${DIGEST}`);
});

test('withDigest rejects invalid digests', () => {
  assert.throws(() => withDigest('ghcr.io/o/r', 'nope'), /Invalid digest/);
});

// ---------------------------------------------------------------------------
// localStagingTag
// ---------------------------------------------------------------------------

test('localStagingTag is a docker-safe local name', () => {
  assert.equal(
    localStagingTag({ repo: 'AgentCloud', tag: 'latest' }),
    'orca-agent-poc-agentcloud:latest',
  );
});

test('localStagingTag lowercases the repo', () => {
  assert.equal(
    localStagingTag({ repo: 'AgentCloud', tag: 'v1' }),
    'orca-agent-poc-agentcloud:v1',
  );
});

test('localStagingTag rejects bad repo/tag', () => {
  assert.throws(() => localStagingTag({ repo: '', tag: 't' }), /Invalid repo/);
  assert.throws(() => localStagingTag({ repo: 'r', tag: 'bad tag' }), /Invalid tag/);
});

// ---------------------------------------------------------------------------
// promote-flow contract (the exact refs the pipeline will use)
// ---------------------------------------------------------------------------

test('promote flow: GHCR build ref → digest ref → Cloudflare digest ref', () => {
  const owner = 'caocuong2404';
  const repo = 'agentcloud';
  const tag = 'on-demand-wake';
  const accountId = 'f00barbaz123';

  const built = ghcrRef({ owner, repo, tag });
  assert.equal(built, 'ghcr.io/caocuong2404/agentcloud:on-demand-wake');

  const pinned = withDigest(built, DIGEST);
  assert.equal(pinned, `ghcr.io/caocuong2404/agentcloud:on-demand-wake@${DIGEST}`);
  assert.equal(isDigestPinned(pinned), true);

  const cfTag = cloudflareTagRef({ accountId, repo, tag });
  const cfDigest = withDigest(cfTag, DIGEST_B);
  assert.equal(cfDigest, `registry.cloudflare.com/f00barbaz123/agentcloud:on-demand-wake@${DIGEST_B}`);
  assert.equal(isDigestPinned(cfDigest), true);

  // wrangler.jsonc named image must be the Cloudflare digest form.
  const wranglerImage = cloudflareDigestRef({ accountId, repo, digest: DIGEST_B });
  assert.equal(wranglerImage, `registry.cloudflare.com/f00barbaz123/agentcloud@${DIGEST_B}`);
  assert.equal(isDigestPinned(wranglerImage), true);
});

test('GHCR and Cloudflare refs never collide in registry name', () => {
  const ghcr = ghcrRef({ owner: 'caocuong2404', repo: 'agentcloud', tag: 't' });
  const cf = cloudflareTagRef({ accountId: 'acc', repo: 'agentcloud', tag: 't' });
  assert.notEqual(parseImageRef(ghcr).registry, parseImageRef(cf).registry);
  assert.equal(parseImageRef(ghcr).registry, 'ghcr.io');
  assert.equal(parseImageRef(cf).registry, 'registry.cloudflare.com');
});
