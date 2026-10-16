import { DurableObject } from 'cloudflare:workers';
import { reserveUsd, monthKey, budgetAllows, SIZES } from './budget.mjs';

const RUNTIME_PORT = 6768;
const HEALTH_PORT = 8080;
const LEASE_MS = 60 * 60 * 1000;
// This should outlive the lease. The durable alarm forcibly destroys the container.
const INACTIVITY_MS = 90 * 60 * 1000;
// Opaque envelope { filename: base64 } of Orca runtime identity files.
const IDENTITY_KEY = 'identityBundle';

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function authorized(req, token) {
  return Boolean(token && req.headers.get('authorization') === `Bearer ${token}`);
}

export class AgentWorkspace extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    if (ctx.container?.running) {
      void ctx.blockConcurrencyWhile(async () => {
        const lease = await ctx.storage.get('lease');
        if (!lease || lease.expiresAt <= Date.now()) {
          await this.saveIdentity();
          ctx.container.destroy();
          await ctx.storage.delete('lease');
        } else {
          await ctx.container.setInactivityTimeout(INACTIVITY_MS);
          await ctx.storage.setAlarm(lease.expiresAt);
        }
      });
    }
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    try {
      if (path === '/_admin/start' && request.method === 'POST') return await this.start(request);
      if (path === '/_admin/status' && request.method === 'GET') return await this.status();
      if (path === '/_admin/stop' && request.method === 'POST') return await this.stop();
      if (path === '/_admin/pairing' && request.method === 'GET') return await this.pairing();
      if (path.startsWith('/_runtime')) return await this.forward(request);
      return json({ error: 'not_found' }, 404);
    } catch (error) {
      console.error('Workspace error', String(error));
      return json({ error: 'runtime_error', message: String(error) }, 502);
    }
  }

  // Opaque envelope { filename: base64 } written by the supervisor at GET /__identity.
  // Returns true only when a non-empty envelope was stored; never clobbers with {}.
  async saveIdentity() {
    const container = this.ctx.container;
    if (!container?.running) return false;
    try {
      const res = await container.getTcpPort(HEALTH_PORT).fetch('http://container/__identity', {
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) {
        await res.body?.cancel();
        return false;
      }
      const envelope = await res.json();
      if (!envelope || typeof envelope !== 'object' || Object.keys(envelope).length === 0) return false;
      await this.ctx.storage.put(IDENTITY_KEY, envelope);
      return true;
    } catch {
      // Container may still be starting or already gone.
      return false;
    }
  }

  async start(request) {
    const container = this.ctx.container;
    if (!container) return json({ error: 'container_unavailable' }, 500);
    const previous = await this.ctx.storage.get('lease');
    if (container.running) {
      return json({ error: 'already_running', expiresAt: previous?.expiresAt }, 409);
    }
    const { pairingAddress } = await request.json();
    if (typeof pairingAddress !== 'string' || !pairingAddress.startsWith('wss://')) {
      return json({ error: 'invalid_pairing_address' }, 400);
    }
    const size = this.env.INSTANCE_SIZE || 'standard-1';
    if (!SIZES[size]) return json({ error: 'unsupported_instance_size' }, 400);
    const budget = Number(this.env.POC_MONTHLY_RESERVATION_USD || '4');
    if (!Number.isFinite(budget) || budget <= 0 || budget > 4) {
      return json({ error: 'invalid_budget', message: 'POC reservation cap must be between $0 and $4' }, 400);
    }
    const reserve = reserveUsd(size, LEASE_MS / 60000);
    const key = monthKey();
    const used = Number((await this.ctx.storage.get(key)) || 0);
    if (!budgetAllows(used, reserve, budget)) {
      return json({ error: 'budget_guard', reservedUsd: used, nextReservationUsd: reserve, limitUsd: budget }, 429);
    }
    // Reserve before provisioning: failed starts can consume reservation capacity (conservative).
    await this.ctx.storage.put(key, used + reserve);
    const expiresAt = Date.now() + LEASE_MS;
    await this.ctx.storage.put('lease', { expiresAt, size, pairingAddress, startedAt: Date.now() });
    await this.ctx.storage.setAlarm(expiresAt);
    const identity = await this.ctx.storage.get(IDENTITY_KEY);
    const env = {
      ORCA_PAIRING_ADDRESS: pairingAddress,
      ORCA_PROJECT_ROOT: '/workspace',
      ORCA_PORT: String(RUNTIME_PORT),
      WORKSPACE_GIT_URL: this.env.WORKSPACE_GIT_URL || '',
    };
    // Restore prior Orca identity so paired clients survive destroy/start.
    if (identity) env.ORCA_IDENTITY_B64 = btoa(JSON.stringify(identity));
    try {
      container.start({
        image: container.images.base,
        instance: size,
        enableInternet: true,
        env,
      });
      // start() only validates options; monitor() surfaces boot/crash errors in logs.
      this.ctx.waitUntil(
        container.monitor().then(
          () => console.log('container exited cleanly'),
          (err) => console.error('container error:', err && err.exitCode != null ? `exit=${err.exitCode}` : '', String(err)),
        ),
      );
      await container.setInactivityTimeout(INACTIVITY_MS);
      return json({ state: 'starting', size, expiresAt, reservedUsd: reserve, note: 'Poll GET /api/status for ready' }, 202);
    } catch (e) {
      container.destroy();
      await this.ctx.storage.delete('lease');
      await this.ctx.storage.deleteAlarm();
      // Retain the conservative reservation to avoid budget under-accounting.
      throw e;
    }
  }

  async status() {
    const container = this.ctx.container;
    const lease = await this.ctx.storage.get('lease');
    const key = monthKey();
    const reservedUsd = Number((await this.ctx.storage.get(key)) || 0);
    if (!container?.running) return json({ state: 'stopped', lease, reservedUsd, month: key });
    let ready = false;
    try {
      const res = await container.getTcpPort(HEALTH_PORT).fetch('http://container/health', {
        signal: AbortSignal.timeout(1500),
      });
      ready = res.ok;
      await res.body?.cancel();
    } catch { /* Container may still be starting. */ }
    if (ready && lease && (await this.ctx.storage.get('identitySavedAt')) !== lease.startedAt) {
      // Mark done only after a successful harvest so a failed save is retried.
      if (await this.saveIdentity()) await this.ctx.storage.put('identitySavedAt', lease.startedAt);
    }
    return json({ state: ready ? 'ready' : 'starting', lease, reservedUsd, month: key });
  }

  async stop() {
    const running = Boolean(this.ctx.container?.running);
    if (running) await this.saveIdentity();
    if (running) this.ctx.container.destroy();
    await this.ctx.storage.delete('lease');
    await this.ctx.storage.deleteAlarm();
    return json({ state: 'stopped', destroyed: running });
  }

  async pairing() {
    if (!this.ctx.container?.running) return json({ error: 'not_running' }, 409);
    const res = await this.ctx.container.getTcpPort(HEALTH_PORT).fetch('http://container/__pairing', {
      signal: AbortSignal.timeout(2500),
    });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  async forward(request) {
    if (!this.ctx.container?.running) return json({ error: 'stopped', message: 'Start through authenticated API' }, 503);
    const lease = await this.ctx.storage.get('lease');
    if (!lease || lease.expiresAt <= Date.now()) return json({ error: 'lease_expired' }, 503);
    const original = new URL(request.url);
    const proxiedUrl = new URL(original);
    proxiedUrl.protocol = 'http:';
    proxiedUrl.host = 'container';
    // Remove the Worker-only route prefix. Pass through Orca's original query and subpaths.
    proxiedUrl.pathname = original.pathname.slice('/_runtime'.length) || '/';
    const forwarded = new Request(proxiedUrl, request);
    forwarded.headers.delete('host');
    return this.ctx.container.getTcpPort(RUNTIME_PORT).fetch(forwarded);
  }

  async alarm() {
    const lease = await this.ctx.storage.get('lease');
    if (!lease) {
      if (this.ctx.container?.running) await this.saveIdentity();
      if (this.ctx.container?.running) this.ctx.container.destroy();
      return;
    }
    if (Date.now() < lease.expiresAt) {
      await this.ctx.storage.setAlarm(lease.expiresAt);
      return;
    }
    if (this.ctx.container?.running) await this.saveIdentity();
    if (this.ctx.container?.running) this.ctx.container.destroy();
    await this.ctx.storage.delete('lease');
    console.log('POC lease expired: Container destroyed to bound spend');
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.CONTROL_TOKEN || !env.CONNECT_TOKEN) {
      return json({ error: 'missing_secrets', message: 'Configure CONTROL_TOKEN and CONNECT_TOKEN before use' }, 503);
    }
    const binding = env.AGENT_WORKSPACE.getByName('poc-single-workspace');
    const connectPrefix = `/connect/${env.CONNECT_TOKEN}`;
    if (url.pathname === connectPrefix || url.pathname.startsWith(`${connectPrefix}/`)) {
      const inner = new URL(request.url);
      inner.pathname = '/_runtime' + (url.pathname.slice(connectPrefix.length) || '/');
      return binding.fetch(new Request(inner, request));
    }
    if (!authorized(request, env.CONTROL_TOKEN)) return json({ error: 'unauthorized' }, 401);
    if (url.pathname === '/api/start' && request.method === 'POST') {
      const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const pairingAddress = `${scheme}//${url.host}${connectPrefix}`;
      return binding.fetch(new Request('http://internal/_admin/start', {
        method: 'POST',
        body: JSON.stringify({ pairingAddress }),
        headers: { 'content-type': 'application/json' },
      }));
    }
    const routes = {
      'GET /api/status': '/_admin/status',
      'POST /api/stop': '/_admin/stop',
      'GET /api/pairing': '/_admin/pairing',
    };
    const route = routes[`${request.method} ${url.pathname}`];
    if (route) return binding.fetch(new Request(`http://internal${route}`, { method: request.method }));
    return json({ error: 'not_found' }, 404);
  },
};
