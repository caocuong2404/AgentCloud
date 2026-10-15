// Same encoding as orca's pairing code: base64url(JSON payload), schema v2.
// Extracted from supervisor.mjs so the codec can be unit-tested without Docker.

export function encodePairingUrl({ endpoint, deviceToken, publicKeyB64, pairedDeviceId, scope }) {
  const payload = { v: 2, endpoint, deviceToken, publicKeyB64, pairedDeviceId, scope };
  const code = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `orca://pair?code=${code}`;
}

// Returns a plain object payload, or null when the URL is not a pairing code.
// Arrays and JSON primitives are rejected: a pairing payload is always an object.
export function decodePairingUrl(url) {
  try {
    const code = new URL(url).searchParams.get('code');
    if (!code) return null;
    const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
