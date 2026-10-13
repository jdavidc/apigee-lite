'use strict';
const { XMLParser, XMLValidator } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  allowBooleanAttributes: true,
  stopNodes: ['*.Payload'],
  processEntities: true,
});

function validateXml(xml) {
  const res = XMLValidator.validate(xml, { allowBooleanAttributes: true });
  if (res === true) return null;
  return { line: res.err.line, col: res.err.col, message: res.err.msg };
}

function parseXml(xml) {
  const err = validateXml(xml);
  if (err) {
    const e = new Error(`XML error at line ${err.line}: ${err.message}`);
    e.line = err.line;
    throw e;
  }
  return parser.parse(xml);
}

// Returns { tag, node } for the document's root element.
function rootOf(doc) {
  const tag = Object.keys(doc).find((k) => !k.startsWith('?') && !k.startsWith('#'));
  if (!tag) throw new Error('Empty XML document');
  const node = doc[tag];
  return { tag, node: node === '' || node == null ? {} : node };
}

const arr = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v]);

function text(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object') return v['#text'] !== undefined ? String(v['#text']) : '';
  return String(v);
}

const attr = (node, name) => (node && typeof node === 'object' && !Array.isArray(node) ? node['@_' + name] : undefined);
const child = (node, name) => (node && typeof node === 'object' ? node[name] : undefined);
const has = (node, name) => node && typeof node === 'object' && Object.prototype.hasOwnProperty.call(node, name);

function bool(v, dflt = false) {
  const t = typeof v === 'object' ? text(v) : v;
  if (t === undefined || t === null || t === '') return dflt;
  return String(t).trim().toLowerCase() === 'true';
}

function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// Raw inner content of a stop-node such as <Payload>.
function rawPayload(node) {
  let s = typeof node === 'object' && node !== null ? (node['#text'] !== undefined ? String(node['#text']) : '') : node == null ? '' : String(node);
  const cdata = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/.exec(s);
  if (cdata) return cdata[1];
  s = s.trim();
  if (!/<[A-Za-z!?/]/.test(s)) s = decodeEntities(s);
  return s;
}

const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

module.exports = { parseXml, validateXml, rootOf, arr, text, attr, child, has, bool, rawPayload, escapeXml, decodeEntities };
