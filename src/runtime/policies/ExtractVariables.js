'use strict';
const { Fault, text, attr, child, arr, bool, messageByName } = require('./_util');
const { query } = require('../jsonpath');
const { XMLParser } = require('fast-xml-parser');

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function patternRegex(pattern, segment, ignoreCase) {
  const names = [];
  let re = '';
  const parts = String(pattern).split(/(\{[^}]+\})/);
  for (const p of parts) {
    const m = /^\{([^}]+)\}$/.exec(p);
    if (m) { names.push(m[1]); re += segment ? '([^/]+)' : '(.*?)'; }
    else re += p.split('*').map(esc).join(segment ? '[^/]*' : '.*');
  }
  return { re: new RegExp(`^${re}$`, ignoreCase ? 'i' : ''), names };
}

function matchPatterns(value, patterns, segment, set) {
  if (value === null || value === undefined) return false;
  for (const p of patterns) {
    const { re, names } = patternRegex(text(p), segment, attr(p, 'ignoreCase') === 'true');
    const m = re.exec(String(value));
    if (m) { names.forEach((n, i) => set(n, m[i + 1])); return true; }
  }
  return false;
}

function simpleXPath(doc, path) {
  const steps = path.replace(/^\/+/, '').split('/').filter(Boolean);
  let cur = [doc];
  for (const s of steps) {
    if (s === 'text()') { cur = cur.map((c) => (typeof c === 'object' ? c['#text'] : c)); continue; }
    const name = s.replace(/^[\w-]+:/, '');
    const next = [];
    for (const c of cur) {
      if (!c || typeof c !== 'object') continue;
      const key = name.startsWith('@') ? '@_' + name.slice(1) : Object.keys(c).find((k) => k.replace(/^[\w-]+:/, '') === name);
      const v = key ? c[key] : undefined;
      if (v !== undefined) next.push(...(Array.isArray(v) ? v : [v]));
    }
    cur = next;
  }
  return cur.map((c) => (c && typeof c === 'object' ? (c['#text'] !== undefined ? c['#text'] : JSON.stringify(c)) : c));
}

function execute(policy, ctx) {
  const cfg = policy.config;
  const sourceName = text(child(cfg, 'Source')).trim() || 'message';
  const msg = messageByName(ctx, sourceName);
  const prefix = text(child(cfg, 'VariablePrefix')).trim();
  const set = (n, v) => ctx.setVariable(prefix ? `${prefix}.${n}` : n, v);
  const needsMessage = ['URIPath', 'QueryParam', 'Header', 'FormParam', 'JSONPayload', 'XMLPayload'].some((k) => child(cfg, k) !== undefined);
  if (!msg && needsMessage) {
    const raw = ctx.getVariable(sourceName);
    if (raw === null) throw new Fault({ name: 'SourceMessageNotAvailable', errorcode: 'steps.extractvariables.SourceMessageNotAvailable', status: 500, faultstring: `${sourceName} message is not available for ExtractVariable: ${policy.name}` });
  }
  const m = msg || null;
  const rawContent = m ? m.content : String(ctx.getVariable(sourceName) || '');

  for (const u of arr(child(cfg, 'URIPath'))) matchPatterns(ctx.getVariable('proxy.pathsuffix'), arr(child(u, 'Pattern')), true, set);
  for (const q of arr(child(cfg, 'QueryParam'))) matchPatterns(m && m.getQueryParam(attr(q, 'name')), arr(child(q, 'Pattern')), false, set);
  for (const h of arr(child(cfg, 'Header'))) matchPatterns(m && m.getHeader(attr(h, 'name')), arr(child(h, 'Pattern')), false, set);
  for (const f of arr(child(cfg, 'FormParam'))) matchPatterns(m && m.getFormParam(attr(f, 'name')), arr(child(f, 'Pattern')), false, set);
  for (const v of arr(child(cfg, 'Variable'))) matchPatterns(ctx.getVariable(attr(v, 'name')), arr(child(v, 'Pattern')), false, set);

  const jp = child(cfg, 'JSONPayload');
  if (jp !== undefined) {
    let doc;
    try { doc = JSON.parse(rawContent); } catch (e) {
      throw new Fault({ name: 'ExecutionFailed', errorcode: 'steps.extractvariables.ExecutionFailed', status: 500, faultstring: `Failed to execute the ExtractVariables: ${policy.name}. Reason: Invalid JSON payload` });
    }
    for (const v of arr(child(jp, 'Variable'))) {
      const path = text(child(v, 'JSONPath')).trim();
      let res;
      try { res = query(doc, path); } catch (e) {
        throw new Fault({ name: 'InvalidJSONPath', errorcode: 'steps.extractvariables.InvalidJSONPath', status: 500, faultstring: `Invalid JSON path ${path} in policy ${policy.name}` });
      }
      if (!res.length) continue;
      const val = res.length === 1 ? res[0] : res;
      set(attr(v, 'name'), val !== null && typeof val === 'object' ? JSON.stringify(val) : String(val));
    }
  }

  const xp = child(cfg, 'XMLPayload');
  if (xp !== undefined) {
    let doc;
    try { doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false }).parse(rawContent); } catch (e) {
      throw new Fault({ name: 'ExecutionFailed', errorcode: 'steps.extractvariables.ExecutionFailed', status: 500, faultstring: `Failed to execute the ExtractVariables: ${policy.name}. Reason: Invalid XML payload` });
    }
    for (const v of arr(child(xp, 'Variable'))) {
      const res = simpleXPath(doc, text(child(v, 'XPath')).trim());
      if (res.length) set(attr(v, 'name'), String(res[0]));
    }
  }
  void bool;
}

module.exports = { execute };
