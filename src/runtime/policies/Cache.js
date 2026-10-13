'use strict';
const { Fault, Message, text, attr, child, arr, bool, refOrText } = require('./_util');
const { evaluate } = require('../condition');

function cacheKey(cfg, ctx, svc) {
  const ck = child(cfg, 'CacheKey');
  const prefix = text(child(ck, 'Prefix')).trim();
  const fragments = arr(child(ck, 'KeyFragment')).map((f) => {
    const v = refOrText(ctx, f);
    return v === null ? '' : String(v);
  });
  let head;
  if (prefix) head = prefix;
  else {
    const scope = text(child(cfg, 'Scope')).trim() || 'Exclusive';
    const org = svc.org;
    const env = svc.env;
    const proxy = ctx.getVariable('apiproxy.name');
    switch (scope) {
      case 'Global': head = `${org}__${env}`; break;
      case 'Application': head = `${org}__${env}__${proxy}`; break;
      case 'Proxy': head = `${org}__${env}__${proxy}__${ctx.getVariable('proxy.name')}`; break;
      case 'Target': head = `${org}__${env}__${proxy}__${ctx.getVariable('target.name') || ''}`; break;
      default: head = `${org}__${env}__${proxy}__${ctx.getVariable('apiproxy.revision')}__${ctx.getVariable('proxy.name')}`;
    }
  }
  return [head, ...fragments].join('__');
}

function cacheFor(cfg, svc) {
  const name = text(child(cfg, 'CacheResource')).trim() || '_default';
  const k = `${svc.env}/${name}`;
  if (!svc.state.caches.has(k)) svc.state.caches.set(k, new Map());
  return svc.state.caches.get(k);
}

function ttlMs(cfg, ctx) {
  const t = refOrText(ctx, child(child(cfg, 'ExpirySettings'), 'TimeoutInSec'));
  return (t === null ? 300 : Number(t)) * 1000;
}

function lookup(cache, key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) { cache.delete(key); return null; }
  return e.value;
}

function condTrue(cfg, tag, ctx) {
  const c = text(child(cfg, tag)).trim();
  return c ? evaluate(c, (n) => ctx.getVariable(n)) : false;
}

function responseCache(policy, ctx, svc) {
  const cfg = policy.config;
  const cache = cacheFor(cfg, svc);
  const p = `responsecache.${policy.name}`;
  if (ctx.phase === 'request' && !ctx.isError) {
    const key = cacheKey(cfg, ctx, svc);
    ctx.setVariable(`${p}.cachekey`, key);
    if (condTrue(cfg, 'SkipCacheLookup', ctx)) { ctx.setVariable(`${p}.cachehit`, false); return; }
    const hit = lookup(cache, key);
    ctx.setVariable(`${p}.cachehit`, !!hit);
    if (hit) {
      ctx.response = new Message({ status: hit.status, reasonPhrase: hit.reasonPhrase, headers: hit.headers, content: hit.content });
      ctx.responseCacheHit = policy.name;
      ctx.shortCircuit = true;
    }
    return;
  }
  if (ctx.responseCacheHit === policy.name) return;
  if (condTrue(cfg, 'SkipCachePopulation', ctx)) return;
  const status = Number(ctx.response.status || 200);
  if (bool(child(cfg, 'ExcludeErrorResponse'), true) && (status < 200 || status >= 300)) return;
  const key = ctx.getVariable(`${p}.cachekey`) || cacheKey(cfg, ctx, svc);
  const r = ctx.response;
  cache.set(key, { value: { status: r.status, reasonPhrase: r.reasonPhrase, headers: { ...r.headers }, content: r.content }, expires: Date.now() + ttlMs(cfg, ctx) });
}

function execute(policy, ctx, svc) {
  const cfg = policy.config;
  switch (policy.type) {
    case 'ResponseCache': return responseCache(policy, ctx, svc);
    case 'PopulateCache': {
      const src = text(child(cfg, 'Source')).trim();
      const v = ctx.getVariable(src);
      if (v === null || v === undefined) {
        throw new Fault({ name: 'EntryCannotBeCached', errorcode: 'steps.cache.EntryCannotBeCached', status: 500, faultstring: `Source variable ${src} could not be resolved in ${policy.name}` });
      }
      cacheFor(cfg, svc).set(cacheKey(cfg, ctx, svc), { value: v instanceof Message ? v.content : v, expires: Date.now() + ttlMs(cfg, ctx) });
      return;
    }
    case 'LookupCache': {
      const v = lookup(cacheFor(cfg, svc), cacheKey(cfg, ctx, svc));
      ctx.setVariable(`lookupcache.${policy.name}.cachehit`, v !== null);
      if (v !== null) ctx.setVariable(text(child(cfg, 'AssignTo')).trim(), v);
      return;
    }
    case 'InvalidateCache': {
      const cache = cacheFor(cfg, svc);
      const key = cacheKey(cfg, ctx, svc);
      cache.delete(key);
      if (bool(child(cfg, 'PurgeChildEntries'))) for (const k of [...cache.keys()]) if (k.startsWith(key)) cache.delete(k);
      return;
    }
    default: void attr;
  }
}

module.exports = { execute, cacheKey };
