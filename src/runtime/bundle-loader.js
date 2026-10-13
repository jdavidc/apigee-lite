'use strict';
const { parseXml, rootOf, arr, text, attr, child, bool } = require('./xml');
const { parse: parseCondition } = require('./condition');
const policyModules = require('./policies');

const ROOTS = { apiproxy: 'apiproxy', sharedflowbundle: 'sharedflowbundle' };

function parseSteps(node) {
  return arr(child(node, 'Step')).map((s) => ({
    name: text(child(s, 'Name')).trim(),
    condition: text(child(s, 'Condition')).trim() || null,
  }));
}

const flowPart = (node) => ({ request: parseSteps(child(node, 'Request')), response: parseSteps(child(node, 'Response')) });

function parseFlows(node) {
  return arr(child(child(node, 'Flows'), 'Flow')).map((f) => ({
    name: attr(f, 'name') || '',
    condition: text(child(f, 'Condition')).trim() || null,
    ...flowPart(f),
  }));
}

function parseFaultRules(node) {
  return arr(child(child(node, 'FaultRules'), 'FaultRule')).map((r) => ({
    name: attr(r, 'name') || '',
    condition: text(child(r, 'Condition')).trim() || null,
    steps: parseSteps(r),
  }));
}

function parseDefaultFaultRule(node) {
  const d = child(node, 'DefaultFaultRule');
  if (d === undefined) return null;
  return { name: attr(d, 'name') || 'DefaultFaultRule', steps: parseSteps(d), alwaysEnforce: bool(child(d, 'AlwaysEnforce')), condition: text(child(d, 'Condition')).trim() || null };
}

function normalizeBasePath(p) {
  let s = String(p || '/').trim();
  if (!s.startsWith('/')) s = '/' + s;
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
}

function parseCommonEndpoint(node) {
  return {
    preFlow: flowPart(child(node, 'PreFlow')),
    flows: parseFlows(node),
    postFlow: flowPart(child(node, 'PostFlow')),
    faultRules: parseFaultRules(node),
    defaultFaultRule: parseDefaultFaultRule(node),
  };
}

function parseProxyEndpoint(node) {
  const conn = child(node, 'HTTPProxyConnection') || {};
  return {
    name: attr(node, 'name') || 'default',
    ...parseCommonEndpoint(node),
    postClientFlow: flowPart(child(node, 'PostClientFlow')),
    basePath: normalizeBasePath(text(child(conn, 'BasePath'))),
    virtualHosts: arr(child(conn, 'VirtualHost')).map(text),
    routeRules: arr(child(node, 'RouteRule')).map((r) => ({
      name: attr(r, 'name') || '',
      condition: text(child(r, 'Condition')).trim() || null,
      targetEndpoint: text(child(r, 'TargetEndpoint')).trim() || null,
      url: text(child(r, 'URL')).trim() || null,
    })),
  };
}

function parseProperties(node) {
  const props = {};
  for (const p of arr(child(child(node, 'Properties'), 'Property'))) props[attr(p, 'name')] = text(p);
  return props;
}

function parseTargetEndpoint(node) {
  const http = child(node, 'HTTPTargetConnection');
  const local = child(node, 'LocalTargetConnection');
  const lb = child(http, 'LoadBalancer');
  return {
    name: attr(node, 'name') || 'default',
    ...parseCommonEndpoint(node),
    connection: http !== undefined ? {
      url: text(child(http, 'URL')).trim() || null,
      path: text(child(http, 'Path')).trim() || '',
      properties: parseProperties(http),
      loadBalancer: lb !== undefined ? {
        algorithm: text(child(lb, 'Algorithm')) || 'RoundRobin',
        servers: arr(child(lb, 'Server')).map((s) => ({ name: attr(s, 'name'), isFallback: bool(child(s, 'IsFallback')) })),
      } : null,
    } : null,
    localConnection: local !== undefined ? { apiProxy: text(child(local, 'APIProxy')), proxyEndpoint: text(child(local, 'ProxyEndpoint')), path: text(child(local, 'Path')) } : null,
  };
}

function parsePolicy(tag, node, xml) {
  return {
    type: tag,
    name: attr(node, 'name') || '',
    displayName: text(child(node, 'DisplayName')),
    enabled: attr(node, 'enabled') !== 'false',
    continueOnError: attr(node, 'continueOnError') === 'true',
    async: attr(node, 'async') === 'true',
    config: node,
    xml,
  };
}

function lineOf(e) { return e && e.line ? e.line : undefined; }

function loadBundle(files, kind) {
  const keys = Object.keys(files);
  if (!kind) kind = keys.some((k) => k.startsWith('sharedflowbundle/')) ? 'sharedflowbundle' : 'apiproxy';
  const root = ROOTS[kind];
  const bundle = { kind, name: null, revision: null, description: '', proxyEndpoints: {}, targetEndpoints: {}, policies: {}, sharedFlows: {}, resources: {}, files, errors: [], warnings: [] };
  const err = (file, message, line) => bundle.errors.push({ file, message, line });

  for (const path of keys.sort()) {
    if (!path.startsWith(root + '/')) continue;
    const rel = path.slice(root.length + 1);
    const content = files[path];
    if (rel.startsWith('resources/')) { bundle.resources[rel.slice('resources/'.length)] = content; continue; }
    if (!rel.endsWith('.xml')) continue;
    let doc;
    try { doc = parseXml(content); } catch (e) { err(path, e.message, lineOf(e)); continue; }
    let r;
    try { r = rootOf(doc); } catch (e) { err(path, e.message); continue; }
    const { tag, node } = r;
    try {
      if (!rel.includes('/')) {
        bundle.name = attr(node, 'name') || rel.replace(/\.xml$/, '');
        bundle.revision = attr(node, 'revision') || null;
        bundle.description = text(child(node, 'Description'));
      } else if (rel.startsWith('proxies/')) {
        if (tag !== 'ProxyEndpoint') { err(path, `Expected <ProxyEndpoint> root element but found <${tag}>`); continue; }
        const pe = parseProxyEndpoint(node);
        bundle.proxyEndpoints[pe.name] = pe;
      } else if (rel.startsWith('targets/')) {
        if (tag !== 'TargetEndpoint') { err(path, `Expected <TargetEndpoint> root element but found <${tag}>`); continue; }
        const te = parseTargetEndpoint(node);
        bundle.targetEndpoints[te.name] = te;
      } else if (rel.startsWith('policies/')) {
        const p = parsePolicy(tag, node, content);
        if (!p.name) { err(path, `Policy <${tag}> is missing the name attribute`); continue; }
        if (bundle.policies[p.name]) err(path, `Duplicate policy name ${p.name}`);
        bundle.policies[p.name] = p;
        if (!policyModules.isSupported(tag)) bundle.warnings.push({ file: path, message: `Policy type ${tag} is not supported in Apigee Lite; it will fail at runtime.` });
      } else if (rel.startsWith('sharedflows/')) {
        if (tag !== 'SharedFlow') { err(path, `Expected <SharedFlow> root element but found <${tag}>`); continue; }
        bundle.sharedFlows[attr(node, 'name') || 'default'] = { name: attr(node, 'name') || 'default', steps: parseSteps(node) };
      }
    } catch (e) { err(path, e.message); }
  }
  if (!bundle.name) bundle.name = 'unnamed';
  validate(bundle, root);
  return bundle;
}

function validate(bundle, root) {
  const err = (file, message) => bundle.errors.push({ file, message });
  const checkCond = (file, c) => { if (c) { try { parseCondition(c); } catch (e) { err(file, e.message); } } };
  const checkSteps = (file, where, steps) => {
    for (const s of steps) {
      if (!s.name) err(file, `Step without <Name> in ${where}`);
      else if (!bundle.policies[s.name]) err(file, `Unresolved policy ${s.name} referenced in ${where}`);
      checkCond(file, s.condition);
    }
  };
  const checkEndpoint = (file, ep) => {
    for (const fl of ['preFlow', 'postFlow', 'postClientFlow']) {
      if (!ep[fl]) continue;
      checkSteps(file, `${fl} request`, ep[fl].request);
      checkSteps(file, `${fl} response`, ep[fl].response);
    }
    for (const f of ep.flows) {
      checkCond(file, f.condition);
      checkSteps(file, `Flow ${f.name} request`, f.request);
      checkSteps(file, `Flow ${f.name} response`, f.response);
    }
    for (const r of ep.faultRules) { checkCond(file, r.condition); checkSteps(file, `FaultRule ${r.name}`, r.steps); }
    if (ep.defaultFaultRule) checkSteps(file, 'DefaultFaultRule', ep.defaultFaultRule.steps);
  };
  if (bundle.kind === 'apiproxy') {
    if (!Object.keys(bundle.proxyEndpoints).length && !bundle.errors.length) err(`${root}/proxies`, 'An API proxy needs at least one ProxyEndpoint');
    for (const pe of Object.values(bundle.proxyEndpoints)) {
      const file = `${root}/proxies/${pe.name}.xml`;
      checkEndpoint(file, pe);
      for (const r of pe.routeRules) {
        checkCond(file, r.condition);
        if (r.targetEndpoint && !bundle.targetEndpoints[r.targetEndpoint]) err(file, `RouteRule ${r.name} references unknown TargetEndpoint ${r.targetEndpoint}`);
      }
    }
    for (const te of Object.values(bundle.targetEndpoints)) {
      const file = `${root}/targets/${te.name}.xml`;
      checkEndpoint(file, te);
      if (!te.connection && !te.localConnection) err(file, `TargetEndpoint ${te.name} needs an HTTPTargetConnection`);
      else if (te.connection && !te.connection.url && !te.connection.loadBalancer) err(file, `HTTPTargetConnection in ${te.name} needs a <URL> or <LoadBalancer>`);
    }
  } else {
    for (const sf of Object.values(bundle.sharedFlows)) checkSteps(`${root}/sharedflows/${sf.name}.xml`, `SharedFlow ${sf.name}`, sf.steps);
    if (!bundle.sharedFlows.default && !bundle.errors.length) err(`${root}/sharedflows`, 'A shared flow bundle needs sharedflows/default.xml');
  }
}

module.exports = { loadBundle, normalizeBasePath };
