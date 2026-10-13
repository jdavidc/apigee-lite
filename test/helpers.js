'use strict';
const { loadBundle } = require('../src/runtime/bundle-loader');
const { executeProxy } = require('../src/runtime/flow-executor');
const { createServices } = require('../src/runtime/services');
const { OrgStore } = require('../src/store/org-store');

function proxyXml({ name = 'default', basePath = '/t', pre = '', preResp = '', flows = '', post = '', postResp = '', postClient = '', faultRules = '', defaultFaultRule = '', routeRules } = {}) {
  return `<ProxyEndpoint name="${name}">
  <PreFlow name="PreFlow"><Request>${pre}</Request><Response>${preResp}</Response></PreFlow>
  <Flows>${flows}</Flows>
  <PostFlow name="PostFlow"><Request>${post}</Request><Response>${postResp}</Response></PostFlow>
  ${postClient ? `<PostClientFlow name="PostClientFlow"><Response>${postClient}</Response></PostClientFlow>` : ''}
  <FaultRules>${faultRules}</FaultRules>
  ${defaultFaultRule}
  <HTTPProxyConnection><BasePath>${basePath}</BasePath><VirtualHost>default</VirtualHost></HTTPProxyConnection>
  ${routeRules === undefined ? '<RouteRule name="noroute"/>' : routeRules}
</ProxyEndpoint>`;
}

function targetXml({ name = 'default', url = 'http://backend.local', pre = '', preResp = '', flows = '', post = '', postResp = '', faultRules = '', defaultFaultRule = '', properties = '', connection } = {}) {
  return `<TargetEndpoint name="${name}">
  <PreFlow name="PreFlow"><Request>${pre}</Request><Response>${preResp}</Response></PreFlow>
  <Flows>${flows}</Flows>
  <PostFlow name="PostFlow"><Request>${post}</Request><Response>${postResp}</Response></PostFlow>
  <FaultRules>${faultRules}</FaultRules>
  ${defaultFaultRule}
  ${connection || `<HTTPTargetConnection><Properties>${properties}</Properties><URL>${url}</URL></HTTPTargetConnection>`}
</TargetEndpoint>`;
}

const step = (name, cond) => `<Step><Name>${name}</Name>${cond ? `<Condition>${cond}</Condition>` : ''}</Step>`;
const assignVar = (name, varName = 'v', value = name) =>
  `<AssignMessage name="${name}"><AssignVariable><Name>${varName}</Name><Value>${value}</Value></AssignVariable></AssignMessage>`;

function makeBundle({ name = 'testproxy', proxy, proxies, targets = {}, policies = [], resources = {} }) {
  const files = {};
  files[`apiproxy/${name}.xml`] = `<APIProxy name="${name}" revision="1"/>`;
  const px = proxies || { default: proxy };
  for (const [n, xml] of Object.entries(px)) files[`apiproxy/proxies/${n}.xml`] = xml;
  for (const [n, xml] of Object.entries(targets)) files[`apiproxy/targets/${n}.xml`] = xml;
  policies.forEach((xml, i) => {
    const m = /name="([^"]+)"/.exec(xml);
    files[`apiproxy/policies/${m ? m[1] : 'p' + i}.xml`] = xml;
  });
  for (const [p, c] of Object.entries(resources)) files[`apiproxy/resources/${p}`] = c;
  const bundle = loadBundle(files);
  if (bundle.errors.length) throw new Error('Bundle errors: ' + bundle.errors.map((e) => e.message).join('; '));
  return bundle;
}

function seededStore() {
  const store = new OrgStore(null);
  store.createProduct({ name: 'prod1', proxies: ['testproxy'], environments: ['test'], scopes: ['read', 'write'], quota: '3', quotaInterval: '1', quotaTimeUnit: 'minute' });
  store.createDeveloper({ email: 'dev@example.com', firstName: 'Dev', lastName: 'One', userName: 'dev' });
  store.createApp('dev@example.com', { name: 'app1', apiProducts: ['prod1'], consumerKey: 'key-1', consumerSecret: 'secret-1' });
  return store;
}

async function run(bundle, req = {}, opts = {}) {
  const services = opts.services || createServices({
    store: opts.store || seededStore(),
    env: 'test',
    httpRequest: opts.httpRequest || (async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' })),
    getSharedFlow: opts.getSharedFlow,
  });
  const basePath = Object.values(bundle.proxyEndpoints)[0].basePath;
  return executeProxy({
    bundle,
    endpointName: opts.endpointName || Object.keys(bundle.proxyEndpoints)[0],
    request: {
      verb: req.verb || 'GET',
      path: req.path || basePath + (req.suffix || ''),
      querystring: req.query || '',
      headers: req.headers || {},
      content: req.body || '',
    },
    clientIp: req.clientIp || '127.0.0.1',
    services,
  });
}

const executed = (trace) => trace.steps.filter((s) => s.kind === 'policy' && s.executed && !s.error).map((s) => s.policy);
const json = (r) => JSON.parse(r.response.content);

module.exports = { proxyXml, targetXml, step, assignVar, makeBundle, run, seededStore, executed, json, createServices };
