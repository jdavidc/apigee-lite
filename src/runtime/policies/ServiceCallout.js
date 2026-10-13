'use strict';
const { Fault, Message, text, attr, child, bool, template } = require('./_util');
const { applyOps } = require('./AssignMessage');
const { resolveLoadBalancer } = require('../services');

async function execute(policy, ctx, svc) {
  const cfg = policy.config;
  const reqNode = child(cfg, 'Request');
  const varName = attr(reqNode, 'variable') || 'servicecallout.request';
  let msg = ctx.vars.get(varName);
  if (!(msg instanceof Message)) { msg = new Message({ verb: 'GET', path: '/' }); ctx.vars.set(varName, msg); }
  if (reqNode && typeof reqNode === 'object') applyOps(reqNode, msg, ctx, { strict: !bool(child(reqNode, 'IgnoreUnresolvedVariables'), false), policyType: 'servicecallout' });
  const conn = child(cfg, 'HTTPTargetConnection');
  let url = template(ctx, text(child(conn, 'URL')).trim());
  const lb = child(conn, 'LoadBalancer');
  if (!url && lb !== undefined) {
    const servers = [].concat(child(lb, 'Server') || []).map((s) => ({ name: attr(s, 'name') }));
    const base = resolveLoadBalancer({ servers }, svc, `sc/${policy.name}`);
    if (base) url = base + text(child(conn, 'Path')).trim();
  }
  const fail = (reason) => new Fault({ name: 'ExecutionFailed', errorcode: 'steps.servicecallout.ExecutionFailed', status: 500, faultstring: `Execution of ServiceCallout ${policy.name} failed. Reason: ${reason}` });
  if (!url) throw fail('No URL or TargetServer configured');
  if (msg.querystring && !url.includes('?')) url += '?' + msg.querystring;
  const timeout = Number(text(child(cfg, 'Timeout')).trim() || 55000);
  let res;
  try {
    res = await svc.httpRequest({ method: msg.verb, url, headers: { ...msg.headers }, body: msg.content, timeout });
  } catch (e) {
    ctx.setVariable(`servicecallout.${policy.name}.failed`, true);
    throw fail(e.code === 'ETIMEDOUT' ? 'timeout occurred' : `${e.message}`);
  }
  const respName = text(child(cfg, 'Response')).trim() || 'calloutResponse';
  const out = new Message({ status: res.status, reasonPhrase: res.statusText, headers: res.headers, content: res.body });
  ctx.vars.set(respName, out);
  const ok = res.status < 400;
  ctx.setVariable(`servicecallout.${policy.name}.failed`, !ok);
  if (!ok) throw fail(`ResponseCode ${res.status} is treated as error`);
}

module.exports = { execute };
