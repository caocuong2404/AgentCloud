import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  packIdentity, unpackIdentity, encodeIdentityEnv, decodeIdentityEnv, IDENTITY_FILES,
} from '../container/identity.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orca-id-'));

test('pack/unpack round-trips present files', () => {
  const a = tmp();
  const b = tmp();
  fs.writeFileSync(path.join(a, 'orca-devices.json'), '[{"token":"abc"}]');
  fs.writeFileSync(path.join(a, 'orca-e2ee-keypair.json'), '{"k":1}');
  const env = packIdentity(a);
  assert.deepEqual(Object.keys(env).sort(), ['orca-devices.json', 'orca-e2ee-keypair.json']);
  const { restored } = unpackIdentity(b, env);
  assert.deepEqual(restored.sort(), ['orca-devices.json', 'orca-e2ee-keypair.json']);
  assert.equal(fs.readFileSync(path.join(b, 'orca-devices.json'), 'utf8'), '[{"token":"abc"}]');
  assert.equal(fs.existsSync(path.join(b, 'agent-session-authority.key')), false);
});

test('pack omits missing files; unpack ignores unknown keys', () => {
  const a = tmp();
  fs.writeFileSync(path.join(a, 'agent-session-authority.key'), Buffer.from([1, 2, 3]));
  const env = packIdentity(a);
  assert.deepEqual(Object.keys(env), ['agent-session-authority.key']);
  const b = tmp();
  env.evil = 'nope';
  unpackIdentity(b, env);
  assert.equal(fs.existsSync(path.join(b, 'evil')), false);
  assert.deepEqual(fs.readFileSync(path.join(b, 'agent-session-authority.key')), Buffer.from([1, 2, 3]));
});

test('encode/decode identity env round-trip', () => {
  const env = { 'orca-devices.json': Buffer.from('x').toString('base64') };
  const decoded = decodeIdentityEnv(encodeIdentityEnv(env));
  assert.deepEqual(decoded, env);
  assert.equal(decodeIdentityEnv(''), null);
  assert.equal(decodeIdentityEnv('!!!not-b64-json'), null);
});

test('unpack with null envelope is a no-op', () => {
  const b = tmp();
  assert.deepEqual(unpackIdentity(b, null).restored, []);
  assert.deepEqual(unpackIdentity(b, 'str').restored, []);
});

test('IDENTITY_FILES covers the three runtime identity artifacts', () => {
  assert.deepEqual(IDENTITY_FILES, [
    'orca-devices.json',
    'orca-e2ee-keypair.json',
    'agent-session-authority.key',
  ]);
});
