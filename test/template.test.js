const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTemplate } = require('../src/runtime/template');

const vars = { 'a.b': 'X', 'request.header.user-agent': 'curl', n: 5 };
const get = (k) => (k in vars ? vars[k] : null);

test('substitutes {variables}', () => {
  assert.equal(resolveTemplate('hi {a.b}!', get), 'hi X!');
  assert.equal(resolveTemplate('{request.header.user-agent}/{n}', get), 'curl/5');
});

test('unresolved variables become empty string', () => {
  assert.equal(resolveTemplate('[{missing}]', get), '[]');
});

test('JSON braces are left alone', () => {
  assert.equal(resolveTemplate('{"v":"{a.b}","o":{"k":1}}', get), '{"v":"X","o":{"k":1}}');
});

test('custom prefix and suffix', () => {
  assert.equal(resolveTemplate('{"v":"@a.b#"}', get, { prefix: '@', suffix: '#' }), '{"v":"X"}');
});

test('strict mode throws on unresolved', () => {
  assert.throws(() => resolveTemplate('{missing}', get, { strict: true }), /missing/);
});
