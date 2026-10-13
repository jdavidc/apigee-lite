'use strict';
const { Fault } = require('../fault');
const { Message } = require('../message');
const { text, attr, child, arr, bool } = require('../xml');
const { resolveTemplate } = require('../template');

// Value of an element that supports both ref="var" and literal text (ref wins when it resolves).
function refOrText(ctx, node) {
  if (node === undefined) return null;
  const ref = attr(node, 'ref');
  if (ref) {
    const v = ctx.getVariable(ref);
    if (v !== null && v !== undefined && v !== '') return v;
  }
  const t = text(node);
  return t === '' ? null : t;
}

function template(ctx, str, opts = {}) {
  return resolveTemplate(str, (n) => ctx.getVariable(n), opts);
}

// Resolves a message by name: request, response, message, or a variable holding a Message.
function messageByName(ctx, name) {
  const n = (name || 'message').trim();
  if (n === 'request') return ctx.request;
  if (n === 'response') return ctx.response;
  if (n === 'message') return ctx.currentMessage();
  const v = ctx.vars.get(n);
  return v instanceof Message ? v : null;
}

function writeOutput(ctx, name, content, contentType) {
  const n = (name || '').trim();
  const msg = messageByName(ctx, n || 'message');
  if (msg && (n === '' || n === 'request' || n === 'response' || n === 'message' || ctx.vars.get(n) instanceof Message)) {
    msg.content = content;
    if (contentType) msg.setHeader('content-type', contentType);
  } else ctx.setVariable(n, content);
}

const isJsonType = (ct) => /json/i.test(ct || '');
const isXmlType = (ct) => /xml/i.test(ct || '');

function durationMs(s) {
  const m = /^\s*(-?\d+)\s*(ms|s|m|h|d)?\s*$/i.exec(String(s));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  return n * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
}

// Converts Java-style regexes, including inline (?i) flags, to JS.
function javaRegex(pattern, extraFlags = '') {
  let flags = extraFlags;
  let p = String(pattern);
  if (/\(\?i\)/.test(p)) { flags += 'i'; p = p.replace(/\(\?i\)/g, ''); }
  return new RegExp(p, flags);
}

module.exports = { Fault, Message, text, attr, child, arr, bool, refOrText, template, messageByName, writeOutput, isJsonType, isXmlType, durationMs, javaRegex };
