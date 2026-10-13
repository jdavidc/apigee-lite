// Installs the jobsite-conditions-v1 proxy and its org configuration into a running Apigee Lite.
// Idempotent: safe to run again after edits or after `npm run seed`.
// Usage: node scripts/install-jobsite-conditions.js [env]   (env defaults to test)

const path = require('path');
const AdmZip = require('adm-zip');

const MGMT = `http://localhost:${process.env.MGMT_PORT || 9000}/v1/organizations/practice`;
const PROXY = 'jobsite-conditions-v1';
const PRODUCT = 'jobsite-conditions-product';
const DEVELOPER = 'jane.doe@example.com';
const APP = 'practice-app';
const ENVIRONMENTS = ['test', 'prod'];
const DEPLOY_ENV = process.argv[2] || 'test';

const THRESHOLDS = {
  windCautionKmh: 30,
  windRestrictedKmh: 50,
  gustRestrictedKmh: 60,
  precipitationCautionMm: 2,
  temperatureLowC: -20,
  temperatureHighC: 40,
};

async function call(method, url, body, contentType = 'application/json') {
  const res = await fetch(MGMT + url, {
    method,
    headers: body ? { 'Content-Type': contentType } : {},
    body: body && contentType === 'application/json' ? JSON.stringify(body) : body,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

async function ensure(label, result, okStatuses = [200, 201]) {
  const r = await result;
  if (!okStatuses.includes(r.status)) throw new Error(`${label} failed (${r.status}): ${JSON.stringify(r.data)}`);
  console.log(`ok  ${label}`);
  return r.data;
}

async function main() {
  for (const env of ENVIRONMENTS) {
    await ensure(`TargetServer open-meteo (${env})`, call('PUT', `/environments/${env}/targetservers/open-meteo`, {
      host: 'api.open-meteo.com', port: 443, isEnabled: true, sSLInfo: { enabled: true },
    }));

    const kvm = await call('GET', `/environments/${env}/keyvaluemaps/jobsite-config`);
    if (kvm.status === 404) {
      await ensure(`KVM jobsite-config (${env})`, call('POST', `/environments/${env}/keyvaluemaps`, { name: 'jobsite-config', encrypted: false }));
    }
    await ensure(`KVM entry advisory-thresholds (${env})`, call('POST', `/environments/${env}/keyvaluemaps/jobsite-config/entries`, {
      name: 'advisory-thresholds', value: JSON.stringify(THRESHOLDS),
    }));
  }

  const zip = new AdmZip();
  zip.addLocalFolder(path.join(__dirname, '..', 'bundles', PROXY, 'apiproxy'), 'apiproxy');
  const imported = await ensure(`Import ${PROXY}`, call('POST', `/apis?action=import&name=${PROXY}`, zip.toBuffer(), 'application/octet-stream'));
  if (imported.errors && imported.errors.length) throw new Error(`Bundle validation errors: ${imported.errors.join('; ')}`);
  for (const w of imported.warnings || []) console.log(`warn ${w}`);

  const product = {
    name: PRODUCT,
    displayName: 'Jobsite Conditions',
    description: 'Jobsite weather conditions and operating advisory for equipment fleets',
    approvalType: 'auto',
    proxies: [PROXY],
    environments: ENVIRONMENTS,
    scopes: ['read'],
    quota: '60', quotaInterval: '1', quotaTimeUnit: 'minute',
  };
  const existing = await call('GET', `/apiproducts/${PRODUCT}`);
  await ensure(`API product ${PRODUCT}`, existing.status === 404 ? call('POST', '/apiproducts', product) : call('PUT', `/apiproducts/${PRODUCT}`, product));

  const app = await ensure(`Read app ${APP}`, call('GET', `/developers/${DEVELOPER}/apps/${APP}`));
  const products = new Set(app.credentials[0].apiProducts.map((p) => p.apiproduct));
  products.add(PRODUCT);
  await ensure(`Subscribe ${APP} to ${PRODUCT}`, call('PUT', `/developers/${DEVELOPER}/apps/${APP}`, { apiProducts: [...products] }));

  const deployed = await ensure(`Deploy ${PROXY} r${imported.revision} to ${DEPLOY_ENV}`,
    call('POST', `/environments/${DEPLOY_ENV}/apis/${PROXY}/revisions/${imported.revision}/deployments`));
  console.log(`\n${PROXY} revision ${deployed.revision} is ${deployed.state} in ${DEPLOY_ENV}.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
