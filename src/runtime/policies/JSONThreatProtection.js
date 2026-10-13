'use strict';
const { Fault, text, child, messageByName, isJsonType } = require('./_util');

function execute(policy, ctx) {
  const cfg = policy.config;
  const num = (tag) => { const t = text(child(cfg, tag)).trim(); return t === '' ? -1 : Number(t); };
  const limits = {
    arrayCount: num('ArrayElementCount'), depth: num('ContainerDepth'), entryCount: num('ObjectEntryCount'),
    nameLen: num('ObjectEntryNameLength'), strLen: num('StringValueLength'),
  };
  const src = text(child(cfg, 'Source')).trim() || 'request';
  const msg = messageByName(ctx, src);
  const content = msg ? msg.content : ctx.getVariable(src);
  if (msg && !isJsonType(msg.getHeader('content-type'))) return;
  if (content === null || content === undefined || String(content).trim() === '') return;
  const fail = (reason) => new Fault({
    name: 'ExecutionFailed', errorcode: 'steps.jsonthreatprotection.ExecutionFailed', status: 500,
    faultstring: `JSONThreatProtection[${policy.name}]: Execution failed. reason: JSONThreatProtection[${policy.name}]: ${reason}`,
  });
  let doc;
  try { doc = JSON.parse(content); } catch (e) { throw fail(`Invalid JSON: ${e.message}`); }
  const walk = (v, depth) => {
    if (Array.isArray(v)) {
      if (limits.depth >= 0 && depth + 1 > limits.depth) throw fail(`Exceeded container depth, max ${limits.depth} allowed.`);
      if (limits.arrayCount >= 0 && v.length > limits.arrayCount) throw fail(`Exceeded array element count, max ${limits.arrayCount} allowed, found ${v.length}.`);
      v.forEach((x) => walk(x, depth + 1));
    } else if (v && typeof v === 'object') {
      if (limits.depth >= 0 && depth + 1 > limits.depth) throw fail(`Exceeded container depth, max ${limits.depth} allowed.`);
      const keys = Object.keys(v);
      if (limits.entryCount >= 0 && keys.length > limits.entryCount) throw fail(`Exceeded object entry count, max ${limits.entryCount} allowed, found ${keys.length}.`);
      for (const k of keys) {
        if (limits.nameLen >= 0 && k.length > limits.nameLen) throw fail(`Exceeded object entry name length, max ${limits.nameLen} allowed, found ${k.length}.`);
        walk(v[k], depth + 1);
      }
    } else if (typeof v === 'string' && limits.strLen >= 0 && v.length > limits.strLen) {
      throw fail(`Exceeded string value length, max ${limits.strLen} allowed, found ${v.length}.`);
    }
  };
  walk(doc, 0);
}

module.exports = { execute };
