'use strict';
const vm = require('node:vm');
const crypto = require('node:crypto');
const { Fault, text, attr, child, arr } = require('./_util');

function resource(bundle, url) {
  const m = /^jsc:\/\/(.+)$/.exec(String(url).trim());
  return m ? bundle.resources[`jsc/${m[1]}`] : undefined;
}

function headersProxy(getMsg) {
  return new Proxy({}, {
    get: (t, k) => (typeof k === 'string' ? getMsg().getHeader(k) ?? undefined : undefined),
    set: (t, k, v) => { getMsg().setHeader(k, Array.isArray(v) ? v.join(', ') : v); return true; },
    deleteProperty: (t, k) => { getMsg().removeHeader(k); return true; },
    has: (t, k) => getMsg().getHeader(k) !== null,
    ownKeys: () => Object.keys(getMsg().headers),
    getOwnPropertyDescriptor: (t, k) => (getMsg().getHeader(k) !== null ? { enumerable: true, configurable: true, value: getMsg().getHeader(k) } : undefined),
  });
}

function queryProxy(getMsg) {
  return new Proxy({}, {
    get: (t, k) => (typeof k === 'string' ? getMsg().getQueryParam(k) ?? undefined : undefined),
    set: (t, k, v) => { getMsg().setQueryParam(k, v); return true; },
    deleteProperty: (t, k) => { getMsg().removeQueryParam(k); return true; },
    ownKeys: () => [...new Set(getMsg().query.map(([k]) => k))],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  });
}

function messageApi(getMsg) {
  return {
    get headers() { return headersProxy(getMsg); },
    get queryParams() { return queryProxy(getMsg); },
    get content() { return getMsg().content; },
    set content(v) { getMsg().content = v === null || v === undefined ? '' : String(v); },
    get body() { const m = getMsg(); return { get asJSON() { try { return JSON.parse(m.content); } catch { return undefined; } }, get asString() { return m.content; } }; },
    get status() { return getMsg().status; },
    set status(v) { getMsg().status = Number(v); },
    get method() { return getMsg().verb; },
    set method(v) { getMsg().verb = String(v).toUpperCase(); },
    get url() { return getMsg().uri; },
    get path() { return getMsg().path; },
  };
}

function toJs(v) { return v === null || v === undefined ? null : v; }

function execute(policy, ctx, svc, exec, bundle) {
  const cfg = policy.config;
  const url = text(child(cfg, 'ResourceURL')).trim();
  const fail = (msg, code = 'ScriptExecutionFailed') => new Fault({ name: code, errorcode: `steps.javascript.${code}`, status: 500, faultstring: msg });
  const main = resource(bundle, url);
  if (main === undefined) throw fail(`Could not locate a resource with URL ${url || '(empty ResourceURL)'}`, 'NoResourceForURL');
  const sources = [];
  for (const inc of arr(child(cfg, 'IncludeURL'))) {
    const s = resource(bundle, text(inc));
    if (s === undefined) throw fail(`Could not locate a resource with URL ${text(inc)}`, 'NoResourceForURL');
    sources.push(s);
  }
  sources.push(main);
  const properties = {};
  for (const p of arr(child(child(cfg, 'Properties'), 'Property'))) properties[attr(p, 'name')] = text(p);
  const timeLimit = Number(attr(cfg, 'timeLimit') || 200);
  const prints = ctx.prints || [];
  const print = (...args) => prints.push(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
  const context = {
    getVariable: (n) => toJs(ctx.getVariable(n)),
    setVariable: (n, v) => { ctx.setVariable(n, v); },
    removeVariable: (n) => { ctx.removeVariable(n); },
    flow: ctx.flow,
    session: {},
    proxyRequest: messageApi(() => ctx.request),
    targetRequest: messageApi(() => ctx.request),
    targetResponse: messageApi(() => ctx.response),
    proxyResponse: messageApi(() => ctx.response),
  };
  const sandbox = {
    context, properties, print,
    console: { log: print, info: print, warn: print, error: print },
    request: messageApi(() => ctx.request),
    response: messageApi(() => ctx.response),
    crypto: {
      getSHA256: () => { const h = crypto.createHash('sha256'); return { update: (s) => h.update(String(s)), digest: () => h.digest('hex'), digest64: () => h.digest('base64') }; },
      getMD5: () => { const h = crypto.createHash('md5'); return { update: (s) => h.update(String(s)), digest: () => h.digest('hex'), digest64: () => h.digest('base64') }; },
    },
  };
  try {
    const file = url.replace('jsc://', '');
    vm.runInNewContext(sources.join('\n;\n'), sandbox, { timeout: timeLimit, filename: file });
  } catch (e) {
    if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw fail(`Execution of ${policy.name} failed with error: Javascript runtime exceeded limit of ${timeLimit}ms (script timed out)`);
    }
    const where = e && e.stack ? (/\((?:.*?):(\d+)/.exec(e.stack.split('\n')[1] || '') || [])[1] : null;
    throw fail(`Execution of ${policy.name} failed with error: Javascript runtime error: "${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : e}${where ? `. (line ${where})` : ''}"`);
  }
}

module.exports = { execute };
