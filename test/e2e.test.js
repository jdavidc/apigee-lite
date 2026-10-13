'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { startServers } = require('../server');

let srv;
let gw;
let mg;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MG = (p) => `${mg}/v1/organizations/practice${p}`;

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigee-lite-'));
  srv = await startServers({ mgmtPort: 0, gatewayPort: 0, mockPort: 0, dataDir, quiet: true });
  gw = `http://127.0.0.1:${srv.ports.gateway}`;
  mg = `http://127.0.0.1:${srv.ports.mgmt}`;
});

test.after(async () => { if (srv) await srv.close(); });

test('management UI and API are served', async () => {
  const ui = await fetch(mg + '/');
  assert.equal(ui.status, 200);
  assert.match(await ui.text(), /Apigee Lite/);
  const apis = await (await fetch(MG('/apis'))).json();
  for (const n of ['orders-v1', 'oauth', 'hello-world', 'broken-orders']) assert.ok(apis.includes(n), n);
  const dep = await (await fetch(MG('/environments/test/deployments'))).json();
  assert.equal(dep.apis['orders-v1'], '1');
  assert.equal(dep.sharedflows['security-baseline'], '1');
});

test('hello-world answers without a target', async () => {
  const r = await fetch(gw + '/hello');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).message, 'Hello, World!');
});

test('unknown base path returns Edge ApplicationNotFound', async () => {
  const r = await fetch(gw + '/nope');
  assert.equal(r.status, 404);
  assert.equal((await r.json()).fault.detail.errorcode, 'messaging.adaptors.http.flow.ApplicationNotFound');
});

test('orders-v1: 401 without key, 200 with seeded key, 429 on burst', async () => {
  let r = await fetch(gw + '/orders/v1/orders');
  assert.equal(r.status, 401);
  assert.equal((await r.json()).fault, 'FailedToResolveAPIKey');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');

  r = await fetch(gw + '/orders/v1/orders', { headers: { 'x-api-key': 'practice-key-123' } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.count, 3);
  assert.equal(r.headers.get('x-order-count'), '3');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');

  await sleep(250);
  r = await fetch(gw + '/orders/v1/orders/2', { headers: { 'x-api-key': 'practice-key-123' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-order-id'), '2');

  await sleep(250);
  const burst = await Promise.all(Array.from({ length: 6 }, () => fetch(gw + '/orders/v1/orders', { headers: { 'x-api-key': 'practice-key-123' } })));
  const codes = burst.map((x) => x.status);
  assert.ok(codes.includes(429), `expected a 429 in ${codes}`);
  const limited = burst.find((x) => x.status === 429);
  assert.equal((await limited.json()).fault, 'SpikeArrestViolation');

  const tx = await (await fetch(MG('/environments/test/apis/orders-v1/trace'))).json();
  assert.ok(tx.length >= 3);
  const detail = await (await fetch(MG(`/environments/test/apis/orders-v1/trace/${tx[1].id}`))).json();
  assert.ok(detail.steps.some((s) => s.policy === 'JS-TransformOrders' && s.executed && s.prints.length));
});

test('oauth: client_credentials token, then call the protected resource', async () => {
  const basic = 'Basic ' + Buffer.from('practice-key-123:practice-secret-456').toString('base64');
  let r = await fetch(gw + '/oauth/token', { method: 'POST', headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  assert.equal(r.status, 200);
  const tok = await r.json();
  assert.ok(tok.access_token);
  r = await fetch(gw + '/oauth/protected', { headers: { authorization: 'Bearer ' + tok.access_token } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).app, 'practice-app');
  r = await fetch(gw + '/oauth/protected');
  assert.equal(r.status, 401);
});

test('trace/send proxies a request through the gateway', async () => {
  const r = await fetch(MG('/trace/send'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ env: 'test', verb: 'GET', path: '/hello/abc', headers: {} }) });
  const j = await r.json();
  assert.equal(j.status, 200);
  assert.match(j.body, /"pathsuffix":"\/abc"/);
});

test('create, edit, deploy a proxy through the management API, then export/import it', async () => {
  const post = (p, body) => fetch(MG(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let r = await post('/apis', { name: 'echo-proxy', basePath: '/echo-proxy', targetType: 'mock', targetPath: '/echo' });
  assert.equal(r.status, 201);
  const files = (await (await fetch(MG('/apis/echo-proxy/revisions/1/files'))).json()).files;
  files['apiproxy/policies/AM-Tag.xml'] = '<AssignMessage name="AM-Tag"><Set><Headers><Header name="x-tag">lite</Header></Headers></Set><AssignTo createNew="false" type="request"/></AssignMessage>';
  files['apiproxy/proxies/default.xml'] = files['apiproxy/proxies/default.xml'].replace('<PreFlow name="PreFlow">\n        <Request/>', '<PreFlow name="PreFlow">\n        <Request><Step><Name>AM-Tag</Name></Step></Request>');
  r = await fetch(MG('/apis/echo-proxy/revisions/1/files'), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files }) });
  assert.deepEqual((await r.json()).errors, []);
  r = await fetch(MG('/environments/test/apis/echo-proxy/revisions/1/deployments'), { method: 'POST' });
  assert.equal(r.status, 200);
  r = await fetch(gw + '/echo-proxy/x?y=1');
  assert.equal(r.status, 200);
  const echoed = await r.json();
  assert.equal(echoed.path, '/echo/x');
  assert.equal(echoed.headers['x-tag'], 'lite');
  assert.equal(echoed.headers['x-security-baseline'], undefined);

  const zip = Buffer.from(await (await fetch(MG('/apis/orders-v1/revisions/1?format=bundle'))).arrayBuffer());
  r = await fetch(MG('/apis?action=import&name=orders-copy'), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: zip });
  assert.equal(r.status, 201);
  const imp = await r.json();
  assert.equal(imp.revision, '1');
  assert.deepEqual(imp.errors, []);

  r = await fetch(MG('/environments/test/apis/orders-copy/revisions/1/deployments'), { method: 'POST' });
  assert.equal(r.status, 409);
});

test('mock backend endpoints', async () => {
  const mock = `http://127.0.0.1:${srv.ports.mock}`;
  assert.equal((await fetch(mock + '/orders')).status, 200);
  assert.equal((await fetch(mock + '/status/503')).status, 503);
  const x = await fetch(mock + '/xml');
  assert.match(x.headers.get('content-type'), /xml/);
  const e = await (await fetch(mock + '/echo/a?b=1', { method: 'POST', body: 'hi' })).json();
  assert.equal(e.method, 'POST');
  assert.equal(e.body, 'hi');
});
