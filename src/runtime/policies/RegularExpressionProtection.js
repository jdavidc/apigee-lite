'use strict';
const { Fault, text, attr, child, arr, messageByName, javaRegex } = require('./_util');
const { query } = require('../jsonpath');

function execute(policy, ctx) {
  const cfg = policy.config;
  const msg = messageByName(ctx, text(child(cfg, 'Source')).trim() || 'request') || ctx.request;
  const checks = [];
  const add = (value, nodes) => { if (value !== null && value !== undefined) arr(nodes).forEach((p) => checks.push([String(value), text(p)])); };
  for (const u of arr(child(cfg, 'URIPath'))) add(msg.path, child(u, 'Pattern'));
  for (const q of arr(child(cfg, 'QueryParam'))) add(msg.getQueryParam(attr(q, 'name')), child(q, 'Pattern'));
  for (const h of arr(child(cfg, 'Header'))) add(msg.getHeader(attr(h, 'name')), child(h, 'Pattern'));
  for (const f of arr(child(cfg, 'FormParam'))) add(msg.getFormParam(attr(f, 'name')), child(f, 'Pattern'));
  for (const v of arr(child(cfg, 'Variable'))) add(ctx.getVariable(attr(v, 'name')), child(v, 'Pattern'));
  const jp = child(cfg, 'JSONPayload');
  if (jp !== undefined && msg.content) {
    let doc = null;
    try { doc = JSON.parse(msg.content); } catch { doc = null; }
    if (doc !== null) {
      for (const j of arr(child(jp, 'JSONPath'))) {
        for (const r of query(doc, text(child(j, 'Expression')).trim() || '$')) add(typeof r === 'object' ? JSON.stringify(r) : r, child(j, 'Pattern'));
      }
    }
  }
  for (const [value, pattern] of checks) {
    if (javaRegex(pattern).test(value)) {
      throw new Fault({ name: 'ThreatDetected', errorcode: 'steps.regexprotection.ThreatDetected', status: 400, faultstring: `Regular Expression Threat Detected in ${policy.name}: regex: ${pattern} input: ${value}` });
    }
  }
}

module.exports = { execute };
