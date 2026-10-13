'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { proxyXml, step, makeBundle, run, seededStore, json, createServices } = require('./helpers');

const va = '<VerifyAPIKey name="VA"><APIKey ref="request.header.x-api-key"/></VerifyAPIKey>';
const vaBundle = () => makeBundle({ proxy: proxyXml({ pre: step('VA') }), policies: [va] });

test('VerifyAPIKey: valid key populates app/product variables', async () => {
  const r = await run(vaBundle(), { headers: { 'x-api-key': 'key-1' } });
  assert.equal(r.response.status, 200);
  const g = (n) => r.ctx.getVariable(n);
  assert.equal(g('verifyapikey.VA.client_id'), 'key-1');
  assert.equal(g('verifyapikey.VA.client_secret'), 'secret-1');
  assert.equal(g('client_id'), 'key-1');
  assert.equal(g('developer.app.name'), 'app1');
  assert.equal(g('verifyapikey.VA.developer.email'), 'dev@example.com');
  assert.equal(g('apiproduct.name'), 'prod1');
  assert.equal(g('verifyapikey.VA.apiproduct.developer.quota.limit'), '3');
  assert.equal(g('verifyapikey.VA.apiproduct.developer.quota.interval'), '1');
  assert.equal(g('verifyapikey.VA.apiproduct.developer.quota.timeunit'), 'minute');
});

test('VerifyAPIKey: invalid, revoked and wrong-resource keys', async () => {
  let r = await run(vaBundle(), { headers: { 'x-api-key': 'nope' } });
  assert.equal(r.response.status, 401);
  assert.deepEqual(json(r).fault, { faultstring: 'Invalid ApiKey', detail: { errorcode: 'oauth.v2.InvalidApiKey' } });
  assert.equal(r.ctx.getVariable('fault.name'), 'InvalidApiKey');

  const store = seededStore();
  store.setAppStatus('dev@example.com', 'app1', 'revoked');
  r = await run(vaBundle(), { headers: { 'x-api-key': 'key-1' } }, { store });
  assert.equal(r.response.status, 401);
  assert.equal(json(r).fault.detail.errorcode, 'keymanagement.service.invalid_client-app_not_approved');

  const store2 = seededStore();
  store2.updateProduct('prod1', { proxies: ['some-other-proxy'] });
  r = await run(vaBundle(), { headers: { 'x-api-key': 'key-1' } }, { store: store2 });
  assert.equal(r.response.status, 401);
  assert.equal(json(r).fault.detail.errorcode, 'oauth.v2.InvalidApiKeyForGivenResource');
});

const tokenPolicy = `<OAuthV2 name="GenToken"><Operation>GenerateAccessToken</Operation><ExpiresIn>3600000</ExpiresIn>
  <SupportedGrantTypes><GrantType>client_credentials</GrantType><GrantType>password</GrantType></SupportedGrantTypes>
  <GrantType>request.formparam.grant_type</GrantType><Scope>request.formparam.scope</Scope><GenerateResponse enabled="true"/></OAuthV2>`;
const verifyPolicy = (scope = '') => `<OAuthV2 name="VerifyToken"><Operation>VerifyAccessToken</Operation>${scope ? `<Scope>${scope}</Scope>` : ''}</OAuthV2>`;
const basic = (id, secret) => 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
const form = { 'content-type': 'application/x-www-form-urlencoded' };

function oauthSetup(scope) {
  const services = createServices({ store: seededStore(), env: 'test', httpRequest: async () => ({ status: 200, headers: {}, body: '' }) });
  const tokenB = makeBundle({ proxy: proxyXml({ pre: step('GenToken') }), policies: [tokenPolicy] });
  const apiB = makeBundle({ proxy: proxyXml({ pre: step('VerifyToken') }), policies: [verifyPolicy(scope)] });
  return { services, tokenB, apiB };
}

test('OAuthV2 GenerateAccessToken (client_credentials) and VerifyAccessToken', async () => {
  const { services, tokenB, apiB } = oauthSetup();
  const r = await run(tokenB, { verb: 'POST', headers: { ...form, authorization: basic('key-1', 'secret-1') }, body: 'grant_type=client_credentials&scope=read' }, { services });
  assert.equal(r.response.status, 200);
  const body = json(r);
  assert.ok(body.access_token);
  assert.equal(body.token_type, 'BearerToken');
  assert.equal(body.client_id, 'key-1');
  assert.equal(body.application_name, 'app1');
  assert.equal(body.scope, 'read');
  assert.equal(body.expires_in, '3599');
  assert.equal(r.ctx.getVariable('oauthv2accesstoken.GenToken.access_token'), body.access_token);

  const ok = await run(apiB, { headers: { authorization: 'Bearer ' + body.access_token } }, { services });
  assert.equal(ok.response.status, 200);
  assert.equal(ok.ctx.getVariable('client_id'), 'key-1');
  assert.equal(ok.ctx.getVariable('developer.app.name'), 'app1');
  assert.equal(ok.ctx.getVariable('scope'), 'read');

  const missing = await run(apiB, {}, { services });
  assert.equal(missing.response.status, 401);
  assert.equal(json(missing).fault.detail.errorcode, 'oauth.v2.InvalidAccessToken');
  const bad = await run(apiB, { headers: { authorization: 'Bearer nope' } }, { services });
  assert.equal(bad.response.status, 401);
  assert.equal(json(bad).fault.faultstring, 'Invalid Access Token');
});

test('OAuthV2 errors: invalid client, unsupported grant type, insufficient scope', async () => {
  const { services, tokenB } = oauthSetup();
  let r = await run(tokenB, { verb: 'POST', headers: { ...form, authorization: basic('key-1', 'wrong') }, body: 'grant_type=client_credentials' }, { services });
  assert.equal(r.response.status, 401);
  assert.deepEqual(json(r), { ErrorCode: 'invalid_client', Error: 'ClientId is Invalid' });
  r = await run(tokenB, { verb: 'POST', headers: { ...form, authorization: basic('key-1', 'secret-1') }, body: 'grant_type=implicit' }, { services });
  assert.equal(r.response.status, 400);
  assert.equal(json(r).ErrorCode, 'unsupported_grant_type');

  const s2 = oauthSetup('write');
  const t = await run(s2.tokenB, { verb: 'POST', headers: { ...form, authorization: basic('key-1', 'secret-1') }, body: 'grant_type=client_credentials&scope=read' }, { services: s2.services });
  r = await run(s2.apiB, { headers: { authorization: 'Bearer ' + json(t).access_token } }, { services: s2.services });
  assert.equal(r.response.status, 403);
  assert.deepEqual(json(r).fault, { faultstring: 'Required scope(s) : write', detail: { errorcode: 'steps.oauth.v2.InsufficientScope' } });
});

test('OAuthV2 password grant and expired tokens', async () => {
  const { services, apiB } = oauthSetup();
  const shortB = makeBundle({ proxy: proxyXml({ pre: step('GenToken') }), policies: [tokenPolicy.replace('3600000', '1')] });
  let r = await run(shortB, { verb: 'POST', headers: { ...form, authorization: basic('key-1', 'secret-1') }, body: 'grant_type=password' }, { services });
  assert.equal(r.response.status, 400);
  assert.equal(json(r).ErrorCode, 'invalid_request');
  r = await run(shortB, { verb: 'POST', headers: { ...form, authorization: basic('key-1', 'secret-1') }, body: 'grant_type=password&username=u&password=p' }, { services });
  assert.equal(r.response.status, 200);
  await new Promise((res) => setTimeout(res, 10));
  r = await run(apiB, { headers: { authorization: 'Bearer ' + json(r).access_token } }, { services });
  assert.equal(r.response.status, 401);
  assert.deepEqual(json(r).fault, { faultstring: 'Access Token expired', detail: { errorcode: 'keymanagement.service.access_token_expired' } });
});

test('BasicAuthentication Encode and Decode', async () => {
  const enc = `<BasicAuthentication name="BA"><Operation>Encode</Operation><User ref="u"/><Password ref="p"/><AssignTo createNew="false">request.header.Authorization</AssignTo></BasicAuthentication>`;
  const dec = `<BasicAuthentication name="BD"><Operation>Decode</Operation><User ref="out.user"/><Password ref="out.pass"/><Source>request.header.Authorization</Source></BasicAuthentication>`;
  const setVars = `<AssignMessage name="SV"><AssignVariable><Name>u</Name><Value>alice</Value></AssignVariable><AssignVariable><Name>p</Name><Value>s3cret</Value></AssignVariable></AssignMessage>`;
  let r = await run(makeBundle({ proxy: proxyXml({ pre: step('SV') + step('BA') }), policies: [enc, setVars] }));
  assert.equal(r.ctx.getVariable('request.header.Authorization'), basic('alice', 's3cret'));
  const decB = makeBundle({ proxy: proxyXml({ pre: step('BD') }), policies: [dec] });
  r = await run(decB, { headers: { authorization: basic('bob', 'pw') } });
  assert.equal(r.ctx.getVariable('out.user'), 'bob');
  assert.equal(r.ctx.getVariable('out.pass'), 'pw');
  r = await run(decB);
  assert.equal(r.response.status, 500);
  assert.equal(json(r).fault.detail.errorcode, 'steps.basicauthentication.UnresolvedVariable');
  r = await run(decB, { headers: { authorization: 'Bearer x' } });
  assert.equal(json(r).fault.detail.errorcode, 'steps.basicauthentication.InvalidBasicAuthenticationSource');
});

test('AccessControl denies matching IPs', async () => {
  const ac = (action, ip, mask) => `<AccessControl name="AC"><IPRules noRuleMatchAction="ALLOW"><MatchRule action="${action}"><SourceAddress mask="${mask}">${ip}</SourceAddress></MatchRule></IPRules></AccessControl>`;
  let r = await run(makeBundle({ proxy: proxyXml({ pre: step('AC') }), policies: [ac('DENY', '10.1.0.0', 16)] }), { clientIp: '10.1.2.3' });
  assert.equal(r.response.status, 403);
  assert.equal(json(r).fault.detail.errorcode, 'accesscontrol.IPDeniedAccess');
  r = await run(makeBundle({ proxy: proxyXml({ pre: step('AC') }), policies: [ac('DENY', '10.1.0.0', 16)] }), { clientIp: '10.2.0.1' });
  assert.equal(r.response.status, 200);
});

test('JSONThreatProtection enforces limits', async () => {
  const p = `<JSONThreatProtection name="JTP"><ArrayElementCount>2</ArrayElementCount><ContainerDepth>2</ContainerDepth><ObjectEntryCount>3</ObjectEntryCount><ObjectEntryNameLength>5</ObjectEntryNameLength><StringValueLength>5</StringValueLength><Source>request</Source></JSONThreatProtection>`;
  const b = makeBundle({ proxy: proxyXml({ pre: step('JTP') }), policies: [p] });
  const send = (body) => run(b, { verb: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal((await send('{"a":[1,2],"b":"ok"}')).response.status, 200);
  for (const bad of ['{"a":[1,2,3]}', '{"a":{"b":{"c":1}}}', '{"a":1,"b":2,"c":3,"d":4}', '{"toolongname":1}', '{"a":"toolongvalue"}', '{bad json']) {
    const r = await send(bad);
    assert.equal(r.response.status, 500, bad);
    assert.equal(json(r).fault.detail.errorcode, 'steps.jsonthreatprotection.ExecutionFailed');
  }
});

test('GenerateJWT and VerifyJWT (HS256)', async () => {
  const setKey = `<AssignMessage name="Key"><AssignVariable><Name>private.key</Name><Value>super-secret-key-of-32-bytes-len!</Value></AssignVariable></AssignMessage>`;
  const gen = (exp) => `<GenerateJWT name="GJ"><Algorithm>HS256</Algorithm><SecretKey><Value ref="private.key"/></SecretKey><Subject>user-1</Subject><Issuer>apigee-lite</Issuer><Audience>orders</Audience><ExpiresIn>${exp}</ExpiresIn><AdditionalClaims><Claim name="role" type="string">admin</Claim></AdditionalClaims><OutputVariable>jwt.out</OutputVariable></GenerateJWT>`;
  const ver = `<VerifyJWT name="VJ"><Algorithm>HS256</Algorithm><Source>inbound.jwt</Source><SecretKey><Value ref="private.key"/></SecretKey><Issuer>apigee-lite</Issuer><Audience>orders</Audience></VerifyJWT>`;
  const genB = (exp) => makeBundle({ proxy: proxyXml({ pre: step('Key') + step('GJ') }), policies: [setKey, gen(exp)] });
  let r = await run(genB('1h'));
  const token = r.ctx.getVariable('jwt.out');
  assert.equal(token.split('.').length, 3);
  const setIn = (t) => `<AssignMessage name="In"><AssignVariable><Name>inbound.jwt</Name><Value>${t}</Value></AssignVariable></AssignMessage>`;
  const verB = (t) => makeBundle({ proxy: proxyXml({ pre: step('Key') + step('In') + step('VJ') }), policies: [setKey, setIn(t), ver] });
  r = await run(verB(token));
  assert.equal(r.response.status, 200);
  assert.equal(r.ctx.getVariable('jwt.VJ.valid'), true);
  assert.equal(r.ctx.getVariable('jwt.VJ.claim.subject'), 'user-1');
  assert.equal(r.ctx.getVariable('jwt.VJ.claim.role'), 'admin');
  r = await run(verB(token.slice(0, -2) + 'xx'));
  assert.equal(r.response.status, 401);
  assert.equal(json(r).fault.detail.errorcode, 'steps.jwt.InvalidToken');
  r = await run(genB('-10s'));
  r = await run(verB(r.ctx.getVariable('jwt.out')));
  assert.equal(json(r).fault.detail.errorcode, 'steps.jwt.TokenExpired');
  r = await run(verB('garbage'));
  assert.equal(json(r).fault.detail.errorcode, 'steps.jwt.FailedToDecode');
});

test('RegularExpressionProtection detects threats', async () => {
  const p = `<RegularExpressionProtection name="REP"><Source>request</Source><QueryParam name="q"><Pattern>[\\s]*(?i)((delete)|(drop)|(select))</Pattern></QueryParam></RegularExpressionProtection>`;
  const b = makeBundle({ proxy: proxyXml({ pre: step('REP') }), policies: [p] });
  assert.equal((await run(b, { query: 'q=hello' })).response.status, 200);
  const r = await run(b, { query: 'q=drop%20table' });
  assert.equal(r.response.status, 400);
  assert.equal(json(r).fault.detail.errorcode, 'steps.regexprotection.ThreatDetected');
});
