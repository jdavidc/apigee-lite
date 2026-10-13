const test = require('node:test');
const assert = require('node:assert/strict');
const { query } = require('../src/runtime/jsonpath');

const doc = {
  store: { name: 'S', books: [{ title: 'A', price: 1 }, { title: 'B', price: 2 }] },
  'odd key': 7,
};

test('dot and bracket notation', () => {
  assert.deepEqual(query(doc, '$.store.name'), ['S']);
  assert.deepEqual(query(doc, "$['odd key']"), [7]);
  assert.deepEqual(query(doc, '$.store.books[1].title'), ['B']);
  assert.deepEqual(query(doc, '$.store.books[-1].title'), ['B']);
});

test('wildcards and recursive descent', () => {
  assert.deepEqual(query(doc, '$.store.books[*].title'), ['A', 'B']);
  assert.deepEqual(query(doc, '$..price'), [1, 2]);
  assert.deepEqual(query(doc, '$.store.*').length, 2);
});

test('missing paths return empty array', () => {
  assert.deepEqual(query(doc, '$.nope.x'), []);
  assert.deepEqual(query(doc, '$.store.books[9]'), []);
});

test('filter expressions with == and >', () => {
  assert.deepEqual(query(doc, "$.store.books[?(@.title == 'B')].price"), [2]);
  assert.deepEqual(query(doc, '$.store.books[?(@.price > 1)].title'), ['B']);
});
