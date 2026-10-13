'use strict';
const { Fault, text, attr, child, arr, refOrText } = require('./_util');

function keyOf(ctx, node) {
  return arr(child(child(node, 'Key'), 'Parameter')).map((p) => { const v = refOrText(ctx, p); return v === null ? '' : String(v); }).join('__');
}

function execute(policy, ctx, svc) {
  const cfg = policy.config;
  const map = attr(cfg, 'mapIdentifier') || 'kvmap';
  const scopeName = (text(child(cfg, 'Scope')).trim() || 'environment').toLowerCase();
  let scope;
  let owner;
  if (scopeName === 'environment') { scope = 'env'; owner = svc.env; }
  else if (scopeName === 'apiproxy') { scope = 'api'; owner = ctx.getVariable('apiproxy.name'); }
  else if (scopeName === 'organization') { scope = 'org'; owner = svc.org; }
  else throw new Fault({ name: 'InvalidScope', errorcode: 'steps.keyvaluemapoperations.InvalidScope', status: 500, faultstring: `Scope ${scopeName} is not supported in Apigee Lite (use environment, apiproxy or organization)` });
  const store = svc.store;
  let kvm = store.getKvm(scope, owner, map);
  const initial = arr(child(child(cfg, 'InitialEntries'), 'Entry'));
  if (!kvm && initial.length) {
    kvm = store.createKvm(scope, owner, { name: map, encrypted: false, entry: initial.map((e) => ({ name: keyOf(ctx, e), value: text(arr(child(e, 'Value'))[0]) })) });
  }
  for (const put of arr(child(cfg, 'Put'))) {
    const key = keyOf(ctx, put);
    const val = refOrText(ctx, arr(child(put, 'Value'))[0]);
    const override = attr(put, 'override') === 'true';
    if (!override && store.kvmGet(scope, owner, map, key) !== null) continue;
    store.kvmPut(scope, owner, map, key, val === null ? '' : String(val));
  }
  for (const get of arr(child(cfg, 'Get'))) {
    const assignTo = attr(get, 'assignTo');
    const key = keyOf(ctx, get);
    kvm = store.getKvm(scope, owner, map);
    if (kvm && kvm.encrypted && !String(assignTo).startsWith('private.')) {
      throw new Fault({ name: 'UnsupportedOperationException', errorcode: 'steps.keyvaluemapoperations.UnsupportedOperationException', status: 500, faultstring: `Values from the encrypted map ${map} must be assigned to a variable with the prefix private. (assignTo=${assignTo})` });
    }
    const v = store.kvmGet(scope, owner, map, key);
    const index = attr(get, 'index');
    let out = v;
    if (v !== null && index) out = String(v).split(',')[Number(index) - 1] ?? v;
    ctx.setVariable(assignTo, out);
  }
  for (const del of arr(child(cfg, 'Delete'))) store.kvmDelete(scope, owner, map, keyOf(ctx, del));
}

module.exports = { execute };
