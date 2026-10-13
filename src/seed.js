'use strict';
const fs = require('node:fs');
const { OrgStore, KINDS } = require('./store/org-store');
const { loadBundle } = require('./runtime/bundle-loader');
const content = require('./seed-content');

const SEED = {
  products: [
    { name: 'orders-product', displayName: 'Orders Product', description: 'Full access to the Orders API and the OAuth endpoints', approvalType: 'auto', proxies: ['orders-v1', 'broken-orders', 'oauth'], environments: ['test', 'prod'], scopes: ['read', 'write'], quota: '100', quotaInterval: '1', quotaTimeUnit: 'minute' },
    { name: 'orders-bronze', displayName: 'Orders Bronze', description: 'Low quota tier for the Orders API', approvalType: 'auto', proxies: ['orders-v1'], environments: ['test', 'prod'], scopes: ['read'], quota: '5', quotaInterval: '1', quotaTimeUnit: 'minute' },
  ],
  developer: { email: 'jane.doe@example.com', firstName: 'Jane', lastName: 'Doe', userName: 'jane' },
  apps: [
    { name: 'practice-app', apiProducts: ['orders-product'], consumerKey: 'practice-key-123', consumerSecret: 'practice-secret-456', callbackUrl: 'https://example.com/callback' },
    { name: 'bronze-app', apiProducts: ['orders-bronze'], consumerKey: 'bronze-key-123', consumerSecret: 'bronze-secret-456' },
  ],
};

// Wipes dataDir and writes the seed org, bundles and deployments (to test).
function seed(dataDir, { mockPort = 9002 } = {}) {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const store = new OrgStore(dataDir);
  for (const [kind, bundles] of Object.entries(content)) {
    for (const [name, files] of Object.entries(bundles)) {
      const b = loadBundle(files, KINDS[kind]);
      if (b.errors.length) throw new Error(`Seed bundle ${name} is invalid: ${b.errors.map((e) => `${e.file}: ${e.message}`).join('; ')}`);
      const rev = store.createRevision(kind, name, files);
      store.setDeployment('test', kind, name, rev);
    }
  }
  for (const env of ['test', 'prod']) {
    store.putTargetServer(env, { name: 'mock-backend', host: 'localhost', port: mockPort, isEnabled: true });
    store.createKvm('env', env, { name: 'orders-config', encrypted: false, entry: [{ name: 'backend-label', value: 'mock-backend' }, { name: 'greeting', value: `Hello from ${env}` }] });
    store.createKvm('env', env, { name: 'orders-secrets', encrypted: true, entry: [{ name: 'jwt-signing-key', value: 'practice-signing-key-0123456789abcdef' }] });
  }
  SEED.products.forEach((p) => store.createProduct(p));
  store.createDeveloper(SEED.developer);
  SEED.apps.forEach((a) => store.createApp(SEED.developer.email, a));
  store.save();
  return store;
}

module.exports = { seed, SEED };
