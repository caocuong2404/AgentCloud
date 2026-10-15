import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { packIdentity, unpackIdentity, decodeIdentityEnv } from './identity.mjs';

const port = Number(process.env.ORCA_PORT || '6768');
const projectRoot = process.env.ORCA_PROJECT_ROOT || '/workspace';
const pairingAddress = process.env.ORCA_PAIRING_ADDRESS;
if (!pairingAddress) {
  console.error('Missing ORCA_PAIRING_ADDRESS');
  process.exit(2);
}
fs.mkdirSync(projectRoot, { recursive: true });
if (fs.readdirSync(projectRoot).length === 0) {
  fs.writeFileSync(`${projectRoot}/POC-README.md`,
    '# Orca Cloudflare POC\n\nEphemeral workspace. Commit and push any code before stopping.\n',
    { flag: 'wx' });
}

// A public Git repository is optional; private Git credentials are intentionally not supported in v0.
if (process.env.WORKSPACE_GIT_URL) {
  const url = new URL(process.env.WORKSPACE_GIT_URL);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('WORKSPACE_GIT_URL must be HTTPS without embedded credentials');
  }
  if (fs.readdirSync(projectRoot).length > 1) {
    console.warn('Workspace not empty; skipping initial Git clone');
  } else {
    fs.rmSync(`${projectRoot}/POC-README.md`, { force: true });
    const child = spawn('git', ['clone', '--depth', '1', url.toString(), projectRoot], { stdio: 'inherit' });
    await new Promise((resolve, reject) => child.on('exit', code => code === 0 ? resolve() : reject(new Error(`git clone failed ${code}`))));
  }
}

// Orca keeps one pairing URL per pending device (scope: runtime | mobile).
// `orca serve` mints only one at startup; we pre-seed the other scope and mint its URL here.
const userDataPath = process.env.ORCA_USER_DATA_PATH
  || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'orca');
const devicesPath = path.join(userDataPath, 'orca-devices.json');

const pendingDevice = (name, scope, grants) => ({
  deviceId: crypto.randomUUID(),
  name,
  token: crypto.randomBytes(24).toString('hex'),
  scope,
  pairedAt: Date.now(),
  lastSeenAt: 0,
  pairingReach: 'network',
  ...(grants?.length ? { grants } : {}),
});

// Same encoding as orca's pairing code: base64url(JSON payload), schema v2.
const encodePairingUrl = ({ endpoint, deviceToken, publicKeyB64, pairedDeviceId, scope }) => {
  const payload = { v: 2, endpoint, deviceToken, publicKeyB64, pairedDeviceId, scope };
  const code = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `orca://pair?code=${code}`;
};

const decodePairingUrl = (url) => {
  try {
    const code = new URL(url).searchParams.get('code');
    const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch { return null; }
};

{
  const sample = { endpoint: 'wss://x', deviceToken: 't', publicKeyB64: 'k', pairedDeviceId: 'd', scope: 'mobile' };
  const roundtrip = decodePairingUrl(encodePairingUrl(sample));
  if (!roundtrip || roundtrip.scope !== 'mobile' || roundtrip.deviceToken !== 't') {
    console.error('pairing URL codec self-check failed');
    process.exit(3);
  }
}

fs.mkdirSync(userDataPath, { recursive: true });
// Restore pairing identity from a previous boot so paired clients (e.g. cf-1) stay valid.
if (process.env.ORCA_IDENTITY_B64) {
  const envelope = decodeIdentityEnv(process.env.ORCA_IDENTITY_B64);
  const { restored } = unpackIdentity(userDataPath, envelope);
  if (restored.length) console.error(`Restored identity: ${restored.join(', ')}`);
}
let devices = [];
if (fs.existsSync(devicesPath)) {
  try { devices = JSON.parse(fs.readFileSync(devicesPath, 'utf8')); } catch { devices = []; }
}
const pending = (scope) => devices.find(d => d.lastSeenAt === 0 && d.scope === scope);
const runtimeDevice = pending('runtime') || pendingDevice('CLI POC', 'runtime', ['desktop-control']);
const mobileDevice = pending('mobile') || pendingDevice('Mobile POC', 'mobile');
if (!pending('runtime')) devices.push(runtimeDevice);
if (!pending('mobile')) devices.push(mobileDevice);
fs.writeFileSync(devicesPath, JSON.stringify(devices, null, 2));

// both|runtime: desktop via `orca environment add` (+ desktop-control grant).
// mobile: QR/link for Orca Mobile (mutually exclusive with --grant-desktop-control).
const pairingMode = (process.env.ORCA_PAIRING_MODE || 'both').toLowerCase();
const args = [ 'serve', '--port', String(port), '--project-root', projectRoot,
  '--pairing-address', pairingAddress, '--json' ];
if (pairingMode === 'mobile') args.push('--mobile-pairing');
else args.push('--grant-desktop-control');

const child = spawn('/opt/orca/squashfs-root/AppRun', args, {
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let recent = '';
let pairingInfo = null;
const saveOutput = (buffer, source) => {
  const line = buffer.toString('utf8');
  recent = (recent + line).slice(-24000);
  const jsonLine = line.split('\n').find(l => l.startsWith('{') && l.includes('orca_server_ready'));
  if (jsonLine) {
    try { pairingInfo = JSON.parse(jsonLine).pairing ?? pairingInfo; } catch {}
  }
  // Avoid printing a pairing token to centralized Container logs.
  if (/error|fatal|failed|sigsegv/i.test(line)) {
    console.error(`${source}:`, line.replace(/(orca:\/\/|wss?:\/\/)[^\s]+/gi, '[redacted-link]'));
  }
};
child.stdout.on('data', chunk => saveOutput(chunk, 'stdout'));
child.stderr.on('data', chunk => saveOutput(chunk, 'stderr'));
child.on('error', err => console.error('Orca launch failed:', err.message));
child.on('exit', (code, signal) => {
  console.error(`Orca runtime exited (code ${code}, signal ${signal})`);
  server.close();
  process.exit(typeof code === 'number' ? code : 0);
});

// Both URLs once orca has minted the startup offer (gives us endpoint + publicKeyB64).
const bothPairingUrls = () => {
  const fromOrca = pairingInfo?.url ? decodePairingUrl(pairingInfo.url) : null;
  const endpoint = fromOrca?.endpoint || pairingAddress;
  const publicKeyB64 = fromOrca?.publicKeyB64;
  const offers = {};
  if (pairingInfo?.url) {
    offers[pairingInfo.scope === 'mobile' ? 'mobile' : 'runtime'] = pairingInfo.url;
  }
  if (publicKeyB64) {
    const other = pairingMode === 'mobile' ? 'runtime' : 'mobile';
    if (!offers[other]) {
      const dev = other === 'mobile' ? mobileDevice : runtimeDevice;
      offers[other] = encodePairingUrl({
        endpoint, deviceToken: dev.token, publicKeyB64,
        pairedDeviceId: dev.deviceId, scope: other,
      });
    }
  }
  return offers;
};

const ready = () => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.setTimeout(750);
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
  socket.once('timeout', () => { socket.destroy(); resolve(false); });
});
const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    const isReady = await ready();
    res.writeHead(isReady ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ready: isReady, pid: child.pid }));
    return;
  }
  if (req.url === '/__identity') {
    const envelope = packIdentity(userDataPath);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(envelope));
    return;
  }
  if (req.url === '/__pairing') {
    const offers = bothPairingUrls();
    const lines = [
      ...Object.entries(offers).map(([scope, url]) => `${scope} pairing URL: ${url}`),
      recent || 'Orca has not printed pairing details yet.',
    ];
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(lines.join('\n'));
    return;
  }
  res.writeHead(404); res.end('Not found');
});
server.listen(8080, '0.0.0.0');
process.on('SIGTERM', () => { child.kill('SIGTERM'); setTimeout(() => process.exit(0), 15000).unref(); });
process.on('SIGINT', () => child.kill('SIGINT'));
