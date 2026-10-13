'use strict';
const { loadBundle } = require('./bundle-loader');
const { executeProxy } = require('./flow-executor');
const { createServices, createState, LogBuffer, defaultHttpRequest } = require('./services');
const { TraceStore } = require('./trace');
const { HttpError, KINDS } = require('../store/org-store');

// Holds deployed bundles per environment and executes gateway traffic against them.
class Runtime {
  constructor({ store, httpRequest } = {}) {
    this.store = store;
    this.httpRequest = httpRequest || defaultHttpRequest;
    this.logs = new LogBuffer(1000);
    this.state = createState();
    this.traces = new TraceStore(50);
    this.stats = new Map();
    this.deployed = {};
    for (const env of store.org.environments) this.deployed[env] = { apis: {}, sharedflows: {} };
  }

  loadAll() {
    for (const env of this.store.org.environments) {
      const d = this.store.getDeployments(env);
      for (const kind of ['sharedflows', 'apis']) {
        for (const [name, rev] of Object.entries(d[kind])) {
          try { this.deployed[env][kind][name] = this.load(kind, name, rev); } catch (e) {
            this.logs.add({ source: 'deploy', env, proxy: name, message: `Failed to load ${kind}/${name} r${rev}: ${e.message}` });
          }
        }
      }
    }
  }

  load(kind, name, rev) {
    const files = this.store.readBundle(kind, name, rev);
    const bundle = loadBundle(files, KINDS[kind]);
    bundle.revision = String(rev);
    if (bundle.errors.length) {
      const e = new HttpError(400, `Deployment of ${name} revision ${rev} failed: ${bundle.errors.map((x) => `${x.file}: ${x.message}`).join('; ')}`);
      e.errors = bundle.errors;
      throw e;
    }
    return bundle;
  }

  deploy(env, kind, name, rev) {
    this.store.checkEnv(env);
    const bundle = this.load(kind, name, rev);
    if (kind === 'apis') {
      for (const pe of Object.values(bundle.proxyEndpoints)) {
        for (const [other, ob] of Object.entries(this.deployed[env].apis)) {
          if (other === name) continue;
          if (Object.values(ob.proxyEndpoints).some((x) => x.basePath === pe.basePath)) {
            throw new HttpError(409, `Path ${pe.basePath} conflicts with existing deployment path for revision ${ob.revision} of the APIProxy ${other} in environment ${env}`);
          }
        }
      }
    }
    this.deployed[env][kind][name] = bundle;
    this.store.setDeployment(env, kind, name, rev);
    this.logs.add({ source: 'deploy', env, proxy: name, message: `Deployed ${kind === 'apis' ? 'API proxy' : 'shared flow'} ${name} revision ${rev} to ${env}` });
    return { environment: env, name, revision: String(rev), state: 'deployed', warnings: bundle.warnings };
  }

  undeploy(env, kind, name) {
    this.store.checkEnv(env);
    if (!this.deployed[env][kind][name]) throw new HttpError(404, `${name} is not deployed to ${env}`);
    delete this.deployed[env][kind][name];
    this.store.setDeployment(env, kind, name, null);
    this.logs.add({ source: 'deploy', env, proxy: name, message: `Undeployed ${name} from ${env}` });
  }

  // Hot-redeploys a revision after it is saved in place.
  refresh(kind, name, rev) {
    const results = [];
    for (const env of Object.keys(this.deployed)) {
      const b = this.deployed[env][kind][name];
      if (b && b.revision === String(rev)) results.push(this.deploy(env, kind, name, rev));
    }
    return results;
  }

  resolve(env, path) {
    let best = null;
    for (const bundle of Object.values(this.deployed[env] ? this.deployed[env].apis : {})) {
      for (const pe of Object.values(bundle.proxyEndpoints)) {
        const bp = pe.basePath;
        const ok = bp === '/' || path === bp || path.startsWith(bp + '/');
        if (ok && (!best || bp.length > best.pe.basePath.length)) best = { bundle, pe };
      }
    }
    return best;
  }

  servicesFor(env) {
    return createServices({
      store: this.store, env, httpRequest: this.httpRequest, logs: this.logs, state: this.state,
      getSharedFlow: (n) => this.deployed[env].sharedflows[n] || null,
    });
  }

  async handle(env, request, clientIp) {
    const match = this.resolve(env, request.path);
    if (!match) return null;
    const { bundle, pe } = match;
    const result = await executeProxy({ bundle, endpointName: pe.name, request, clientIp, services: this.servicesFor(env), revision: bundle.revision });
    const reqMsg = result.ctx.request;
    this.traces.add(env, bundle.name, {
      ts: new Date().toISOString(),
      revision: bundle.revision,
      request: { verb: request.verb, uri: request.path + (request.querystring ? '?' + request.querystring : ''), headers: request.headers, content: request.content, targetVerb: reqMsg.verb },
      response: result.response,
      durationMs: result.durationMs,
      error: result.isError ? result.ctx.getVariable('fault.name') : null,
      steps: result.trace.steps,
      variables: summarizeVars(result.ctx),
    });
    const s = this.stats.get(`${env}/${bundle.name}`) || { env, proxy: bundle.name, requests: 0, errors: 0, totalMs: 0, status: {} };
    s.requests++;
    if (result.response.status >= 400) s.errors++;
    s.totalMs += result.durationMs;
    s.status[result.response.status] = (s.status[result.response.status] || 0) + 1;
    this.stats.set(`${env}/${bundle.name}`, s);
    this.logs.add({ source: 'access', env, proxy: bundle.name, message: `${request.verb} ${request.path} -> ${result.response.status} (${result.durationMs} ms)` });
    return result;
  }

  statsList() {
    return [...this.stats.values()].map((s) => ({ ...s, avgLatencyMs: s.requests ? +(s.totalMs / s.requests).toFixed(1) : 0 }));
  }
}

function summarizeVars(ctx) {
  const out = {};
  for (const [k, v] of ctx.vars) {
    if (v && typeof v === 'object' && v.constructor && v.constructor.name === 'Message') out[k] = '[message]';
    else out[k] = k.startsWith('private.') ? '********' : v;
  }
  return out;
}

module.exports = { Runtime };
