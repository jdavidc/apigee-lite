'use strict';

class LogBuffer {
  constructor(max = 500) { this.max = max; this.entries = []; this.seq = 0; }
  add(e) {
    this.entries.push({ id: ++this.seq, ts: new Date().toISOString(), ...e });
    if (this.entries.length > this.max) this.entries.shift();
  }
  list(since = 0) { return this.entries.filter((e) => e.id > since); }
  clear() { this.entries = []; }
}

function createState() {
  return { spike: new Map(), quota: new Map(), caches: new Map(), tokens: new Map(), lb: new Map() };
}

const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'expect']);

async function defaultHttpRequest({ method, url, headers = {}, body, timeout = 55000 }) {
  const h = {};
  for (const [k, v] of Object.entries(headers)) if (!HOP.has(k.toLowerCase()) && v != null) h[k] = String(v);
  const opts = { method, headers: h, signal: AbortSignal.timeout(timeout), redirect: 'manual' };
  if (body !== undefined && body !== null && body !== '' && !['GET', 'HEAD'].includes(String(method).toUpperCase())) opts.body = body;
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') { const t = new Error('timeout'); t.code = 'ETIMEDOUT'; throw t; }
    const c = new Error(e.cause ? e.cause.message || String(e.cause) : e.message);
    c.code = e.cause && e.cause.code ? e.cause.code : 'ECONNREFUSED';
    throw c;
  }
  const outHeaders = {};
  res.headers.forEach((v, k) => { outHeaders[k] = v; });
  return { status: res.status, statusText: res.statusText, headers: outHeaders, body: await res.text() };
}

function createServices({ store, env = 'test', httpRequest, getSharedFlow, logs, state, org } = {}) {
  return {
    store,
    env,
    org: org || (store && store.orgName) || 'practice',
    httpRequest: httpRequest || defaultHttpRequest,
    getSharedFlow: getSharedFlow || (() => null),
    logs: logs || new LogBuffer(),
    state: state || createState(),
  };
}

// Resolves a TargetServer-based LoadBalancer into a base URL (round robin over enabled servers).
function resolveLoadBalancer(lb, services, key) {
  const servers = lb.servers
    .map((s) => ({ ...s, ts: services.store.getTargetServer(services.env, s.name) }))
    .filter((s) => s.ts && s.ts.isEnabled !== false);
  const primary = servers.filter((s) => !s.isFallback);
  const pool = primary.length ? primary : servers;
  if (!pool.length) return null;
  const n = services.state.lb.get(key) || 0;
  services.state.lb.set(key, n + 1);
  const ts = pool[n % pool.length].ts;
  const scheme = ts.sSLInfo && ts.sSLInfo.enabled ? 'https' : 'http';
  return `${scheme}://${ts.host}:${ts.port}`;
}

module.exports = { createServices, createState, LogBuffer, defaultHttpRequest, resolveLoadBalancer };
