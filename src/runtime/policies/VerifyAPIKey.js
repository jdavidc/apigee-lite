'use strict';
const { Fault, text, attr, child } = require('./_util');
const { matchProduct, approvedProducts, setProductVars } = require('./_product');

function fail(ctx, policy, f) {
  ctx.setVariable(`oauthV2.${policy.name}.failed`, true);
  return new Fault({ status: 401, ...f });
}

function execute(policy, ctx, svc) {
  const node = child(policy.config, 'APIKey');
  const ref = attr(node, 'ref');
  const key = ref ? ctx.getVariable(ref) : text(node).trim();
  if (key === null || key === undefined || key === '') {
    throw fail(ctx, policy, { name: 'FailedToResolveAPIKey', errorcode: 'steps.oauth.v2.FailedToResolveAPIKey', faultstring: `Failed to resolve API Key variable ${ref || ''}`.trim() });
  }
  const found = svc.store.findByConsumerKey(String(key));
  if (!found) throw fail(ctx, policy, { name: 'InvalidApiKey', errorcode: 'oauth.v2.InvalidApiKey', faultstring: 'Invalid ApiKey' });
  const { developer, app, credential } = found;
  const notApproved = app.status !== 'approved' || credential.status !== 'approved' || (developer.status && developer.status !== 'active');
  if (notApproved) {
    throw fail(ctx, policy, { name: 'ApiKeyNotApproved', errorcode: 'keymanagement.service.invalid_client-app_not_approved', faultstring: 'ApiKey not approved' });
  }
  const product = matchProduct(svc.store, approvedProducts(credential), ctx.getVariable('apiproxy.name'), svc.env, ctx.getVariable('proxy.pathsuffix'));
  if (!product) throw fail(ctx, policy, { name: 'InvalidApiKeyForGivenResource', errorcode: 'oauth.v2.InvalidApiKeyForGivenResource', faultstring: 'Invalid ApiKey for given resource' });

  const p = `verifyapikey.${policy.name}`;
  const set = (k, v) => ctx.setVariable(`${p}.${k}`, v);
  set('client_id', credential.consumerKey);
  set('client_secret', credential.consumerSecret);
  set('redirection_uris', app.callbackUrl || '');
  set('developer.app.name', app.name);
  set('developer.app.id', app.appId);
  set('app.name', app.name);
  set('developer.email', developer.email);
  set('developer.id', developer.developerId);
  set('developer.firstName', developer.firstName);
  set('developer.lastName', developer.lastName);
  set('status', credential.status);
  set('apiproduct.name', product.name);
  set('failed', false);
  for (const a of app.attributes || []) set(`app.${a.name}`, a.value);
  for (const a of developer.attributes || []) set(`developer.${a.name}`, a.value);
  setProductVars(ctx, p, product);
  setProductVars(ctx, '', product);
  ctx.setVariable('client_id', credential.consumerKey);
  ctx.setVariable('developer.app.name', app.name);
  ctx.setVariable('developer.email', developer.email);
  ctx.setVariable('developer.id', developer.developerId);
  ctx.setVariable(`oauthV2.${policy.name}.failed`, false);
}

module.exports = { execute };
