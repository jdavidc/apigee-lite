'use strict';
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { evaluate } = require('./condition');
const { Message } = require('./message');
const { MessageContext, diffSnapshots } = require('./message-context');
const { Fault } = require('./fault');
const { Trace } = require('./trace');
const { resolveLoadBalancer } = require('./services');
const policies = require('./policies');

const RESPONSE_HOP = new Set(['transfer-encoding', 'content-length', 'connection', 'content-encoding', 'keep-alive']);

function toFault(e, policy) {
  if (e instanceof Fault) return e;
  const type = policy ? policy.type : 'runtime';
  return new Fault({
    name: 'ExecutionFailed',
    errorcode: policy ? `steps.${type.toLowerCase()}.ExecutionFailed` : 'messaging.runtime.InternalError',
    status: 500,
    faultstring: policy ? `Execution of ${policy.name} failed: ${e.message}` : e.message,
  });
}

function defaultFaultMessage(f) {
  return new Message({
    status: f.status,
    reasonPhrase: f.reasonPhrase,
    headers: { 'content-type': f.contentType || 'application/json', ...f.headers },
    content: f.defaultBody(),
  });
}

function parseSuccessCodes(spec) {
  const list = String(spec || '1xx,2xx,3xx').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return (code) => list.some((s) => (/^\dxx$/.test(s) ? Math.floor(code / 100) === Number(s[0]) : Number(s) === code));
}

class Executor {
  constructor(bundle, ctx, services, trace) {
    this.bundle = bundle;
    this.ctx = ctx;
    this.services = services;
    this.trace = trace;
    this.matchedFlows = new Map();
  }

  cond(c) { return evaluate(c, (n) => this.ctx.getVariable(n)); }

  async runSteps(steps, where, bundle = this.bundle) {
    for (const step of steps) {
      if (this.ctx.shortCircuit) return;
      const policy = bundle.policies[step.name];
      const entry = { kind: 'policy', policy: step.name, type: policy ? policy.type : 'Unknown', condition: step.condition, conditionResult: null, executed: false, ...where };
      if (bundle !== this.bundle) entry.sharedFlow = bundle.name;
      if (step.condition) {
        try { entry.conditionResult = this.cond(step.condition); } catch (e) {
          entry.error = { faultstring: e.message };
          this.trace.add(entry);
          throw new Fault({ name: 'InvalidCondition', errorcode: 'messaging.runtime.InvalidCondition', status: 500, faultstring: e.message });
        }
        if (!entry.conditionResult) { this.trace.add(entry); continue; }
      }
      if (!policy) {
        entry.error = { faultstring: `Unresolved policy ${step.name}` };
        this.trace.add(entry);
        throw new Fault({ name: 'UnresolvedPolicy', errorcode: 'messaging.runtime.UnresolvedPolicy', status: 500, faultstring: `Unresolved policy ${step.name}` });
      }
      if (!policy.enabled) { entry.skipped = 'disabled'; this.trace.add(entry); continue; }
      const before = this.ctx.snapshot();
      const prints = [];
      this.ctx.prints = prints;
      const t0 = performance.now();
      let fault = null;
      entry.executed = true;
      const rec = this.trace.add(entry);
      try {
        await policies.execute(policy, this.ctx, this.services, this, bundle);
      } catch (e) {
        fault = toFault(e, policy);
        fault.policy = policy.name;
        rec.error = { name: fault.faultName, errorcode: fault.errorcode, faultstring: fault.faultstring, status: fault.status, continued: policy.continueOnError };
        this.ctx.vars.set('fault.name', fault.faultName);
        this.ctx.vars.set('error.message', fault.faultstring);
      } finally {
        rec.durationMs = +(performance.now() - t0).toFixed(2);
        rec.prints = prints;
        this.ctx.prints = null;
        rec.changes = diffSnapshots(before, this.ctx.snapshot());
      }
      if (fault && !policy.continueOnError) throw fault;
    }
  }

  async runEndpointPhase(ep, phase, label) {
    const where = (flow) => ({ endpoint: `${label} ${ep.name}`, flow, phase });
    this.trace.add({ kind: 'flow', ...where('PreFlow') });
    await this.runSteps(ep.preFlow[phase], where('PreFlow'));
    if (this.ctx.shortCircuit) return;
    let matched = this.matchedFlows.get(ep);
    if (phase === 'request' || matched === undefined) {
      matched = null;
      for (const f of ep.flows) {
        const res = f.condition ? this.cond(f.condition) : true;
        this.trace.add({ kind: 'condflow', endpoint: `${label} ${ep.name}`, flow: f.name, condition: f.condition, conditionResult: res, phase });
        if (res) { matched = f; break; }
      }
      this.matchedFlows.set(ep, matched);
      if (matched) this.ctx.vars.set('current.flow.name', matched.name);
    }
    if (matched) {
      this.trace.add({ kind: 'flow', ...where(matched.name) });
      await this.runSteps(matched[phase], where(matched.name));
      if (this.ctx.shortCircuit) return;
    }
    this.trace.add({ kind: 'flow', ...where('PostFlow') });
    await this.runSteps(ep.postFlow[phase], where('PostFlow'));
  }

  // Runs a shared flow bundle (FlowCallout).
  async runSharedFlow(sf, flowName = 'default') {
    const flow = sf.sharedFlows[flowName];
    if (!flow) throw new Fault({ name: 'SharedFlowNotFound', errorcode: 'flow.SharedFlowNotFound', status: 500, faultstring: `Shared flow ${sf.name} has no flow ${flowName}` });
    await this.runSteps(flow.steps, { endpoint: `SharedFlow ${sf.name}`, flow: flowName, phase: this.ctx.phase }, sf);
  }

  pickRoute(pe) {
    for (const r of pe.routeRules) {
      const res = r.condition ? this.cond(r.condition) : true;
      this.trace.add({ kind: 'route', rule: r.name, condition: r.condition, conditionResult: res, target: r.targetEndpoint || r.url || null });
      if (res) return r;
    }
    return undefined;
  }

  targetUrl(te, routeUrl) {
    const ctx = this.ctx;
    const conn = te ? te.connection : null;
    let base;
    if (routeUrl) base = routeUrl;
    else if (conn && conn.url) base = conn.url;
    else if (conn && conn.loadBalancer) {
      const b = resolveLoadBalancer(conn.loadBalancer, this.services, `${this.bundle.name}/${te.name}`);
      if (!b) throw new Fault({ name: 'NoActiveTargets', errorcode: 'messaging.adaptors.http.flow.NoActiveTargets', status: 503, faultstring: 'The Service is temporarily unavailable' });
      base = b + (conn.path || '');
    } else throw new Fault({ name: 'RouteFailed', errorcode: 'messaging.runtime.RouteFailed', status: 500, faultstring: `TargetEndpoint ${te ? te.name : ''} has no supported connection (LocalTargetConnection is not supported in Apigee Lite)` });
    return base;
  }

  async callTarget(te, routeUrl) {
    const ctx = this.ctx;
    const configured = ctx.vars.get('target.url');
    let url;
    if (ctx.targetUrlInitial !== undefined && configured !== ctx.targetUrlInitial && configured) {
      url = String(configured);
    } else {
      url = String(configured || this.targetUrl(te, routeUrl));
      const copySuffix = ctx.getVariable('target.copy.pathsuffix');
      if (String(copySuffix) !== 'false') {
        const suffix = ctx.getVariable('proxy.pathsuffix') || '';
        if (suffix) url = url.replace(/\/+$/, '') + suffix;
      }
    }
    const qs = ctx.request.querystring;
    if (qs && String(ctx.getVariable('target.copy.queryparams')) !== 'false' && !url.includes('?')) url += '?' + qs;
    const props = (te && te.connection && te.connection.properties) || {};
    const timeout = Number(props['io.timeout.millis'] || 55000);
    const req = ctx.request;
    const t0 = performance.now();
    const entry = { kind: 'target', method: req.verb, url };
    ctx.vars.set('target.url', url);
    let res;
    try {
      res = await this.services.httpRequest({ method: req.verb, url, headers: { ...req.headers }, body: req.content, timeout });
    } catch (e) {
      entry.durationMs = +(performance.now() - t0).toFixed(2);
      entry.error = e.message;
      this.trace.add(entry);
      if (e.code === 'ETIMEDOUT') throw new Fault({ name: 'GatewayTimeout', errorcode: 'messaging.adaptors.http.flow.GatewayTimeout', status: 504, faultstring: 'Gateway Timeout' });
      throw new Fault({ name: 'ServiceUnavailable', errorcode: 'messaging.adaptors.http.flow.ServiceUnavailable', status: 503, faultstring: 'The Service is temporarily unavailable' });
    }
    entry.durationMs = +(performance.now() - t0).toFixed(2);
    entry.status = res.status;
    this.trace.add(entry);
    const headers = {};
    for (const [k, v] of Object.entries(res.headers || {})) if (!RESPONSE_HOP.has(k.toLowerCase())) headers[k] = v;
    ctx.response = new Message({ status: res.status, reasonPhrase: res.statusText, headers, content: res.body || '' });
    ctx.vars.set('target.received.end.timestamp', Date.now());
    ctx.phase = 'response';
    ctx.flow = 'TARGET_RESP_FLOW';
    if (!parseSuccessCodes(props['success.codes'])(res.status)) {
      throw new Fault({ name: 'ErrorResponseCode', errorcode: 'messaging.adaptors.http.flow.ErrorResponseCode', status: res.status, faultstring: `Received ${res.status} Response Code`, keepResponse: true });
    }
  }

  async run(pe) {
    const ctx = this.ctx;
    let te = null;
    let inTarget = false;
    try {
      ctx.phase = 'request';
      ctx.flow = 'PROXY_REQ_FLOW';
      await this.runEndpointPhase(pe, 'request', 'ProxyEndpoint');
      if (!ctx.shortCircuit) {
        const rr = this.pickRoute(pe);
        if (rr === undefined) {
          throw new Fault({ name: 'RouteFailed', errorcode: 'messaging.runtime.RouteFailed', status: 500, faultstring: 'Unable to route the message to a Target Endpoint' });
        }
        if (rr.targetEndpoint || rr.url) {
          te = rr.targetEndpoint ? this.bundle.targetEndpoints[rr.targetEndpoint] : null;
          if (rr.targetEndpoint && !te) throw new Fault({ name: 'RouteFailed', errorcode: 'messaging.runtime.RouteFailed', status: 500, faultstring: `Unable to route the message to a Target Endpoint : ${rr.targetEndpoint}` });
          inTarget = !!te;
          ctx.flow = 'TARGET_REQ_FLOW';
          ctx.vars.set('target.name', te ? te.name : null);
          try { ctx.targetUrlInitial = this.targetUrl(te, rr.url); } catch (e) { ctx.targetUrlInitial = null; }
          ctx.vars.set('target.url', ctx.targetUrlInitial);
          if (te) await this.runEndpointPhase(te, 'request', 'TargetEndpoint');
          if (!ctx.shortCircuit) {
            await this.callTarget(te, rr.url);
            if (te) await this.runEndpointPhase(te, 'response', 'TargetEndpoint');
          }
        }
      }
      inTarget = false;
      ctx.shortCircuit = false;
      ctx.phase = 'response';
      ctx.flow = 'PROXY_RESP_FLOW';
      await this.runEndpointPhase(pe, 'response', 'ProxyEndpoint');
    } catch (e) {
      await this.handleFault(e, inTarget ? te : null, pe);
    }
    ctx.shortCircuit = false;
    if (pe.postClientFlow && pe.postClientFlow.response.length) {
      ctx.flow = 'PROXY_POST_CLIENT_FLOW';
      this.trace.add({ kind: 'flow', endpoint: `ProxyEndpoint ${pe.name}`, flow: 'PostClientFlow', phase: 'response' });
      try { await this.runSteps(pe.postClientFlow.response, { endpoint: `ProxyEndpoint ${pe.name}`, flow: 'PostClientFlow', phase: 'response' }); } catch (e) { /* errors in PostClientFlow never change the response */ }
    }
  }

  async handleFault(e, te, pe) {
    const ctx = this.ctx;
    const f = toFault(e);
    ctx.vars.set('error.state', ctx.flow);
    ctx.isError = true;
    ctx.shortCircuit = false;
    ctx.vars.set('fault.name', f.faultName);
    ctx.vars.set('error.message', f.faultstring);
    ctx.vars.set('fault.category', f.errorcode.split('.')[0]);
    if (f.response) ctx.response = f.response;
    else if (!f.keepResponse) ctx.response = defaultFaultMessage(f);
    ctx.phase = 'response';
    this.trace.add({ kind: 'fault', name: f.faultName, errorcode: f.errorcode, faultstring: f.faultstring, status: ctx.response.status, policy: f.policy, state: ctx.vars.get('error.state') });
    let stopped = false;
    if (te) stopped = await this.runFaultRules(te, 'TargetEndpoint', false);
    if (!stopped) await this.runFaultRules(pe, 'ProxyEndpoint', true);
  }

  // Returns true when processing must stop (e.g. RaiseFault inside a FaultRule).
  async runFaultRules(ep, label, bottomUp) {
    const rules = bottomUp ? [...ep.faultRules].reverse() : ep.faultRules;
    let executedAny = false;
    const endpoint = `${label} ${ep.name}`;
    try {
      for (const r of rules) {
        const res = r.condition ? this.cond(r.condition) : true;
        this.trace.add({ kind: 'faultrule', endpoint, rule: r.name, condition: r.condition, conditionResult: res });
        if (!res) continue;
        executedAny = true;
        await this.runSteps(r.steps, { endpoint, flow: `FaultRule ${r.name}`, phase: 'error' });
        break;
      }
      const d = ep.defaultFaultRule;
      if (d && (!executedAny || d.alwaysEnforce)) {
        const res = d.condition ? this.cond(d.condition) : true;
        this.trace.add({ kind: 'faultrule', endpoint, rule: d.name, condition: d.condition, conditionResult: res, isDefault: true, alwaysEnforce: d.alwaysEnforce });
        if (res) await this.runSteps(d.steps, { endpoint, flow: `DefaultFaultRule ${d.name}`, phase: 'error' });
      }
    } catch (e2) {
      const f2 = toFault(e2);
      this.ctx.vars.set('fault.name', f2.faultName);
      if (f2.response) this.ctx.response = f2.response;
      else if (!f2.keepResponse) this.ctx.response = defaultFaultMessage(f2);
      this.trace.add({ kind: 'fault', name: f2.faultName, errorcode: f2.errorcode, faultstring: f2.faultstring, status: this.ctx.response.status, policy: f2.policy, inFaultRule: true });
      return true;
    }
    return false;
  }
}

async function executeProxy({ bundle, endpointName, request, clientIp, services, revision }) {
  const pe = bundle.proxyEndpoints[endpointName] || Object.values(bundle.proxyEndpoints)[0];
  const req = new Message({ verb: (request.verb || 'GET').toUpperCase(), path: request.path, querystring: request.querystring, headers: request.headers, content: request.content });
  const ctx = new MessageContext({ request: req });
  const trace = new Trace({ proxy: bundle.name, revision: revision || bundle.revision, endpoint: pe.name });
  const pathsuffix = req.path.startsWith(pe.basePath) ? req.path.slice(pe.basePath === '/' ? 0 : pe.basePath.length) : req.path;
  const v = ctx.vars;
  v.set('messageid', crypto.randomUUID());
  v.set('organization.name', services.org);
  v.set('environment.name', services.env);
  v.set('apiproxy.name', bundle.name);
  v.set('apiproxy.revision', String(revision || bundle.revision || '1'));
  v.set('proxy.name', pe.name);
  v.set('proxy.basepath', pe.basePath);
  v.set('proxy.pathsuffix', pathsuffix === '/' && pe.basePath !== '/' ? '/' : pathsuffix);
  v.set('proxy.url', `http://${req.getHeader('host') || 'localhost'}${req.uri}`);
  v.set('client.ip', clientIp || '127.0.0.1');
  v.set('client.received.start.timestamp', Date.now());
  v.set('request.uri.raw', req.uri);
  const exec = new Executor(bundle, ctx, services, trace);
  const t0 = performance.now();
  await exec.run(pe);
  const durationMs = +(performance.now() - t0).toFixed(2);
  const r = ctx.response;
  return {
    response: { status: r.status || 200, reasonPhrase: r.reasonPhrase, headers: { ...r.headers }, content: r.content },
    trace,
    ctx,
    durationMs,
    isError: ctx.isError,
  };
}

module.exports = { executeProxy, Executor, defaultFaultMessage, toFault };
