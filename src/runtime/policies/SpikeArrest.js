'use strict';
const { Fault, child, refOrText, attr, bool } = require('./_util');

function parseRate(rate) {
  const m = /^\s*(\d+)\s*(ps|pm)\s*$/i.exec(String(rate || ''));
  if (!m) return null;
  return { count: Number(m[1]), periodMs: m[2].toLowerCase() === 'ps' ? 1000 : 60000, raw: `${m[1]}${m[2].toLowerCase()}` };
}

function execute(policy, ctx, svc) {
  const cfg = policy.config;
  const rateRaw = refOrText(ctx, child(cfg, 'Rate'));
  const rate = parseRate(rateRaw);
  if (!rate || rate.count <= 0) {
    throw new Fault({ name: 'InvalidMessageRate', errorcode: 'policies.ratelimit.InvalidMessageRate', status: 500, faultstring: `Invalid message rate ${rateRaw} in ${policy.name}; use e.g. 10ps or 30pm` });
  }
  const idNode = child(cfg, 'Identifier');
  const id = idNode !== undefined ? ctx.getVariable(attr(idNode, 'ref')) : null;
  const identifier = id === null || id === undefined ? '_default' : String(id);
  const weightNode = child(cfg, 'MessageWeight');
  const weight = weightNode !== undefined ? Number(ctx.getVariable(attr(weightNode, 'ref')) || 1) : 1;
  const key = `${svc.env}/${ctx.getVariable('apiproxy.name')}/${policy.name}/${identifier}`;
  const now = Date.now();
  const st = svc.state.spike.get(key) || { last: null, window: [] };
  let allowed;
  if (bool(child(cfg, 'UseEffectiveCount'))) {
    st.window = st.window.filter((t) => now - t < rate.periodMs);
    allowed = st.window.length + weight <= rate.count;
    if (allowed) for (let i = 0; i < weight; i++) st.window.push(now);
  } else {
    const interval = (rate.periodMs / rate.count) * weight;
    allowed = st.last === null || now - st.last >= interval;
    if (allowed) st.last = now;
  }
  svc.state.spike.set(key, st);
  ctx.setVariable(`ratelimit.${policy.name}.failed`, !allowed);
  if (!allowed) {
    throw new Fault({
      name: 'SpikeArrestViolation', errorcode: 'policies.ratelimit.SpikeArrestViolation', status: 429,
      faultstring: `Spike arrest violation. Allowed rate : MessageRate{messagesPerPeriod=${rate.count}, periodInMicroseconds=${rate.periodMs * 1000}, maxBurstMessageCount=1.0}`,
    });
  }
}

module.exports = { execute, parseRate };
