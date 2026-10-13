'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { proxyXml, targetXml, step, makeBundle, run, seededStore, json, createServices } = require('./helpers');

const svc = (httpRequest) => createServices({ store: seededStore(), env: 'test', httpRequest: httpRequest || (async () => ({ status: 200, headers: {}, body: 'ok' })) });

test('SpikeArrest smooths traffic (2ps => 1 request per 500ms)', async () => {
  const services = svc();
  const b = makeBundle({ proxy: proxyXml({ pre: step('SA') }), policies: ['<SpikeArrest name="SA"><Rate>2ps</Rate></SpikeArrest>'] });
  assert.equal((await run(b, {}, { services })).response.status, 200);
  const r = await run(b, {}, { services });
  assert.equal(r.response.status, 429);
  assert.equal(json(r).fault.detail.errorcode, 'policies.ratelimit.SpikeArrestViolation');
  assert.match(json(r).fault.faultstring, /Spike arrest violation/);
  assert.equal(r.ctx.getVariable('ratelimit.SA.failed'), true);
  await new Promise((res) => setTimeout(res, 520));
  assert.equal((await run(b, {}, { services })).response.status, 200);
});

test('SpikeArrest uses Identifier ref to keep separate counters', async () => {
  const services = svc();
  const b = makeBundle({ proxy: proxyXml({ pre: step('SA') }), policies: ['<SpikeArrest name="SA"><Identifier ref="request.header.client"/><Rate>1pm</Rate></SpikeArrest>'] });
  assert.equal((await run(b, { headers: { client: 'a' } }, { services })).response.status, 200);
  assert.equal((await run(b, { headers: { client: 'b' } }, { services })).response.status, 200);
  assert.equal((await run(b, { headers: { client: 'a' } }, { services })).response.status, 429);
});

test('Quota enforces count and sets ratelimit variables', async () => {
  const services = svc();
  const b = makeBundle({ proxy: proxyXml({ pre: step('Q') }), policies: ['<Quota name="Q" type="calendar"><Allow count="2"/><Interval>1</Interval><TimeUnit>minute</TimeUnit><Distributed>true</Distributed><Synchronous>true</Synchronous></Quota>'] });
  let r = await run(b, {}, { services });
  assert.equal(r.ctx.getVariable('ratelimit.Q.allowed.count'), 2);
  assert.equal(r.ctx.getVariable('ratelimit.Q.used.count'), 1);
  assert.equal(r.ctx.getVariable('ratelimit.Q.available.count'), 1);
  await run(b, {}, { services });
  r = await run(b, {}, { services });
  assert.equal(r.response.status, 429);
  assert.equal(json(r).fault.detail.errorcode, 'policies.ratelimit.QuotaViolation');
  assert.match(json(r).fault.faultstring, /Rate limit quota violation/);
  assert.equal(r.ctx.getVariable('ratelimit.Q.exceed.count'), 1);
});

test('Quota can take its limit from the API product via VerifyAPIKey', async () => {
  const services = svc();
  const q = `<Quota name="Q"><Identifier ref="client_id"/><Allow count="100" countRef="verifyapikey.VA.apiproduct.developer.quota.limit"/><Interval ref="verifyapikey.VA.apiproduct.developer.quota.interval">1</Interval><TimeUnit ref="verifyapikey.VA.apiproduct.developer.quota.timeunit">hour</TimeUnit></Quota>`;
  const b = makeBundle({ proxy: proxyXml({ pre: step('VA') + step('Q') }), policies: ['<VerifyAPIKey name="VA"><APIKey ref="request.queryparam.apikey"/></VerifyAPIKey>', q] });
  for (let i = 0; i < 3; i++) assert.equal((await run(b, { query: 'apikey=key-1' }, { services })).response.status, 200);
  const r = await run(b, { query: 'apikey=key-1' }, { services });
  assert.equal(r.response.status, 429);
  assert.equal(r.ctx.getVariable('ratelimit.Q.allowed.count'), 3);
});

test('ResponseCache serves cached responses and skips the target', async () => {
  let calls = 0;
  const services = svc(async () => { calls++; return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'fresh-' + calls }; });
  const rc = `<ResponseCache name="RC"><CacheKey><KeyFragment ref="request.uri" type="string"/></CacheKey><ExpirySettings><TimeoutInSec>60</TimeoutInSec></ExpirySettings></ResponseCache>`;
  const b = makeBundle({
    proxy: proxyXml({ pre: step('RC'), postResp: step('RC'), routeRules: '<RouteRule name="d"><TargetEndpoint>default</TargetEndpoint></RouteRule>' }),
    targets: { default: targetXml() }, policies: [rc],
  });
  const r1 = await run(b, { suffix: '/a' }, { services });
  const r2 = await run(b, { suffix: '/a' }, { services });
  const r3 = await run(b, { suffix: '/b' }, { services });
  assert.equal(r1.response.content, 'fresh-1');
  assert.equal(r2.response.content, 'fresh-1');
  assert.equal(r2.ctx.getVariable('responsecache.RC.cachehit'), true);
  assert.equal(r3.response.content, 'fresh-2');
  assert.equal(calls, 2);
});

test('PopulateCache, LookupCache and InvalidateCache', async () => {
  const services = svc();
  const key = '<CacheKey><Prefix>p</Prefix><KeyFragment ref="request.queryparam.k"/></CacheKey>';
  const pc = `<PopulateCache name="PC">${key}<Scope>Exclusive</Scope><ExpirySettings><TimeoutInSec>60</TimeoutInSec></ExpirySettings><Source>request.queryparam.v</Source></PopulateCache>`;
  const lc = `<LookupCache name="LC">${key}<Scope>Exclusive</Scope><AssignTo>cached.value</AssignTo></LookupCache>`;
  const ic = `<InvalidateCache name="IC">${key}<Scope>Exclusive</Scope></InvalidateCache>`;
  const b = makeBundle({
    proxy: proxyXml({ pre: step('PC', 'request.queryparam.op = "put"') + step('IC', 'request.queryparam.op = "del"') + step('LC') }),
    policies: [pc, lc, ic],
  });
  let r = await run(b, { query: 'op=get&k=1' }, { services });
  assert.equal(r.ctx.getVariable('lookupcache.LC.cachehit'), false);
  await run(b, { query: 'op=put&k=1&v=hello' }, { services });
  r = await run(b, { query: 'op=get&k=1' }, { services });
  assert.equal(r.ctx.getVariable('lookupcache.LC.cachehit'), true);
  assert.equal(r.ctx.getVariable('cached.value'), 'hello');
  await run(b, { query: 'op=del&k=1' }, { services });
  r = await run(b, { query: 'op=get&k=1' }, { services });
  assert.equal(r.ctx.getVariable('lookupcache.LC.cachehit'), false);
});
