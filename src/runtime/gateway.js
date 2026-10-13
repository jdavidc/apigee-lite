'use strict';
const express = require('express');

function envFromHost(host) {
  const h = String(host || '').toLowerCase();
  return h.startsWith('prod.') ? 'prod' : 'test';
}

function createGatewayApp(runtime) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.raw({ type: () => true, limit: '10mb' }));
  app.use(async (req, res) => {
    const env = req.get('x-apigee-lite-env') || envFromHost(req.headers.host);
    const raw = req.originalUrl;
    const qi = raw.indexOf('?');
    const path = qi < 0 ? raw : raw.slice(0, qi);
    const headers = { ...req.headers };
    delete headers['x-apigee-lite-env'];
    const request = {
      verb: req.method,
      path,
      querystring: qi < 0 ? '' : raw.slice(qi + 1),
      headers,
      content: Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '',
    };
    const ip = (req.socket.remoteAddress || '127.0.0.1').replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1');
    try {
      const result = await runtime.handle(env, request, ip);
      if (!result) {
        res.status(404).type('application/json').send(JSON.stringify({ fault: { faultstring: `Unable to identify proxy for host: default and url: ${path}`, detail: { errorcode: 'messaging.adaptors.http.flow.ApplicationNotFound' } } }));
        return;
      }
      const r = result.response;
      res.status(r.status || 200);
      for (const [k, v] of Object.entries(r.headers)) {
        try { res.setHeader(k, v); } catch { /* skip invalid header values */ }
      }
      res.end(r.content || '');
    } catch (e) {
      res.status(500).type('application/json').send(JSON.stringify({ fault: { faultstring: e.message, detail: { errorcode: 'messaging.runtime.InternalError' } } }));
    }
  });
  return app;
}

module.exports = { createGatewayApp, envFromHost };
