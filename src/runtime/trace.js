'use strict';

class Trace {
  constructor(meta = {}) {
    this.meta = meta;
    this.steps = [];
    this.startedAt = Date.now();
  }
  add(entry) { this.steps.push({ seq: this.steps.length + 1, at: Date.now() - this.startedAt, ...entry }); return this.steps[this.steps.length - 1]; }
  toJSON() { return { ...this.meta, steps: this.steps }; }
}

// Keeps the latest transactions per environment/proxy.
class TraceStore {
  constructor(max = 50) { this.max = max; this.map = new Map(); this.seq = 0; }
  add(env, proxy, tx) {
    const key = `${env}/${proxy}`;
    const list = this.map.get(key) || [];
    const rec = { id: String(++this.seq), ...tx };
    list.push(rec);
    if (list.length > this.max) list.shift();
    this.map.set(key, list);
    return rec;
  }
  list(env, proxy) { return (this.map.get(`${env}/${proxy}`) || []).map(({ id, ts, request, response, durationMs, error }) => ({ id, ts, verb: request.verb, uri: request.uri, status: response.status, durationMs, error })); }
  get(env, proxy, id) { return (this.map.get(`${env}/${proxy}`) || []).find((t) => t.id === id) || null; }
  clear(env, proxy) { this.map.delete(`${env}/${proxy}`); }
}

module.exports = { Trace, TraceStore };
