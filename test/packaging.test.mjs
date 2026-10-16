import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// The container image is assembled only from Dockerfile COPY lines. A module
// imported by supervisor.mjs but never COPY'd dies at boot with exit=1
// (ERR_MODULE_NOT_FOUND) — invisible to unit tests that import the module
// directly. This locks the packaging step.
const containerImports = (file) =>
  [...read(file).matchAll(/from\s+'(\.\/[^']+)'/g)].map((m) => m[1].replace(/^\.\//, ''));

test('Dockerfile copies every module supervisor.mjs transitively imports', () => {
  const dockerfile = read('container/Dockerfile');
  const seen = new Set();
  const queue = ['supervisor.mjs'];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const dep of containerImports(`container/${f}`)) queue.push(dep);
  }
  assert.ok(seen.size > 1, 'supervisor.mjs should have relative imports');

  for (const f of seen) {
    const src = `container/${f}`;
    assert.ok(fs.existsSync(path.join(root, src)), `${src} must exist`);
    const copyRe = new RegExp(`COPY\\s+[^\\n]*\\b${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    assert.match(dockerfile, copyRe, `Dockerfile must COPY ${src} (imported by supervisor.mjs)`);
  }
});

test('every container/ .mjs module reachable from supervisor is in the image', () => {
  // Host-only helpers (image-ref.mjs, pairing.test deps) live alongside the
  // runtime modules; only the transitive closure of supervisor.mjs must ship.
  const dockerfile = read('container/Dockerfile');
  for (const f of ['supervisor.mjs', 'identity.mjs', 'pairing.mjs']) {
    const copyRe = new RegExp(`COPY\\s+[^\\n]*\\bcontainer/${f}\\b`);
    assert.match(dockerfile, copyRe, `Dockerfile must COPY container/${f}`);
  }
});
