import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  packIdentity, unpackIdentity, encodeIdentityEnv, decodeIdentityEnv, IDENTITY_FILES,
} from '../container/identity.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orca-id-'));
const write = (dir, name, data) => fs.writeFileSync(path.join(dir, name), data);

// ---------------------------------------------------------------------------
// IDENTITY_FILES contract
// ---------------------------------------------------------------------------

test('IDENTITY_FILES covers the three runtime identity artifacts', () => {
  assert.deepEqual(IDENTITY_FILES, [
    'orca-devices.json',
    'orca-e2ee-keypair.json',
    'agent-session-authority.key',
  ]);
});

test('IDENTITY_FILES is a frozen-stable export (callers iterate it)', () => {
  assert.ok(Array.isArray(IDENTITY_FILES));
  assert.equal(IDENTITY_FILES.length, 3);
  for (const name of IDENTITY_FILES) assert.equal(typeof name, 'string');
});

// ---------------------------------------------------------------------------
// packIdentity
// ---------------------------------------------------------------------------

test('pack/unpack round-trips present files byte-for-byte', () => {
  const a = tmp();
  const b = tmp();
  write(a, 'orca-devices.json', '[{"token":"abc"}]');
  write(a, 'orca-e2ee-keypair.json', '{"k":1}');
  const env = packIdentity(a);
  assert.deepEqual(Object.keys(env).sort(), ['orca-devices.json', 'orca-e2ee-keypair.json']);
  const { restored } = unpackIdentity(b, env);
  assert.deepEqual(restored.sort(), ['orca-devices.json', 'orca-e2ee-keypair.json']);
  assert.equal(fs.readFileSync(path.join(b, 'orca-devices.json'), 'utf8'), '[{"token":"abc"}]');
  assert.equal(fs.readFileSync(path.join(b, 'orca-e2ee-keypair.json'), 'utf8'), '{"k":1}');
  assert.equal(fs.existsSync(path.join(b, 'agent-session-authority.key')), false);
});

test('pack round-trips all three identity files', () => {
  const a = tmp();
  const b = tmp();
  write(a, 'orca-devices.json', 'devices');
  write(a, 'orca-e2ee-keypair.json', 'keys');
  write(a, 'agent-session-authority.key', Buffer.from([0, 1, 2, 255]));
  const env = packIdentity(a);
  assert.deepEqual(Object.keys(env).sort(), [...IDENTITY_FILES].sort());
  unpackIdentity(b, env);
  assert.equal(fs.readFileSync(path.join(b, 'agent-session-authority.key')).compare(Buffer.from([0, 1, 2, 255])), 0);
});

test('pack preserves binary bytes exactly', () => {
  const a = tmp();
  const b = tmp();
  const binary = Buffer.from([0, 1, 2, 127, 128, 255, 0]);
  write(a, 'agent-session-authority.key', binary);
  unpackIdentity(b, packIdentity(a));
  assert.deepEqual(fs.readFileSync(path.join(b, 'agent-session-authority.key')), binary);
});

test('pack preserves empty files as present-but-empty', () => {
  const a = tmp();
  const b = tmp();
  write(a, 'orca-devices.json', '');
  const env = packIdentity(a);
  assert.ok('orca-devices.json' in env, 'empty file still packed');
  const { restored } = unpackIdentity(b, env);
  // Empty base64 string is falsy for unpack; this documents current behaviour.
  assert.deepEqual(restored, [], 'empty content is not restored');
});

test('pack of an empty directory yields an empty envelope', () => {
  assert.deepEqual(packIdentity(tmp()), {});
});

test('pack omits missing files; unpack ignores unknown keys', () => {
  const a = tmp();
  write(a, 'agent-session-authority.key', Buffer.from([1, 2, 3]));
  const env = packIdentity(a);
  assert.deepEqual(Object.keys(env), ['agent-session-authority.key']);
  const b = tmp();
  env.evil = 'nope';
  env['../escape'] = 'nope';
  unpackIdentity(b, env);
  assert.equal(fs.existsSync(path.join(b, 'evil')), false);
  assert.equal(fs.existsSync(path.join(b, '../escape')), false);
  assert.deepEqual(fs.readFileSync(path.join(b, 'agent-session-authority.key')), Buffer.from([1, 2, 3]));
});

test('unpack creates the userData directory when missing', () => {
  const nested = path.join(tmp(), 'deeply', 'nested', 'orca');
  const env = { 'orca-devices.json': Buffer.from('[]').toString('base64') };
  const { restored } = unpackIdentity(nested, env);
  assert.deepEqual(restored, ['orca-devices.json']);
  assert.equal(fs.readFileSync(path.join(nested, 'orca-devices.json'), 'utf8'), '[]');
});

test('unpack overwrites existing files with the restored bytes', () => {
  const dir = tmp();
  write(dir, 'orca-devices.json', 'stale');
  unpackIdentity(dir, { 'orca-devices.json': Buffer.from('fresh').toString('base64') });
  assert.equal(fs.readFileSync(path.join(dir, 'orca-devices.json'), 'utf8'), 'fresh');
});

test('unpack skips non-string and empty values without throwing', () => {
  const dir = tmp();
  const env = {
    'orca-devices.json': 12345,
    'orca-e2ee-keypair.json': { nested: true },
    'agent-session-authority.key': '',
    'other.json': Buffer.from('x').toString('base64'),
  };
  const { restored } = unpackIdentity(dir, env);
  assert.deepEqual(restored, []);
  assert.equal(fs.existsSync(path.join(dir, 'orca-devices.json')), false);
});

test('unpack with null/undefined/non-object envelope is a no-op', () => {
  const b = tmp();
  assert.deepEqual(unpackIdentity(b, null).restored, []);
  assert.deepEqual(unpackIdentity(b, undefined).restored, []);
  assert.deepEqual(unpackIdentity(b, 'str').restored, []);
  assert.deepEqual(unpackIdentity(b, 42).restored, []);
});

// ---------------------------------------------------------------------------
// encode/decode identity env
// ---------------------------------------------------------------------------

test('encode/decode identity env round-trip', () => {
  const env = {
    'orca-devices.json': Buffer.from('x').toString('base64'),
    'agent-session-authority.key': Buffer.from([9, 8, 7]).toString('base64'),
  };
  const decoded = decodeIdentityEnv(encodeIdentityEnv(env));
  assert.deepEqual(decoded, env);
});

test('encode/decode round-trips an empty envelope object', () => {
  assert.deepEqual(decodeIdentityEnv(encodeIdentityEnv({})), {});
});

test('decode rejects empty, non-base64, and non-JSON inputs', () => {
  assert.equal(decodeIdentityEnv(''), null);
  assert.equal(decodeIdentityEnv('!!!not-b64-json'), null);
  assert.equal(decodeIdentityEnv('bm90IGpzb24='), null); // "not json"
  assert.equal(decodeIdentityEnv('bnVsbA=='), null); // "null"
  assert.equal(decodeIdentityEnv('dHJ1ZQ=='), null); // "true"
  assert.equal(decodeIdentityEnv('IjN1Ig=='), null); // "\"3\""
});

test('decode rejects JSON arrays (envelope must be a plain object)', () => {
  assert.equal(decodeIdentityEnv(Buffer.from('[1,2]').toString('base64')), null);
  assert.equal(decodeIdentityEnv(Buffer.from('[{"a":1}]').toString('base64')), null);
});

test('decode rejects nullish/unknown env values', () => {
  assert.equal(decodeIdentityEnv(undefined), null);
  assert.equal(decodeIdentityEnv(null), null);
  assert.equal(decodeIdentityEnv(123), null);
});

test('decode accepts object-shaped envelopes with extra keys', () => {
  const env = { 'orca-devices.json': 'YQ==', extra: 'Yg==' };
  assert.deepEqual(decodeIdentityEnv(encodeIdentityEnv(env)), env);
});

test('empty-envelope guard: only non-empty objects are storable identity', () => {
  // Mirrors the saveIdentity() contract in src/index.js: never clobber with {}.
  const storable = (envelope) => Boolean(
    envelope && typeof envelope === 'object' && !Array.isArray(envelope) && Object.keys(envelope).length > 0
  );
  assert.equal(storable({}), false);
  assert.equal(storable({ a: 'YQ==' }), true);
  assert.equal(storable(null), false);
  assert.equal(storable([]), false);
  assert.equal(storable('x'), false);
});

test('high-volume token content survives pack/unpack unchanged', () => {
  const a = tmp();
  const b = tmp();
  const devices = JSON.stringify(
    Array.from({ length: 50 }, (_, i) => ({
      deviceId: crypto.randomUUID(),
      token: crypto.randomBytes(24).toString('hex'),
      scope: i % 2 ? 'mobile' : 'runtime',
    }))
  );
  write(a, 'orca-devices.json', devices);
  unpackIdentity(b, packIdentity(a));
  assert.equal(fs.readFileSync(path.join(b, 'orca-devices.json'), 'utf8'), devices);
});
