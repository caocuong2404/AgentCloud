import fs from 'node:fs';
import path from 'node:path';

// Orca runtime identity envelope: filename -> base64 of raw bytes.
// Restored across container.destroy()/start() so paired devices keep working.

export const IDENTITY_FILES = [
  'orca-devices.json',
  'orca-e2ee-keypair.json',
  'agent-session-authority.key',
];

export function packIdentity(userDataPath) {
  const out = {};
  for (const name of IDENTITY_FILES) {
    try {
      out[name] = fs.readFileSync(path.join(userDataPath, name)).toString('base64');
    } catch {
      // Missing files stay absent; first boot has none.
    }
  }
  return out;
}

export function unpackIdentity(userDataPath, envelope) {
  if (!envelope || typeof envelope !== 'object') return { restored: [] };
  fs.mkdirSync(userDataPath, { recursive: true });
  const restored = [];
  for (const name of IDENTITY_FILES) {
    const b64 = envelope[name];
    if (typeof b64 !== 'string' || !b64) continue;
    fs.writeFileSync(path.join(userDataPath, name), Buffer.from(b64, 'base64'));
    restored.push(name);
  }
  return { restored };
}

export function encodeIdentityEnv(envelope) {
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
}

// Envelope is a plain object mapping filename -> base64. Arrays and JSON
// primitives are rejected so an empty/invalid env can never clobber identity.
export function decodeIdentityEnv(b64) {
  if (typeof b64 !== 'string' || !b64) return null;
  try {
    const parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
