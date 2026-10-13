'use strict';
const { Fault, text, child, messageByName, writeOutput, isJsonType } = require('./_util');
const { escapeXml } = require('../xml');

function toXml(name, v, o) {
  if (Array.isArray(v)) {
    if (o.arrayItem) return `<${name}>${v.map((x) => toXml(o.arrayItem, x, o)).join('')}</${name}>`;
    return v.map((x) => toXml(name, x, o)).join('');
  }
  if (v === null) return o.nullValue !== null ? `<${name}>${escapeXml(o.nullValue)}</${name}>` : `<${name}/>`;
  if (typeof v === 'object') {
    let attrs = '';
    let inner = '';
    for (const [k, val] of Object.entries(v)) {
      if (o.attrBlock && k === o.attrBlock && val && typeof val === 'object') {
        for (const [ak, av] of Object.entries(val)) attrs += ` ${ak}="${escapeXml(av)}"`;
      } else if (o.attrPrefix && k.startsWith(o.attrPrefix) && (val === null || typeof val !== 'object')) {
        attrs += ` ${k.slice(o.attrPrefix.length)}="${escapeXml(val)}"`;
      } else if (o.textNode && k === o.textNode) inner += escapeXml(val);
      else inner += toXml(k, val, o);
    }
    return `<${name}${attrs}>${inner}</${name}>`;
  }
  return `<${name}>${escapeXml(v)}</${name}>`;
}

function execute(policy, ctx) {
  const cfg = policy.config;
  const srcName = text(child(cfg, 'Source')).trim() || 'request';
  const msg = messageByName(ctx, srcName);
  if (msg && !isJsonType(msg.getHeader('content-type'))) return;
  const content = msg ? msg.content : ctx.getVariable(srcName);
  const opt = child(cfg, 'Options') || {};
  const o = {
    objectRoot: text(child(opt, 'ObjectRootElementName')).trim(),
    arrayRoot: text(child(opt, 'ArrayRootElementName')).trim() || 'Array',
    arrayItem: text(child(opt, 'ArrayItemElementName')).trim(),
    nullValue: child(opt, 'NullValue') !== undefined ? text(child(opt, 'NullValue')) : null,
    attrBlock: text(child(opt, 'AttributeBlockName')).trim(),
    attrPrefix: text(child(opt, 'AttributePrefix')).trim(),
    textNode: text(child(opt, 'TextNodeName')).trim(),
  };
  let doc;
  try { doc = JSON.parse(content); } catch (e) {
    throw new Fault({ name: 'ExecutionFailed', errorcode: 'steps.jsontoxml.ExecutionFailed', status: 500, faultstring: `JSONToXML[${policy.name}]: Execution failed due to reason: Invalid JSON: ${e.message}` });
  }
  let xml;
  if (Array.isArray(doc)) xml = toXml(o.arrayRoot, doc, { ...o, arrayItem: o.arrayItem || 'Item' });
  else if (doc && typeof doc === 'object') {
    const keys = Object.keys(doc);
    if (!o.objectRoot && keys.length === 1) xml = toXml(keys[0], doc[keys[0]], o);
    else xml = toXml(o.objectRoot || 'Root', doc, o);
  } else xml = toXml(o.objectRoot || 'Root', doc, o);
  const out = text(child(cfg, 'OutputVariable')).trim() || srcName;
  writeOutput(ctx, out, `<?xml version="1.0" encoding="UTF-8"?>${xml}`, 'application/xml');
}

module.exports = { execute };
