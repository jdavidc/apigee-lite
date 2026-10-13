'use strict';
const { evaluate } = require('../condition');

function resourceMatches(resources, suffix) {
  if (!resources || !resources.length) return true;
  return resources.some((r) => {
    if (r === '/' || r === '/**') return true;
    try { return evaluate('s MatchesPath "' + r.replace(/"/g, '') + '"', () => suffix || '/'); } catch { return false; }
  });
}

// Finds the first approved product on a credential that grants access to this proxy/env/path.
function matchProduct(store, productNames, proxyName, env, suffix) {
  for (const name of productNames) {
    const p = store.getProduct(name);
    if (!p) continue;
    const proxyOk = !p.proxies || !p.proxies.length || p.proxies.includes(proxyName);
    const envOk = !p.environments || !p.environments.length || p.environments.includes(env);
    if (proxyOk && envOk && resourceMatches(p.apiResources, suffix)) return p;
  }
  return null;
}

function approvedProducts(credential) {
  return (credential.apiProducts || []).filter((p) => (p.status || 'approved') === 'approved').map((p) => p.apiproduct);
}

function setProductVars(ctx, prefix, product) {
  const set = (k, v) => { ctx.setVariable(prefix ? `${prefix}.${k}` : k, v); };
  set('apiproduct.name', product.name);
  set('apiproduct.developer.quota.limit', product.quota != null && product.quota !== '' ? String(product.quota) : null);
  set('apiproduct.developer.quota.interval', product.quotaInterval != null && product.quotaInterval !== '' ? String(product.quotaInterval) : null);
  set('apiproduct.developer.quota.timeunit', product.quotaTimeUnit || null);
  for (const a of product.attributes || []) set(`apiproduct.${a.name}`, a.value);
}

module.exports = { matchProduct, approvedProducts, setProductVars };
