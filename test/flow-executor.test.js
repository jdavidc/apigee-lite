'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { proxyXml, targetXml, step, assignVar, makeBundle, run, executed, json } = require('./helpers');

const route = '<RouteRule name="default"><TargetEndpoint>default</TargetEndpoint></RouteRule>';
const names = ['P1', 'P2', 'P3', 'P4', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'P5', 'P6', 'P7', 'PC'];

test('executes flows in Edge order', async () => {
  const bundle = makeBundle({
    proxy: proxyXml({
      pre: step('P1'), flows: `<Flow name="f1"><Condition>proxy.pathsuffix MatchesPath "/a"</Condition><Request>${step('P2')}</Request><Response>${step('P6')}</Response></Flow>`,
      post: step('P3') + step('P4'), preResp: step('P5'), postResp: step('P7'), postClient: step('PC'), routeRules: route,
    }),
    targets: { default: targetXml({ pre: step('T1'), flows: `<Flow name="tf"><Request>${step('T2')}</Request><Response>${step('T5')}</Response></Flow>`, post: step('T3'), preResp: step('T4'), postResp: step('T6') }) },
    policies: names.map((n) => assignVar(n)),
  });
  const r = await run(bundle, { suffix: '/a' });
  assert.equal(r.response.status, 200);
  assert.deepEqual(executed(r.trace), ['P1', 'P2', 'P3', 'P4', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'P5', 'P6', 'P7', 'PC']);
});

test('only the first matching conditional flow runs', async () => {
  const bundle = makeBundle({
    proxy: proxyXml({
      flows: `<Flow name="get"><Condition>(proxy.pathsuffix MatchesPath "/items/*") and (request.verb = "GET")</Condition><Request>${step('A')}</Request></Flow>
              <Flow name="any"><Condition>proxy.pathsuffix MatchesPath "/items/**"</Condition><Request>${step('B')}</Request></Flow>
              <Flow name="catchall"><Request>${step('C')}</Request></Flow>`,
    }),
    policies: ['A', 'B', 'C'].map((n) => assignVar(n)),
  });
  assert.deepEqual(executed((await run(bundle, { suffix: '/items/1' })).trace), ['A']);
  assert.deepEqual(executed((await run(bundle, { suffix: '/items/1', verb: 'POST' })).trace), ['B']);
  const r = await run(bundle, { suffix: '/other' });
  assert.deepEqual(executed(r.trace), ['C']);
  assert.equal(r.ctx.getVariable('current.flow.name'), 'catchall');
});

test('step conditions and enabled=false are honoured and traced', async () => {
  const bundle = makeBundle({
    proxy: proxyXml({ pre: step('A', 'request.header.x-go = "yes"') + step('B') + step('C') }),
    policies: [assignVar('A'), assignVar('B').replace('name="B"', 'name="B" enabled="false"'), assignVar('C')],
  });
  const r = await run(bundle);
  assert.deepEqual(executed(r.trace), ['C']);
  const a = r.trace.steps.find((s) => s.policy === 'A');
  assert.equal(a.executed, false);
  assert.equal(a.conditionResult, false);
  assert.equal(a.condition, 'request.header.x-go = "yes"');
  const r2 = await run(bundle, { headers: { 'x-go': 'yes' } });
  assert.deepEqual(executed(r2.trace), ['A', 'C']);
  assert.ok(r2.trace.steps.find((s) => s.policy === 'A').changes.some((c) => c.name === 'v' && c.to === 'A'));
});

test('RouteRules: first matching rule wins, null route skips target', async () => {
  const bundle = makeBundle({
    proxy: proxyXml({
      routeRules: `<RouteRule name="b"><Condition>request.queryparam.t = "b"</Condition><TargetEndpoint>b</TargetEndpoint></RouteRule>
                   <RouteRule name="none"><Condition>request.queryparam.t = "none"</Condition></RouteRule>
                   <RouteRule name="default"><TargetEndpoint>default</TargetEndpoint></RouteRule>`,
    }),
    targets: { default: targetXml({ url: 'http://a.local' }), b: targetXml({ name: 'b', url: 'http://b.local/base' }) },
  });
  const calls = [];
  const httpRequest = async (req) => { calls.push(req.url); return { status: 200, headers: {}, body: 'x' }; };
  await run(bundle, { query: 't=b', suffix: '/p' }, { httpRequest });
  await run(bundle, { suffix: '/p' }, { httpRequest });
  const r = await run(bundle, { query: 't=none' }, { httpRequest });
  assert.deepEqual(calls, ['http://b.local/base/p?t=b', 'http://a.local/p']);
  assert.equal(r.response.status, 200);
  assert.equal(r.response.content, '');
});

test('policy fault produces Edge default fault JSON and skips remaining steps', async () => {
  const bundle = makeBundle({
    proxy: proxyXml({ pre: step('VA') + step('AFTER'), postResp: step('RESP'), routeRules: route }),
    targets: { default: targetXml() },
    policies: ['<VerifyAPIKey name="VA"><APIKey ref="request.queryparam.apikey"/></VerifyAPIKey>', assignVar('AFTER'), assignVar('RESP')],
  });
  const r = await run(bundle);
  assert.equal(r.response.status, 401);
  assert.deepEqual(json(r), { fault: { faultstring: 'Failed to resolve API Key variable request.queryparam.apikey', detail: { errorcode: 'steps.oauth.v2.FailedToResolveAPIKey' } } });
  assert.equal(r.response.headers['content-type'], 'application/json');
  assert.deepEqual(executed(r.trace), []);
  assert.equal(r.ctx.getVariable('fault.name'), 'FailedToResolveAPIKey');
  assert.equal(r.ctx.getVariable('is.error'), true);
  assert.equal(r.ctx.getVariable('error.state'), 'PROXY_REQ_FLOW');
});

test('ProxyEndpoint FaultRules: evaluated bottom-to-top, first match only; DefaultFaultRule fallback', async () => {
  const rf = (n, status) => `<AssignMessage name="${n}"><Set><StatusCode>${status}</StatusCode><Payload contentType="application/json">{"error":"${n}","fault":"{fault.name}"}</Payload></Set></AssignMessage>`;
  const mk = (alwaysEnforce) => makeBundle({
    proxy: proxyXml({
      pre: step('VA'),
      faultRules: `<FaultRule name="top"><Condition>fault.name = "InvalidApiKey"</Condition>${step('TOP')}</FaultRule>
                   <FaultRule name="bottom"><Condition>(fault.name = "InvalidApiKey") or (fault.name = "Other")</Condition>${step('BOTTOM')}</FaultRule>`,
      defaultFaultRule: `<DefaultFaultRule name="default">${step('DEF')}<AlwaysEnforce>${alwaysEnforce}</AlwaysEnforce></DefaultFaultRule>`,
    }),
    policies: ['<VerifyAPIKey name="VA"><APIKey ref="request.queryparam.apikey"/></VerifyAPIKey>', rf('TOP', 400), rf('BOTTOM', 403), `<AssignMessage name="DEF"><Set><Headers><Header name="x-default">yes</Header></Headers></Set></AssignMessage>`],
  });
  let r = await run(mk(false), { query: 'apikey=bad' });
  assert.equal(r.response.status, 403);
  assert.deepEqual(json(r), { error: 'BOTTOM', fault: 'InvalidApiKey' });
  assert.equal(r.response.headers['x-default'], undefined);
  r = await run(mk(true), { query: 'apikey=bad' });
  assert.equal(r.response.headers['x-default'], 'yes');
  r = await run(mk(false));
  assert.equal(r.response.status, 401);
  assert.equal(r.response.headers['x-default'], 'yes');
  assert.equal(json(r).fault.detail.errorcode, 'steps.oauth.v2.FailedToResolveAPIKey');
});

test('continueOnError lets the flow continue after a fault', async () => {
  const bundle = makeBundle({
    proxy: proxyXml({ pre: step('VA') + step('NEXT') }),
    policies: ['<VerifyAPIKey name="VA" continueOnError="true"><APIKey ref="request.queryparam.apikey"/></VerifyAPIKey>', assignVar('NEXT')],
  });
  const r = await run(bundle);
  assert.equal(r.response.status, 200);
  assert.deepEqual(executed(r.trace), ['NEXT']);
  assert.ok(r.trace.steps.find((s) => s.policy === 'VA').error);
  assert.equal(r.ctx.getVariable('fault.name'), 'FailedToResolveAPIKey');
});

test('target error status enters error flow, keeps target body, runs target then proxy FaultRules', async () => {
  const bundle = makeBundle({
    proxy: proxyXml({
      postResp: step('RESP'), routeRules: route,
      faultRules: `<FaultRule name="pfr"><Condition>fault.name = "ErrorResponseCode"</Condition>${step('PFR')}</FaultRule>`,
    }),
    targets: { default: targetXml({ faultRules: `<FaultRule name="tfr"><Condition>response.status.code = 500</Condition>${step('TFR')}</FaultRule>` }) },
    policies: [assignVar('RESP'), assignVar('PFR'), assignVar('TFR')],
  });
  const httpRequest = async () => ({ status: 500, headers: { 'content-type': 'text/plain' }, body: 'boom' });
  const r = await run(bundle, {}, { httpRequest });
  assert.equal(r.response.status, 500);
  assert.equal(r.response.content, 'boom');
  assert.deepEqual(executed(r.trace), ['TFR', 'PFR']);
  assert.equal(r.ctx.getVariable('error.state'), 'TARGET_RESP_FLOW');
});

test('success.codes treats listed statuses as success', async () => {
  const bundle = makeBundle({
    proxy: proxyXml({ postResp: step('RESP'), routeRules: route }),
    targets: { default: targetXml({ properties: '<Property name="success.codes">1xx,2xx,3xx,404</Property>' }) },
    policies: [assignVar('RESP')],
  });
  const r = await run(bundle, {}, { httpRequest: async () => ({ status: 404, headers: {}, body: 'nf' }) });
  assert.equal(r.response.status, 404);
  assert.deepEqual(executed(r.trace), ['RESP']);
});

test('target connection failure returns 503 ServiceUnavailable', async () => {
  const bundle = makeBundle({ proxy: proxyXml({ routeRules: route }), targets: { default: targetXml() } });
  const r = await run(bundle, {}, { httpRequest: async () => { throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }); } });
  assert.equal(r.response.status, 503);
  assert.equal(json(r).fault.detail.errorcode, 'messaging.adaptors.http.flow.ServiceUnavailable');
});

test('target.url set in target request flow overrides the URL', async () => {
  const bundle = makeBundle({
    proxy: proxyXml({ routeRules: route }),
    targets: { default: targetXml({ pre: step('SETURL') }) },
    policies: [assignVar('SETURL', 'target.url', 'http://other.local/x')],
  });
  let url;
  await run(bundle, { suffix: '/ignored' }, { httpRequest: async (q) => { url = q.url; return { status: 200, headers: {}, body: '' }; } });
  assert.equal(url, 'http://other.local/x');
});

test('unsupported policy types fail loudly', async () => {
  const bundle = makeBundle({ proxy: proxyXml({ pre: step('XSL') }), policies: ['<XSL name="XSL"><ResourceURL>xsl://a.xsl</ResourceURL></XSL>'] });
  const r = await run(bundle);
  assert.equal(r.response.status, 500);
  assert.match(json(r).fault.faultstring, /XSL.*not supported in Apigee Lite/);
  assert.equal(json(r).fault.detail.errorcode, 'apigeelite.UnsupportedPolicy');
});

test('flow variables are populated', async () => {
  const bundle = makeBundle({ proxy: proxyXml({ basePath: '/v1/shop' }) });
  const r = await run(bundle, { verb: 'POST', suffix: '/cart/9', query: 'a=1&b=x%20y', headers: { 'x-h': 'hv' }, body: 'payload' });
  const g = (n) => r.ctx.getVariable(n);
  assert.equal(g('proxy.basepath'), '/v1/shop');
  assert.equal(g('proxy.pathsuffix'), '/cart/9');
  assert.equal(g('request.verb'), 'POST');
  assert.equal(g('request.path'), '/v1/shop/cart/9');
  assert.equal(g('request.uri'), '/v1/shop/cart/9?a=1&b=x%20y');
  assert.equal(g('request.querystring'), 'a=1&b=x%20y');
  assert.equal(g('request.queryparam.b'), 'x y');
  assert.equal(g('request.header.X-H'), 'hv');
  assert.equal(g('request.content'), 'payload');
  assert.equal(g('apiproxy.name'), 'testproxy');
  assert.equal(g('environment.name'), 'test');
  assert.equal(g('client.ip'), '127.0.0.1');
  assert.ok(g('messageid'));
  assert.ok(Number(g('system.timestamp')) > 0);
});

test('a fault inside a response flow is handled and response flows stop', async () => {
  const bundle = makeBundle({
    proxy: proxyXml({ preResp: step('RF') + step('AFTER') }),
    policies: ['<RaiseFault name="RF"><FaultResponse><Set><StatusCode>418</StatusCode><Payload contentType="text/plain">teapot</Payload></Set></FaultResponse></RaiseFault>', assignVar('AFTER')],
  });
  const r = await run(bundle);
  assert.equal(r.response.status, 418);
  assert.equal(r.response.content, 'teapot');
  assert.equal(r.ctx.getVariable('fault.name'), 'RaiseFault');
  assert.deepEqual(executed(r.trace), []);
});
