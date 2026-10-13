'use strict';
const http = require('node:http');

const dec = (s) => {
  try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch { return String(s); }
};

function parsePairs(qs) {
  if (!qs) return [];
  return String(qs).replace(/^\?/, '').split('&').filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    return i < 0 ? [dec(p), ''] : [dec(p.slice(0, i)), dec(p.slice(i + 1))];
  });
}

const encodePairs = (pairs) => pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

class Message {
  constructor({ verb = 'GET', path = '/', querystring = '', headers = {}, content = '', status = null, reasonPhrase } = {}) {
    this.verb = verb;
    this.path = path;
    this._rawQuery = String(querystring || '').replace(/^\?/, '');
    this._query = null;
    this.headers = {};
    for (const [k, v] of Object.entries(headers || {})) {
      if (v !== undefined && v !== null) this.headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    this.content = content == null ? '' : String(content);
    this.status = status;
    this.reasonPhrase = reasonPhrase !== undefined ? reasonPhrase : status ? http.STATUS_CODES[status] || '' : '';
  }

  get query() {
    if (!this._query) this._query = parsePairs(this._rawQuery);
    return this._query;
  }

  _touchQuery() { this._rawQuery = null; }

  get querystring() {
    if (this._rawQuery !== null) return this._rawQuery;
    return encodePairs(this.query);
  }

  set querystring(v) { this._rawQuery = String(v || '').replace(/^\?/, ''); this._query = null; }

  get uri() { const q = this.querystring; return this.path + (q ? '?' + q : ''); }

  getHeader(n) { const v = this.headers[String(n).toLowerCase()]; return v === undefined ? null : v; }
  setHeader(n, v) { if (v === null || v === undefined) this.removeHeader(n); else this.headers[String(n).toLowerCase()] = String(v); }
  addHeader(n, v) {
    const k = String(n).toLowerCase();
    this.headers[k] = this.headers[k] !== undefined && this.headers[k] !== '' ? `${this.headers[k]}, ${v}` : String(v);
  }
  removeHeader(n) { delete this.headers[String(n).toLowerCase()]; }

  getQueryParam(n) { const p = this.query.find(([k]) => k === n); return p ? p[1] : null; }
  setQueryParam(n, v) { this.removeQueryParam(n); if (v !== null && v !== undefined) this.addQueryParam(n, v); }
  addQueryParam(n, v) { this.query.push([n, String(v)]); this._touchQuery(); }
  removeQueryParam(n) { this._query = this.query.filter(([k]) => k !== n); this._touchQuery(); }

  isForm() { return /application\/x-www-form-urlencoded/i.test(this.getHeader('content-type') || ''); }
  formParams() { return this.isForm() ? parsePairs(this.content) : []; }
  getFormParam(n) { const p = this.formParams().find(([k]) => k === n); return p ? p[1] : null; }
  setFormParam(n, v) { const ps = this.formParams().filter(([k]) => k !== n); if (v != null) ps.push([n, String(v)]); this._setForm(ps); }
  addFormParam(n, v) { const ps = this.formParams(); ps.push([n, String(v)]); this._setForm(ps); }
  removeFormParam(n) { this._setForm(this.formParams().filter(([k]) => k !== n)); }
  _setForm(ps) { if (!this.isForm()) this.setHeader('content-type', 'application/x-www-form-urlencoded'); this.content = encodePairs(ps); }

  clone() {
    const m = new Message({ verb: this.verb, path: this.path, querystring: this.querystring, headers: { ...this.headers }, content: this.content, status: this.status, reasonPhrase: this.reasonPhrase });
    return m;
  }

  toJSON() {
    return { verb: this.verb, path: this.path, querystring: this.querystring, status: this.status, reasonPhrase: this.reasonPhrase, headers: { ...this.headers }, content: this.content };
  }
}

module.exports = { Message, parsePairs, encodePairs };
