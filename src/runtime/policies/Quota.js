'use strict';
const { Fault, child, attr, text } = require('./_util');

const UNIT_MS = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000 };

function refThenAttrOrText(ctx, node, attrName) {
  if (node === undefined) return null;
  const refAttr = attrName ? attr(node, attrName + 'Ref') : attr(node, 'ref');
  if (refAttr) { const v = ctx.getVariable(refAttr); if (v !== null && v !== undefined && v !== '') return v; }
  const v = attrName ? attr(node, attrName) : text(node).trim();
  return v === undefined || v === '' ? null : v;
}

function execute(policy, ctx, svc) {
  const cfg = policy.config;
  const allow = Number(refThenAttrOrText(ctx, child(cfg, 'Allow'), 'count'));
  const interval = Number(refThenAttrOrText(ctx, child(cfg, 'Interval')) || 1);
  const unit = String(refThenAttrOrText(ctx, child(cfg, 'TimeUnit')) || 'minute').toLowerCase();
  if (!Number.isFinite(allow) || !UNIT_MS[unit]) {
    throw new Fault({ name: 'InvalidQuotaConfiguration', errorcode: 'policies.ratelimit.InvalidQuotaConfiguration', status: 500, faultstring: `Invalid Quota configuration in ${policy.name} (count=${allow}, timeUnit=${unit})` });
  }
  const idNode = child(cfg, 'Identifier');
  const idv = idNode !== undefined ? ctx.getVariable(attr(idNode, 'ref')) : null;
  const identifier = idv === null || idv === undefined || idv === '' ? '_default' : String(idv);
  const weightNode = child(cfg, 'MessageWeight');
  const weight = weightNode !== undefined ? Number(ctx.getVariable(attr(weightNode, 'ref')) || 1) : 1;
  const type = attr(cfg, 'type') || 'default';
  const periodMs = interval * UNIT_MS[unit];
  const now = Date.now();
  const key = `${svc.env}/${ctx.getVariable('apiproxy.name')}/${policy.name}/${identifier}`;
  let st = svc.state.quota.get(key);
  if (!st || now >= st.expiry) {
    let start = now;
    if (type === 'calendar' || type === 'default') {
      const startTime = text(child(cfg, 'StartTime')).trim();
      const base = startTime ? Date.parse(startTime.replace(' ', 'T') + 'Z') || 0 : 0;
      start = base + Math.floor((now - base) / periodMs) * periodMs;
    }
    st = { used: 0, exceeded: 0, expiry: start + periodMs };
  }
  const p = `ratelimit.${policy.name}`;
  const setVars = () => {
    ctx.setVariable(`${p}.allowed.count`, allow);
    ctx.setVariable(`${p}.used.count`, st.used);
    ctx.setVariable(`${p}.available.count`, Math.max(0, allow - st.used));
    ctx.setVariable(`${p}.exceed.count`, st.exceeded);
    ctx.setVariable(`${p}.total.exceed.count`, st.exceeded);
    ctx.setVariable(`${p}.expiry.time`, st.expiry);
    ctx.setVariable(`${p}.identifier`, identifier);
    ctx.setVariable(`${p}.class`, 'default');
  };
  if (st.used + weight > allow) {
    st.exceeded += weight;
    svc.state.quota.set(key, st);
    setVars();
    ctx.setVariable(`${p}.failed`, true);
    throw new Fault({ name: 'QuotaViolation', errorcode: 'policies.ratelimit.QuotaViolation', status: 429, faultstring: `Rate limit quota violation. Quota limit  exceeded. Identifier : ${identifier}` });
  }
  st.used += weight;
  svc.state.quota.set(key, st);
  setVars();
  ctx.setVariable(`${p}.failed`, false);
}

module.exports = { execute };
