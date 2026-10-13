'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { proxyXml, targetXml, step, makeBundle, run, seededStore, json, createServices } = require('./helpers');

const one = (xml, req, opts) => {
  const name = /name="([^"]+)"/.exec(xml)[1];
  return run(makeBundle({ proxy: proxyXml({ pre: step(name) }), policies: [xml] }), req, opts);
};

test('AssignMessage Set/Add/Remove on the request', async () => {
  const am = `<AssignMessage name="AM">
    <Remove><Headers><Header name="x-remove"/></Headers><QueryParams><QueryParam name="drop"/></QueryParams></Remove>
    <Add><Headers><Header name="x-added">{request.verb}</Header></Headers><QueryParams><QueryParam name="added">1</QueryParam></QueryParams></Add>
    <Set><Headers><Header name="x-set">v-{request.queryparam.keep}</Header></Headers><Verb>PUT</Verb><Path>/new/path</Path>
      <Payload contentType="application/json">{"verb":"{request.verb}","keep":"{request.queryparam.keep}"}</Payload></Set>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
    <AssignTo createNew="false" transport="http" type="request"/>
  </AssignMessage>`;
  const r = await one(am, { query: 'keep=k&drop=d', headers: { 'x-remove': '1' } });
  const g = (n) => r.ctx.getVariable(n);
  assert.equal(g('request.header.x-remove'), null);
  assert.equal(g('request.queryparam.drop'), null);
  assert.equal(g('request.header.x-added'), 'GET');
  assert.equal(g('request.queryparam.added'), '1');
  assert.equal(g('request.header.x-set'), 'v-k');
  assert.equal(g('request.verb'), 'PUT');
  assert.equal(g('request.header.content-type'), 'application/json');
  assert.deepEqual(JSON.parse(g('request.content')), { verb: 'GET', keep: 'k' });
});

test('AssignMessage on the response with status, reason phrase and variablePrefix', async () => {
  const am = `<AssignMessage name="AM"><Set><StatusCode>201</StatusCode><ReasonPhrase>Made</ReasonPhrase>
    <Payload contentType="application/json" variablePrefix="@" variableSuffix="#">{"id":"@request.queryparam.id#"}</Payload></Set>
    <AssignTo createNew="false" type="response"/></AssignMessage>`;
  const r = await one(am, { query: 'id=7' });
  assert.equal(r.response.status, 201);
  assert.equal(r.response.reasonPhrase, 'Made');
  assert.deepEqual(json(r), { id: '7' });
});

test('AssignMessage default target is the response in a response flow', async () => {
  const am = `<AssignMessage name="AM"><Set><Headers><Header name="x-resp">yes</Header></Headers></Set></AssignMessage>`;
  const r = await run(makeBundle({ proxy: proxyXml({ preResp: step('AM') }), policies: [am] }));
  assert.equal(r.response.headers['x-resp'], 'yes');
});

test('AssignMessage AssignVariable (Value, Ref, Template) and Copy', async () => {
  const am = `<AssignMessage name="AM">
    <AssignVariable><Name>a</Name><Value>literal</Value></AssignVariable>
    <AssignVariable><Name>b</Name><Ref>request.header.h1</Ref><Value>fallback</Value></AssignVariable>
    <AssignVariable><Name>c</Name><Ref>request.header.missing</Ref><Value>fallback</Value></AssignVariable>
    <AssignVariable><Name>d</Name><Template>{request.verb}-{request.header.h1}</Template></AssignVariable>
    <AssignTo createNew="true" type="request">myRequest</AssignTo>
    <Copy source="request"><Headers><Header name="h1"/></Headers><Payload>true</Payload><Verb>true</Verb></Copy>
  </AssignMessage>`;
  const r = await one(am, { verb: 'POST', headers: { h1: 'one' }, body: 'data' });
  const g = (n) => r.ctx.getVariable(n);
  assert.equal(g('a'), 'literal');
  assert.equal(g('b'), 'one');
  assert.equal(g('c'), 'fallback');
  assert.equal(g('d'), 'POST-one');
  assert.equal(g('myRequest.header.h1'), 'one');
  assert.equal(g('myRequest.content'), 'data');
  assert.equal(g('myRequest.verb'), 'POST');
});

test('ExtractVariables from URIPath, QueryParam, Header, FormParam and JSONPayload', async () => {
  const ev = `<ExtractVariables name="EV">
    <Source>request</Source><VariablePrefix>ex</VariablePrefix>
    <URIPath><Pattern ignoreCase="true">/orders/{orderId}</Pattern></URIPath>
    <QueryParam name="code"><Pattern>DBN{dbncode}</Pattern></QueryParam>
    <Header name="Authorization"><Pattern>Bearer {token}</Pattern></Header>
    <JSONPayload><Variable name="customer"><JSONPath>$.customer.name</JSONPath></Variable><Variable name="skus"><JSONPath>$.items[*].sku</JSONPath></Variable></JSONPayload>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables>
  </ExtractVariables>`;
  const r = await one(ev, { verb: 'POST', suffix: '/orders/123', query: 'code=DBN88', headers: { authorization: 'Bearer abc', 'content-type': 'application/json' }, body: '{"customer":{"name":"Ann"},"items":[{"sku":"A"},{"sku":"B"}]}' });
  const g = (n) => r.ctx.getVariable(n);
  assert.equal(g('ex.orderId'), '123');
  assert.equal(g('ex.dbncode'), '88');
  assert.equal(g('ex.token'), 'abc');
  assert.equal(g('ex.customer'), 'Ann');
  assert.equal(g('ex.skus'), '["A","B"]');

  const fp = `<ExtractVariables name="EV"><FormParam name="greeting"><Pattern>hello {user}</Pattern></FormParam></ExtractVariables>`;
  const r2 = await one(fp, { verb: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'greeting=hello%20bob' });
  assert.equal(r2.ctx.getVariable('user'), 'bob');
});

test('ExtractVariables faults on invalid JSON', async () => {
  const ev = `<ExtractVariables name="EV"><JSONPayload><Variable name="x"><JSONPath>$.a</JSONPath></Variable></JSONPayload><Source>request</Source></ExtractVariables>`;
  const r = await one(ev, { verb: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  assert.equal(r.response.status, 500);
  assert.equal(json(r).fault.detail.errorcode, 'steps.extractvariables.ExecutionFailed');
});

test('RaiseFault returns the configured FaultResponse', async () => {
  const rf = `<RaiseFault name="RF"><FaultResponse><Set><Headers><Header name="x-err">nf</Header></Headers>
    <Payload contentType="application/json">{"error":"not found","path":"{proxy.pathsuffix}"}</Payload><StatusCode>404</StatusCode><ReasonPhrase>Not Found</ReasonPhrase></Set></FaultResponse>
    <IgnoreUnresolvedVariables>true</IgnoreUnresolvedVariables></RaiseFault>`;
  const r = await one(rf, { suffix: '/zzz' });
  assert.equal(r.response.status, 404);
  assert.equal(r.response.headers['x-err'], 'nf');
  assert.deepEqual(json(r), { error: 'not found', path: '/zzz' });
  assert.equal(r.ctx.getVariable('fault.name'), 'RaiseFault');
});

test('RaiseFault without FaultResponse uses Edge default', async () => {
  const r = await one('<RaiseFault name="RF"/>');
  assert.equal(r.response.status, 500);
  assert.deepEqual(json(r).fault, { faultstring: 'Raising fault. Fault name : RF', detail: { errorcode: 'steps.raisefault.RaiseFault' } });
});

test('JSONToXML and XMLToJSON', async () => {
  const j2x = `<JSONToXML name="J2X"><Source>request</Source><OutputVariable>request</OutputVariable><Options><ObjectRootElementName>Root</ObjectRootElementName></Options></JSONToXML>`;
  let r = await one(j2x, { verb: 'POST', headers: { 'content-type': 'application/json' }, body: '{"order":{"id":1,"tags":["a","b"]}}' });
  const xml = r.ctx.getVariable('request.content');
  assert.match(xml, /<Root><order><id>1<\/id><tags>a<\/tags><tags>b<\/tags><\/order><\/Root>/);
  assert.match(r.ctx.getVariable('request.header.content-type'), /xml/);

  const x2j = `<XMLToJSON name="X2J"><Source>request</Source><OutputVariable>request</OutputVariable><Options/></XMLToJSON>`;
  r = await one(x2j, { verb: 'POST', headers: { 'content-type': 'text/xml' }, body: '<order id="9"><item>a</item><item>b</item><total>10</total></order>' });
  assert.deepEqual(JSON.parse(r.ctx.getVariable('request.content')), { order: { id: '9', item: ['a', 'b'], total: '10' } });
  r = await one(x2j.replace('<Options/>', '<Options><RecognizeNumber>true</RecognizeNumber></Options>'), { verb: 'POST', headers: { 'content-type': 'text/xml' }, body: '<o><total>10</total></o>' });
  assert.deepEqual(JSON.parse(r.ctx.getVariable('request.content')), { o: { total: 10 } });
  r = await one(x2j, { verb: 'POST', headers: { 'content-type': 'text/xml' }, body: '<broken' });
  assert.equal(json(r).fault.detail.errorcode, 'steps.xmltojson.ExecutionFailed');
});

test('KeyValueMapOperations Put/Get/Delete and encrypted maps', async () => {
  const store = seededStore();
  store.createKvm('env', 'test', { name: 'cfg', encrypted: false });
  store.createKvm('env', 'test', { name: 'secrets', encrypted: true, entry: [{ name: 'pw', value: 'hunter2' }] });
  const services = createServices({ store, env: 'test', httpRequest: async () => ({ status: 200, headers: {}, body: '' }) });
  const put = `<KeyValueMapOperations name="KP" mapIdentifier="cfg"><Scope>environment</Scope><Put override="true"><Key><Parameter>color</Parameter></Key><Value ref="request.queryparam.c"/></Put></KeyValueMapOperations>`;
  const get = `<KeyValueMapOperations name="KG" mapIdentifier="cfg"><Scope>environment</Scope><Get assignTo="out.color" index="1"><Key><Parameter>color</Parameter></Key></Get></KeyValueMapOperations>`;
  const del = `<KeyValueMapOperations name="KD" mapIdentifier="cfg"><Scope>environment</Scope><Delete><Key><Parameter>color</Parameter></Key></Delete></KeyValueMapOperations>`;
  await one(put, { query: 'c=blue' }, { services });
  assert.equal(store.getKvm('env', 'test', 'cfg').entry.find((e) => e.name === 'color').value, 'blue');
  let r = await one(get, {}, { services });
  assert.equal(r.ctx.getVariable('out.color'), 'blue');
  await one(del, {}, { services });
  r = await one(get, {}, { services });
  assert.equal(r.ctx.getVariable('out.color'), null);

  const encOk = `<KeyValueMapOperations name="KE" mapIdentifier="secrets"><Scope>environment</Scope><Get assignTo="private.pw"><Key><Parameter>pw</Parameter></Key></Get></KeyValueMapOperations>`;
  r = await one(encOk, {}, { services });
  assert.equal(r.ctx.getVariable('private.pw'), 'hunter2');
  r = await one(encOk.replace('private.pw', 'pw'), {}, { services });
  assert.equal(r.response.status, 500);
  assert.match(json(r).fault.faultstring, /private/);
});

test('ServiceCallout sends a request variable and stores the response', async () => {
  const seen = [];
  const services = createServices({
    store: seededStore(), env: 'test',
    httpRequest: async (q) => { seen.push(q); return q.url.includes('fail') ? { status: 500, headers: {}, body: 'err' } : { status: 200, headers: { 'content-type': 'application/json' }, body: '{"rate":1.1}' }; },
  });
  const sc = (url) => `<ServiceCallout name="SC"><Request clearPayload="true" variable="calloutRequest"><Set><Verb>POST</Verb><Headers><Header name="x-from">{apiproxy.name}</Header></Headers><Payload contentType="application/json">{"q":1}</Payload></Set></Request><Response>calloutResponse</Response><HTTPTargetConnection><URL>${url}</URL></HTTPTargetConnection></ServiceCallout>`;
  let r = await one(sc('http://rates.local/fx'), {}, { services });
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, 'http://rates.local/fx');
  assert.equal(seen[0].headers['x-from'], 'testproxy');
  assert.equal(r.ctx.getVariable('calloutResponse.status.code'), 200);
  assert.equal(r.ctx.getVariable('calloutResponse.content'), '{"rate":1.1}');
  r = await one(sc('http://rates.local/fail'), {}, { services });
  assert.equal(r.response.status, 500);
  assert.equal(json(r).fault.detail.errorcode, 'steps.servicecallout.ExecutionFailed');
});
