const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, parse } = require('../src/runtime/condition');

const vars = {
  'request.verb': 'GET',
  'proxy.pathsuffix': '/orders/42',
  'response.status.code': '404',
  'request.header.x-api-key': 'abc',
  'fault.name': 'InvalidApiKey',
  'flag': 'false',
};
const get = (n) => (n in vars ? vars[n] : null);
const ev = (c) => evaluate(c, get);

test('equality operators', () => {
  assert.equal(ev('request.verb = "GET"'), true);
  assert.equal(ev('request.verb == "GET"'), true);
  assert.equal(ev('request.verb = GET'), true);
  assert.equal(ev('request.verb != "POST"'), true);
  assert.equal(ev('request.verb = "get"'), false);
  assert.equal(ev('request.verb := "get"'), true);
  assert.equal(ev('request.verb Equals "GET"'), true);
  assert.equal(ev('request.verb NotEquals "GET"'), false);
});

test('numeric comparison', () => {
  assert.equal(ev('response.status.code > 400'), true);
  assert.equal(ev('response.status.code >= 404'), true);
  assert.equal(ev('response.status.code < 500'), true);
  assert.equal(ev('response.status.code <= 403'), false);
  assert.equal(ev('response.status.code = 404'), true);
});

test('boolean logic with precedence and parentheses', () => {
  assert.equal(ev('request.verb = "POST" or request.verb = "GET"'), true);
  assert.equal(ev('request.verb = "GET" and fault.name = "x"'), false);
  assert.equal(ev('(request.verb = "GET") && (response.status.code = 404)'), true);
  assert.equal(ev('request.verb = "POST" || request.verb = "GET" && fault.name = "nope"'), false);
  assert.equal(ev('not (request.verb = "POST")'), true);
  assert.equal(ev('!(request.verb = "GET")'), false);
  assert.equal(ev('NOT request.verb = "POST" AND request.verb = "GET"'), true);
});

test('MatchesPath / LikePath / ~/', () => {
  assert.equal(ev('proxy.pathsuffix MatchesPath "/orders/*"'), true);
  assert.equal(ev('proxy.pathsuffix MatchesPath "/orders"'), false);
  assert.equal(ev('proxy.pathsuffix ~/ "/orders/**"'), true);
  assert.equal(ev('proxy.pathsuffix LikePath "/*"'), false);
  assert.equal(ev('proxy.pathsuffix MatchesPath "/**"'), true);
});

test('Matches, JavaRegex, StartsWith', () => {
  assert.equal(ev('proxy.pathsuffix Matches "/orders*"'), true);
  assert.equal(ev('proxy.pathsuffix ~ "/ord*"'), true);
  assert.equal(ev('proxy.pathsuffix ~ "ord*"'), false);
  assert.equal(ev('proxy.pathsuffix JavaRegex "/orders/[0-9]+"'), true);
  assert.equal(ev('proxy.pathsuffix ~~ "/orders/[a-z]+"'), false);
  assert.equal(ev('proxy.pathsuffix ~~ "orders"'), false);
  assert.equal(ev('proxy.pathsuffix StartsWith "/orders"'), true);
  assert.equal(ev('proxy.pathsuffix =| "/x"'), false);
});

test('null handling', () => {
  assert.equal(ev('request.header.missing = null'), true);
  assert.equal(ev('request.header.missing != null'), false);
  assert.equal(ev('request.header.x-api-key != null'), true);
  assert.equal(ev('request.header.missing = "a"'), false);
  assert.equal(ev('request.header.missing MatchesPath "/a"'), false);
});

test('bare variable and literals', () => {
  assert.equal(ev('request.header.x-api-key'), true);
  assert.equal(ev('request.header.missing'), false);
  assert.equal(ev('flag'), false);
  assert.equal(ev('true'), true);
  assert.equal(ev(''), true);
  assert.equal(ev(undefined), true);
});

test('single quoted strings and escaped quotes', () => {
  assert.equal(ev("request.verb = 'GET'"), true);
  assert.equal(evaluate('v = "a\\"b"', (n) => (n === 'v' ? 'a"b' : null)), true);
});

test('invalid conditions throw', () => {
  assert.throws(() => parse('(request.verb = "GET"'));
  assert.throws(() => parse('request.verb = '));
  assert.throws(() => parse('request.verb = "GET" junk'));
});
