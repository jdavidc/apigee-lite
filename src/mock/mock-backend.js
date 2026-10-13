'use strict';
const express = require('express');

function initialOrders() {
  return [
    { id: '1', customer: 'Ada Lovelace', item: 'Analytical Engine manual', quantity: 1, price: 42.5, status: 'shipped' },
    { id: '2', customer: 'Alan Turing', item: 'Enigma rotor set', quantity: 3, price: 19.99, status: 'processing' },
    { id: '3', customer: 'Grace Hopper', item: 'COBOL handbook', quantity: 2, price: 15, status: 'delivered' },
  ];
}

function createMockApp() {
  const app = express();
  app.disable('x-powered-by');
  let orders = initialOrders();
  let nextId = 4;

  app.use(async (req, res, next) => {
    const d = Number(req.query.delay);
    if (d > 0) await new Promise((r) => setTimeout(r, Math.min(d, 60000)));
    next();
  });
  app.use(express.text({ type: () => true, limit: '5mb' }));
  const parseBody = (req) => { try { return JSON.parse(req.body || '{}'); } catch { return null; } };

  app.get('/', (req, res) => res.json({ service: 'Apigee Lite mock backend', endpoints: ['/orders', '/orders/{id}', '/echo', '/status/{code}', '/xml', '/json', '?delay=ms'] }));
  app.get('/orders', (req, res) => {
    let list = orders;
    if (req.query.status) list = list.filter((o) => o.status === req.query.status);
    res.json(list);
  });
  app.get('/orders/:id', (req, res) => {
    const o = orders.find((x) => x.id === req.params.id);
    return o ? res.json(o) : res.status(404).json({ error: 'Order not found', id: req.params.id });
  });
  app.post('/orders', (req, res) => {
    const b = parseBody(req);
    if (!b || !b.customer || !b.item) return res.status(400).json({ error: 'customer and item are required' });
    const o = { id: String(nextId++), quantity: 1, price: 0, status: 'processing', ...b };
    orders.push(o);
    res.status(201).location(`/orders/${o.id}`).json(o);
  });
  app.put('/orders/:id', (req, res) => {
    const i = orders.findIndex((x) => x.id === req.params.id);
    const b = parseBody(req);
    if (i < 0) return res.status(404).json({ error: 'Order not found', id: req.params.id });
    if (!b) return res.status(400).json({ error: 'Invalid JSON' });
    orders[i] = { ...orders[i], ...b, id: req.params.id };
    res.json(orders[i]);
  });
  app.delete('/orders/:id', (req, res) => {
    const before = orders.length;
    orders = orders.filter((x) => x.id !== req.params.id);
    return orders.length < before ? res.status(204).end() : res.status(404).json({ error: 'Order not found', id: req.params.id });
  });
  app.post('/reset', (req, res) => { orders = initialOrders(); nextId = 4; res.json({ reset: true }); });
  app.all(/^\/echo(\/.*)?$/, (req, res) => {
    res.json({ method: req.method, path: req.path, query: req.query, headers: req.headers, body: req.body || '' });
  });
  app.all('/status/:code', (req, res) => {
    const code = Number(req.params.code) || 500;
    res.status(code).json({ status: code, message: `Mock backend returned ${code}` });
  });
  app.get('/xml', (req, res) => {
    res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?><orders><order id="1"><customer>Ada Lovelace</customer><total>42.5</total></order><order id="2"><customer>Alan Turing</customer><total>59.97</total></order></orders>');
  });
  app.get('/json', (req, res) => res.json({ orders: [{ id: 1, customer: 'Ada Lovelace', total: 42.5 }, { id: 2, customer: 'Alan Turing', total: 59.97 }] }));
  app.use((req, res) => res.status(404).json({ error: 'Not found on mock backend', path: req.path }));
  return app;
}

module.exports = { createMockApp };
