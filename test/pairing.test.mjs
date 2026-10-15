import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePairingUrl, decodePairingUrl } from '../container/pairing.mjs';

const sample = {
  endpoint: 'wss://example.test/connect/token',
  deviceToken: 'a'.repeat(48),
  publicKeyB64: 'PK==',
  pairedDeviceId: '0dee1726-0000-4000-8000-000000000001',
  scope: 'runtime',
};

const b64url = (payload) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const urlOf = (payload) => `orca://pair?code=${b64url(payload)}`;

// ---------------------------------------------------------------------------
// round-trip
// ---------------------------------------------------------------------------

test('encode/decode round-trips a full runtime payload', () => {
  const url = encodePairingUrl(sample);
  assert.ok(url.startsWith('orca://pair?code='));
  const out = decodePairingUrl(url);
  assert.deepEqual(out, { v: 2, ...sample });
});

test('encode/decode round-trips mobile scope', () => {
  const url = encodePairingUrl({ ...sample, scope: 'mobile' });
  const out = decodePairingUrl(url);
  assert.equal(out.scope, 'mobile');
  assert.equal(out.v, 2);
  assert.equal(out.deviceToken, sample.deviceToken);
});

test('encode/decode round-trips both scopes independently', () => {
  for (const scope of ['runtime', 'mobile']) {
    const out = decodePairingUrl(encodePairingUrl({ ...sample, scope }));
    assert.equal(out.scope, scope);
  }
});

test('round-trip preserves every field verbatim', () => {
  const payload = {
    endpoint: 'wss://edge.example/connect/abc-def',
    deviceToken: 'tok_' + 'z'.repeat(64),
    publicKeyB64: 'LS0tLS1CRUdJTiBQVUJMSUM=',
    pairedDeviceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    scope: 'runtime',
  };
  assert.deepEqual(decodePairingUrl(encodePairingUrl(payload)), { v: 2, ...payload });
});

// ---------------------------------------------------------------------------
// base64url encoding rules
// ---------------------------------------------------------------------------

test('code is base64url: no +, /, or = padding', () => {
  const url = encodePairingUrl({ ...sample, deviceToken: '???+++/===' , publicKeyB64: 'ÿ' });
  const code = new URL(url).searchParams.get('code');
  assert.ok(!code.includes('+'), 'no + in code');
  assert.ok(!code.includes('/'), 'no / in code');
  assert.ok(!code.endsWith('='), 'no = padding');
  // Round-trip still recovers the tricky values.
  const out = decodePairingUrl(url);
  assert.equal(out.deviceToken, '???+++/===');
  assert.equal(out.publicKeyB64, 'ÿ');
});

test('unicode values survive the codec', () => {
  const url = encodePairingUrl({ ...sample, pairedDeviceId: 'thiết-bị-📱' });
  assert.equal(decodePairingUrl(url).pairedDeviceId, 'thiết-bị-📱');
});

test('long tokens survive the codec', () => {
  const longToken = 'x'.repeat(4096);
  const out = decodePairingUrl(encodePairingUrl({ ...sample, deviceToken: longToken }));
  assert.equal(out.deviceToken, longToken);
});

test('url-safe characters in fields do not corrupt the code', () => {
  const tricky = { ...sample, deviceToken: 'a?b&c#d=e+f/g' };
  const out = decodePairingUrl(encodePairingUrl(tricky));
  assert.equal(out.deviceToken, 'a?b&c#d=e+f/g');
});

// ---------------------------------------------------------------------------
// decode accepts standard base64 too
// ---------------------------------------------------------------------------

test('decode accepts standard base64 (+ / =) input as well as base64url', () => {
  const std = Buffer.from(JSON.stringify({ v: 2, ...sample }), 'utf8').toString('base64');
  assert.deepEqual(decodePairingUrl(`orca://pair?code=${std}`), { v: 2, ...sample });
});

test('decode accepts mixed padding variants', () => {
  const obj = { v: 2, endpoint: 'wss://x' };
  const raw = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
  const stripped = raw.replace(/=+$/, '');
  assert.deepEqual(decodePairingUrl(`orca://pair?code=${raw}`), obj);
  assert.deepEqual(decodePairingUrl(`orca://pair?code=${stripped}`), obj);
});

// ---------------------------------------------------------------------------
// decode rejects non-pairing URLs
// ---------------------------------------------------------------------------

test('decode returns null for non-pairing URLs', () => {
  assert.equal(decodePairingUrl('https://example.test/'), null);
  assert.equal(decodePairingUrl('orca://pair'), null);
  assert.equal(decodePairingUrl('orca://pair?code='), null);
  assert.equal(decodePairingUrl('orca://pair?other=1'), null);
  assert.equal(decodePairingUrl('not a url'), null);
});

test('decode returns null for malformed code values', () => {
  assert.equal(decodePairingUrl('orca://pair?code=!!!'), null);
  assert.equal(decodePairingUrl('orca://pair?code=aaaa'), null); // not JSON
  assert.equal(decodePairingUrl('orca://pair?code=%'), null);
});

test('decode accepts empty JSON object (codec is schema-agnostic)', () => {
  // "{}" is a valid JSON object; field presence is the caller's concern.
  // encodePairingUrl never emits this because it always stamps v:2.
  assert.deepEqual(decodePairingUrl(urlOf({})), {});
  assert.notEqual(decodePairingUrl(urlOf({})), null);
});

test('decode returns null for non-object JSON payloads', () => {
  for (const payload of ['123', 'true', 'false', 'null', '"str"']) {
    const code = Buffer.from(payload, 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    assert.equal(decodePairingUrl(`orca://pair?code=${code}`), null, `payload ${payload}`);
  }
});

test('decode returns null for JSON array payloads', () => {
  for (const payload of ['[]', '[1,2]', '[{"a":1}]']) {
    const code = Buffer.from(payload, 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    assert.equal(decodePairingUrl(`orca://pair?code=${code}`), null, `payload ${payload}`);
  }
});

test('decode ignores unrelated query params and hash fragments', () => {
  const url = encodePairingUrl(sample);
  const withExtra = `${url}&foo=bar#frag`;
  assert.deepEqual(decodePairingUrl(withExtra), { v: 2, ...sample });
});

// ---------------------------------------------------------------------------
// shape of the payload
// ---------------------------------------------------------------------------

test('missing fields do not throw; they arrive undefined', () => {
  const url = encodePairingUrl({ endpoint: 'wss://x' });
  const out = decodePairingUrl(url);
  assert.equal(out.endpoint, 'wss://x');
  assert.equal(out.deviceToken, undefined);
  assert.equal(out.v, 2);
});

test('schema version is pinned to 2', () => {
  const out = decodePairingUrl(encodePairingUrl(sample));
  assert.equal(out.v, 2);
  const keys = Object.keys(out).sort();
  assert.deepEqual(keys, ['deviceToken', 'endpoint', 'pairedDeviceId', 'publicKeyB64', 'scope', 'v']);
});

test('encode always stamps v:2 regardless of caller input', () => {
  const out = decodePairingUrl(encodePairingUrl({ ...sample, v: 99 }));
  assert.equal(out.v, 2, 'caller-supplied v is overwritten');
});

test('encode accepts empty object and still stamps v:2', () => {
  const out = decodePairingUrl(encodePairingUrl({}));
  assert.equal(out.v, 2);
  assert.equal(out.endpoint, undefined);
});

test('payload key order is deterministic (stable codecs)', () => {
  const a = JSON.stringify(decodePairingUrl(encodePairingUrl(sample)));
  const b = JSON.stringify(decodePairingUrl(encodePairingUrl(sample)));
  assert.equal(a, b);
});

test('scope is passed through without validation (forward compatible)', () => {
  for (const scope of ['runtime', 'mobile', 'future-scope', '']) {
    assert.equal(decodePairingUrl(encodePairingUrl({ ...sample, scope })).scope, scope);
  }
});

test('endpoint with wss path and token survives', () => {
  const endpoint = 'wss://agent.example.com/connect/CONNECT_TOKEN_VALUE';
  const out = decodePairingUrl(encodePairingUrl({ ...sample, endpoint }));
  assert.equal(out.endpoint, endpoint);
});

test('falsy-but-present fields survive (empty strings, 0)', () => {
  const payload = { ...sample, deviceToken: '', publicKeyB64: '', pairedDeviceId: '' };
  const out = decodePairingUrl(encodePairingUrl(payload));
  assert.equal(out.deviceToken, '');
  assert.equal(out.publicKeyB64, '');
  assert.equal(out.pairedDeviceId, '');
});

test('supervisor self-check shape still round-trips (contract lock)', () => {
  // This is the exact self-check performed at supervisor boot.
  const s = { endpoint: 'wss://x', deviceToken: 't', publicKeyB64: 'k', pairedDeviceId: 'd', scope: 'mobile' };
  const roundtrip = decodePairingUrl(encodePairingUrl(s));
  assert.ok(roundtrip);
  assert.equal(roundtrip.scope, 'mobile');
  assert.equal(roundtrip.deviceToken, 't');
  assert.equal(roundtrip.v, 2);
});
