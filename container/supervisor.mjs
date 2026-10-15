import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

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

const args = [ 'serve', '--port', String(port), '--project-root', projectRoot,
  '--pairing-address', pairingAddress, '--mobile-pairing' ];
const child = spawn('/opt/orca/squashfs-root/AppRun', args, {
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let recent = '';
const saveOutput = (buffer, source) => {
  const line = buffer.toString('utf8');
  recent = (recent + line).slice(-24000);
  // Avoid printing a mobile pairing token to centralized Container logs.
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
  if (req.url === '/__pairing') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(recent || 'Orca has not printed pairing details yet.');
    return;
  }
  res.writeHead(404); res.end('Not found');
});
server.listen(8080, '0.0.0.0');
process.on('SIGTERM', () => { child.kill('SIGTERM'); setTimeout(() => process.exit(0), 15000).unref(); });
process.on('SIGINT', () => child.kill('SIGINT'));
