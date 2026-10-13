'use strict';
const crypto = require('node:crypto');
const { Message } = require('./message');

const MESSAGE_ROOTS = new Set(['request', 'response', 'message', 'error']);

function msgGet(msg, rest) {
  if (rest === '' || rest === undefined) return msg;
  const lower = rest.toLowerCase();
  switch (lower) {
    case 'verb': return msg.verb;
    case 'path': return msg.path;
    case 'uri': return msg.uri;
    case 'url': return msg.uri;
    case 'querystring': return msg.querystring;
    case 'content': return msg.content;
    case 'formstring': return msg.isForm() ? msg.content : null;
    case 'status.code': return msg.status === null || msg.status === undefined ? null : Number(msg.status);
    case 'status': return msg.status;
    case 'reason.phrase': return msg.reasonPhrase;
    case 'version': return '1.1';
    case 'headers.count': return Object.keys(msg.headers).length;
    case 'headers.names': return Object.keys(msg.headers);
    case 'queryparams.count': return msg.query.length;
    case 'queryparams.names': return msg.query.map(([k]) => k);
    case 'formparams.count': return msg.formParams().length;
    case 'formparams.names': return msg.formParams().map(([k]) => k);
    default: break;
  }
  let m;
  if ((m = /^header\.(.+?)\.values\.count$/i.exec(rest))) { const v = msg.getHeader(m[1]); return v === null ? 0 : v.split(',').length; }
  if ((m = /^header\.(.+?)\.values$/i.exec(rest))) { const v = msg.getHeader(m[1]); return v === null ? null : v.split(',').map((s) => s.trim()); }
  if ((m = /^header\.(.+?)\.(\d+)$/i.exec(rest))) { const v = msg.getHeader(m[1]); return v === null ? null : (v.split(',')[Number(m[2]) - 1] || '').trim() || null; }
  if ((m = /^header\.(.+)$/i.exec(rest))) return msg.getHeader(m[1]);
  if ((m = /^queryparam\.(.+)$/i.exec(rest))) return msg.getQueryParam(m[1]);
  if ((m = /^formparam\.(.+)$/i.exec(rest))) return msg.getFormParam(m[1]);
  return undefined;
}

function msgSet(msg, rest, value) {
  const lower = rest.toLowerCase();
  const v = value === null || value === undefined ? null : value;
  switch (lower) {
    case 'verb': msg.verb = String(v); return true;
    case 'path': msg.path = String(v); return true;
    case 'querystring': msg.querystring = v; return true;
    case 'content': msg.content = v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return true;
    case 'status.code': case 'status': msg.status = Number(v); return true;
    case 'reason.phrase': msg.reasonPhrase = String(v); return true;
    default: break;
  }
  let m;
  if ((m = /^header\.(.+)$/i.exec(rest))) { msg.setHeader(m[1], v); return true; }
  if ((m = /^queryparam\.(.+)$/i.exec(rest))) { msg.setQueryParam(m[1], v); return true; }
  if ((m = /^formparam\.(.+)$/i.exec(rest))) { msg.setFormParam(m[1], v); return true; }
  return false;
}

class MessageContext {
  constructor({ request, response } = {}) {
    this.vars = new Map();
    this.request = request || new Message();
    this.response = response || new Message({ status: 200 });
    this.phase = 'request';
    this.flow = 'PROXY_REQ_FLOW';
    this.isError = false;
    this.prints = null;
  }

  currentMessage() { return this.phase === 'response' || this.isError ? this.response : this.request; }

  // Returns [Message, rest] if the name addresses a message (request.*, myVar.header.x, ...).
  resolveMessage(name) {
    const dot = name.indexOf('.');
    const head = dot < 0 ? name : name.slice(0, dot);
    const rest = dot < 0 ? '' : name.slice(dot + 1);
    if (head === 'request') return [this.request, rest];
    if (head === 'response') return [this.response, rest];
    if (head === 'message') return [this.currentMessage(), rest];
    if (head === 'error' && this.isError) return [this.response, rest];
    const parts = name.split('.');
    for (let i = parts.length; i > 0; i--) {
      const key = parts.slice(0, i).join('.');
      const v = this.vars.get(key);
      if (v instanceof Message) return [v, parts.slice(i).join('.')];
      if (v !== undefined && i === parts.length) return null;
    }
    return null;
  }

  getVariable(name) {
    if (name === undefined || name === null || name === '') return null;
    name = String(name).trim();
    switch (name) {
      case 'system.timestamp': return Date.now();
      case 'system.time': return new Date().toUTCString();
      case 'system.uuid': return crypto.randomUUID();
      case 'is.error': return this.isError;
      default: break;
    }
    if (this.vars.has(name)) return this.vars.get(name);
    const r = this.resolveMessage(name);
    if (r) {
      const [msg, rest] = r;
      const head = name.split('.')[0];
      if (rest === '' && MESSAGE_ROOTS.has(head)) return msg;
      const v = msgGet(msg, rest);
      return v === undefined ? null : v;
    }
    return null;
  }

  setVariable(name, value) {
    name = String(name).trim();
    if (!this.vars.has(name)) {
      const head = name.split('.')[0];
      if (MESSAGE_ROOTS.has(head) && !(head === 'error' && !this.isError)) {
        const r = this.resolveMessage(name);
        if (r && r[1] !== '' && msgSet(r[0], r[1], value)) return;
      } else if (name.includes('.')) {
        const r = this.resolveMessage(name);
        if (r && r[1] !== '' && msgSet(r[0], r[1], value)) return;
      }
    }
    if (name === 'request' && value instanceof Message) { this.request = value; return; }
    if (name === 'response' && value instanceof Message) { this.response = value; return; }
    this.vars.set(name, value);
  }

  removeVariable(name) {
    name = String(name).trim();
    if (this.vars.has(name)) { this.vars.delete(name); return; }
    const r = this.resolveMessage(name);
    if (r && r[1]) msgSet(r[0], r[1], null);
  }

  // Flattened view used by Trace to compute changed variables.
  snapshot() {
    const out = {};
    const addMsg = (prefix, m) => {
      if (!m) return;
      if (m.status !== null && m.status !== undefined) out[`${prefix}.status.code`] = String(m.status);
      if (prefix === 'request' || m.status === null) { out[`${prefix}.verb`] = m.verb; out[`${prefix}.uri`] = m.uri; }
      out[`${prefix}.content`] = m.content;
      for (const [k, v] of Object.entries(m.headers)) out[`${prefix}.header.${k}`] = v;
    };
    addMsg('request', this.request);
    addMsg('response', this.response);
    for (const [k, v] of this.vars) {
      if (v instanceof Message) addMsg(k, v);
      else if (k.startsWith('private.')) out[k] = v === null || v === undefined ? null : '********';
      else out[k] = v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
    return out;
  }
}

function diffSnapshots(a, b, max = 2000) {
  const changes = [];
  const clip = (v) => (typeof v === 'string' && v.length > max ? v.slice(0, max) + '…' : v);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (a[k] !== b[k]) changes.push({ name: k, from: a[k] === undefined ? null : clip(a[k]), to: b[k] === undefined ? null : clip(b[k]) });
  }
  return changes;
}

module.exports = { MessageContext, diffSnapshots, msgGet, msgSet };
