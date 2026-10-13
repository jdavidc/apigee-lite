'use strict';
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { OrgStore } = require('./src/store/org-store');
const { Runtime } = require('./src/runtime/runtime');
const { createGatewayApp } = require('./src/runtime/gateway');
const { createManagementRouter } = require('./src/management/api');
const { createMockApp } = require('./src/mock/mock-backend');
const { seed } = require('./src/seed');

const listen = (app, port) => new Promise((resolve, reject) => {
  const srv = app.listen(port, () => resolve(srv));
  srv.on('error', reject);
});

async function startServers({
  mgmtPort = Number(process.env.MGMT_PORT || 9000),
  gatewayPort = Number(process.env.GATEWAY_PORT || 9001),
  mockPort = Number(process.env.MOCK_PORT || 9002),
  dataDir = process.env.APIGEE_LITE_DATA || path.join(__dirname, 'data'),
  quiet = false,
} = {}) {
  const mock = await listen(createMockApp(), mockPort);
  const actualMock = mock.address().port;
  if (!fs.existsSync(path.join(dataDir, 'org.json'))) {
    seed(dataDir, { mockPort: actualMock });
    if (!quiet) console.log(`Seeded ${dataDir}`);
  }
  const store = new OrgStore(dataDir);
  for (const env of store.org.environments) {
    const ts = store.getTargetServer(env, 'mock-backend');
    if (ts && ts.host === 'localhost' && ts.port !== actualMock) store.putTargetServer(env, { ...ts, port: actualMock });
  }
  const runtime = new Runtime({ store });
  runtime.loadAll();

  let gwPort = gatewayPort;
  const gateway = await listen(createGatewayApp(runtime), gatewayPort);
  gwPort = gateway.address().port;

  const mgmt = express();
  mgmt.disable('x-powered-by');
  mgmt.use('/v1/organizations/:org', createManagementRouter({ store, runtime, gatewayPort: () => gwPort }));
  mgmt.use(express.static(path.join(__dirname, 'public')));
  const mgmtSrv = await listen(mgmt, mgmtPort);

  const ports = { mgmt: mgmtSrv.address().port, gateway: gwPort, mock: actualMock };
  if (!quiet) {
    console.log(`Apigee Lite management UI : http://localhost:${ports.mgmt}`);
    console.log(`Gateway (env test)        : http://localhost:${ports.gateway}`);
    console.log(`Gateway (env prod)        : http://prod.localhost:${ports.gateway}`);
    console.log(`Mock backend              : http://localhost:${ports.mock}`);
  }
  const close = () => Promise.all([mgmtSrv, gateway, mock].map((s) => new Promise((r) => { s.closeAllConnections && s.closeAllConnections(); s.close(() => r()); })));
  return { ports, store, runtime, close };
}

if (require.main === module) {
  startServers().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { startServers };
