'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { proxyXml, targetXml, step, makeBundle, run, seededStore, json, createServices } = require('./helpers');
const { loadBundle } = require('../src/runtime/bundle-loader');

const js = (name, file, extra = '') => `<Javascript name="${name}" timeLimit="200"><ResourceURL>jsc://${file}</ResourceURL>${extra}</Javascript>`;

test('JavaScript: context.getVariable/setVariable/removeVariable and print', async () => {
  const code = `var v = context.getVariable('request.queryparam.n');
    context.setVariable('doubled', String(Number(v) * 2));
    context.setVariable('request.header.x-js', 'set-by-js');
    context.removeVariable('request.header.x-drop');
    context.setVariable('flowName', context.flow);
    context.setVariable('prop', properties.greeting);
    print('n is ' + v);`;
  const b = makeBundle({ proxy: proxyXml({ pre: step('JS') }), policies: [js('JS', 'calc.js', '<Properties><Property name="greeting">hi</Property></Properties>')], resources: { 'jsc/calc.js': code } });
  const r = await run(b, { query: 'n=21', headers: { 'x-drop': '1' } });
  const g = (n) => r.ctx.getVariable(n);
  assert.equal(g('doubled'), '42');
  assert.equal(g('request.header.x-js'), 'set-by-js');
  assert.equal(g('request.header.x-drop'), null);
  assert.equal(g('flowName'), 'PROXY_REQ_FLOW');
  assert.equal(g('prop'), 'hi');
  const s = r.trace.steps.find((x) => x.policy === 'JS');
  assert.deepEqual(s.prints, ['n is 21']);
});

test('JavaScript: message objects transform the response body and headers', async () => {
  const code = `var body = JSON.parse(context.targetResponse.content);
    body.count = body.items.length;
    context.targetResponse.content = JSON.stringify(body);
    context.targetResponse.headers['x-count'] = String(body.count);
    context.setVariable('reqHeader', context.proxyRequest.headers['x-in']);
    context.setVariable('verb', context.proxyRequest.method);`;
  const b = makeBundle({
    proxy: proxyXml({ routeRules: '<RouteRule name="d"><TargetEndpoint>default</TargetEndpoint></RouteRule>' }),
    targets: { default: targetXml({ preResp: step('JS') }) },
    policies: [js('JS', 't.js')], resources: { 'jsc/t.js': code },
  });
  const r = await run(b, { headers: { 'x-in': 'abc' } }, { httpRequest: async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"items":[1,2,3]}' }) });
  assert.deepEqual(json(r), { items: [1, 2, 3], count: 3 });
  assert.equal(r.response.headers['x-count'], '3');
  assert.equal(r.ctx.getVariable('reqHeader'), 'abc');
  assert.equal(r.ctx.getVariable('verb'), 'GET');
  assert.equal(r.ctx.getVariable('flow'), null);
});

test('JavaScript: runtime errors and timeLimit produce ScriptExecutionFailed', async () => {
  let b = makeBundle({ proxy: proxyXml({ pre: step('JS') }), policies: [js('JS', 'bad.js')], resources: { 'jsc/bad.js': 'undefinedFn();' } });
  let r = await run(b);
  assert.equal(r.response.status, 500);
  assert.equal(json(r).fault.detail.errorcode, 'steps.javascript.ScriptExecutionFailed');
  assert.match(json(r).fault.faultstring, /Execution of JS failed with error: Javascript runtime error: "ReferenceError: undefinedFn is not defined/);
  b = makeBundle({ proxy: proxyXml({ pre: step('JS') }), policies: [js('JS', 'loop.js').replace('200', '30')], resources: { 'jsc/loop.js': 'while(true){}' } });
  r = await run(b);
  assert.equal(r.response.status, 500);
  assert.match(json(r).fault.faultstring, /timed out/i);
  const missing = makeBundle({ proxy: proxyXml({ pre: step('JS') }), policies: [js('JS', 'nope.js')] });
  r = await run(missing);
  assert.equal(r.response.status, 500);
});

test('JavaScript: IncludeURL scripts are loaded first', async () => {
  const b = makeBundle({
    proxy: proxyXml({ pre: step('JS') }),
    policies: [js('JS', 'main.js', '<IncludeURL>jsc://lib.js</IncludeURL>')],
    resources: { 'jsc/lib.js': 'function shout(s){ return s.toUpperCase(); }', 'jsc/main.js': "context.setVariable('out', shout('hey'));" },
  });
  const r = await run(b);
  assert.equal(r.ctx.getVariable('out'), 'HEY');
});

function sharedFlow() {
  return loadBundle({
    'sharedflowbundle/sec.xml': '<SharedFlowBundle name="sec" revision="1"/>',
    'sharedflowbundle/sharedflows/default.xml': `<SharedFlow name="default"><Step><Name>AM-Mark</Name></Step><Step><Name>RF-Block</Name><Condition>request.header.block = "true"</Condition></Step></SharedFlow>`,
    'sharedflowbundle/policies/AM-Mark.xml': '<AssignMessage name="AM-Mark"><AssignVariable><Name>shared.ran</Name><Ref>myParam</Ref></AssignVariable></AssignMessage>',
    'sharedflowbundle/policies/RF-Block.xml': '<RaiseFault name="RF-Block"><FaultResponse><Set><StatusCode>403</StatusCode><Payload contentType="text/plain">blocked</Payload></Set></FaultResponse></RaiseFault>',
  }, 'sharedflowbundle');
}

test('FlowCallout runs a deployed shared flow with parameters', async () => {
  const fc = `<FlowCallout name="FC"><Parameters><Parameter name="myParam">from-proxy</Parameter></Parameters><SharedFlowBundle>sec</SharedFlowBundle></FlowCallout>`;
  const b = makeBundle({ proxy: proxyXml({ pre: step('FC') }), policies: [fc] });
  const getSharedFlow = (n) => (n === 'sec' ? sharedFlow() : null);
  let r = await run(b, {}, { getSharedFlow });
  assert.equal(r.response.status, 200);
  assert.equal(r.ctx.getVariable('shared.ran'), 'from-proxy');
  assert.ok(r.trace.steps.some((s) => s.policy === 'AM-Mark' && s.sharedFlow === 'sec'));
  r = await run(b, { headers: { block: 'true' } }, { getSharedFlow });
  assert.equal(r.response.status, 403);
  assert.equal(r.response.content, 'blocked');
  r = await run(b, {}, { getSharedFlow: () => null });
  assert.equal(r.response.status, 500);
  assert.equal(json(r).fault.detail.errorcode, 'flow.SharedFlowNotFound');
});

test('MessageLogging writes to the in-app log', async () => {
  const services = createServices({ store: seededStore(), env: 'test', httpRequest: async () => ({ status: 200, headers: {}, body: '' }) });
  const ml = `<MessageLogging name="ML"><Syslog><Message>{request.verb} {proxy.pathsuffix} -> {response.status.code}</Message></Syslog></MessageLogging>`;
  const b = makeBundle({ proxy: proxyXml({ postClient: step('ML') }), policies: [ml] });
  await run(b, { suffix: '/x' }, { services });
  const logs = services.logs.list();
  assert.ok(logs.some((l) => l.message === 'GET /x -> 200' && l.source === 'MessageLogging'));
});
