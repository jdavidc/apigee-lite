'use strict';
const crypto = require('node:crypto');
const { Fault, text, attr, child, arr, bool, refOrText } = require('./_util');
const { matchProduct, approvedProducts, setProductVars } = require('./_product');

const oauthError = (status, code, message) => new Fault({ name: code, errorcode: `oauth.v2.${code}`, status, faultstring: message, body: { ErrorCode: code, Error: message } });

function newToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(28);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function varFromElement(ctx, cfg, tag, ...defaults) {
  const node = child(cfg, tag);
  if (node !== undefined) {
    const ref = attr(node, 'ref') || text(node).trim();
    return ref ? ctx.getVariable(ref) : null;
  }
  for (const d of defaults) { const v = ctx.getVariable(d); if (v !== null && v !== undefined && v !== '') return v; }
  return null;
}

function clientCredentials(ctx, cfg) {
  let id = child(cfg, 'ClientId') !== undefined ? varFromElement(ctx, cfg, 'ClientId') : null;
  let secret = child(cfg, 'ClientSecret') !== undefined ? varFromElement(ctx, cfg, 'ClientSecret') : null;
  if (!id) {
    const auth = ctx.getVariable('request.header.authorization') || '';
    const m = /^Basic\s+(.+)$/i.exec(auth);
    if (m) {
      const decoded = Buffer.from(m[1], 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i > 0) { id = decoded.slice(0, i); secret = decoded.slice(i + 1); }
    }
  }
  if (!id) { id = ctx.getVariable('request.formparam.client_id'); secret = secret || ctx.getVariable('request.formparam.client_secret'); }
  return { id, secret };
}

function generateAccessToken(policy, ctx, svc) {
  const cfg = policy.config;
  const grant = varFromElement(ctx, cfg, 'GrantType', 'request.formparam.grant_type', 'request.queryparam.grant_type');
  const supported = arr(child(child(cfg, 'SupportedGrantTypes'), 'GrantType')).map((g) => text(g).trim());
  if (!grant) throw oauthError(400, 'invalid_request', 'Required param : grant_type');
  if (!supported.includes(grant)) throw oauthError(400, 'unsupported_grant_type', `Unsupported Grant Type : ${grant}`);
  if (!['client_credentials', 'password'].includes(grant)) throw oauthError(400, 'unsupported_grant_type', `Grant type ${grant} is not supported in Apigee Lite`);

  const { id, secret } = clientCredentials(ctx, cfg);
  if (!id) throw oauthError(401, 'invalid_client', 'Client identifier is required');
  const found = svc.store.findByConsumerKey(String(id));
  if (!found || found.credential.consumerSecret !== secret) throw oauthError(401, 'invalid_client', 'ClientId is Invalid');
  const { developer, app, credential } = found;
  if (app.status !== 'approved' || credential.status !== 'approved') throw oauthError(401, 'invalid_client', 'Client is not approved');

  let username = null;
  if (grant === 'password') {
    username = varFromElement(ctx, cfg, 'UserName', 'request.formparam.username', 'request.queryparam.username');
    const password = varFromElement(ctx, cfg, 'PassWord', 'request.formparam.password', 'request.queryparam.password');
    if (!username) throw oauthError(400, 'invalid_request', 'Required param : username');
    if (!password) throw oauthError(400, 'invalid_request', 'Required param : password');
  }

  const productNames = approvedProducts(credential);
  const allowedScopes = new Set(productNames.flatMap((n) => (svc.store.getProduct(n) || {}).scopes || []));
  const scopeNode = child(cfg, 'Scope');
  const requested = String((scopeNode !== undefined ? ctx.getVariable(text(scopeNode).trim()) : ctx.getVariable('request.formparam.scope')) || '').split(/[\s,]+/).filter(Boolean);
  for (const s of requested) if (!allowedScopes.has(s)) throw oauthError(400, 'invalid_scope', `Invalid scope : ${s}`);
  const scope = (requested.length ? requested : [...allowedScopes]).join(' ');

  const expiresNode = child(cfg, 'ExpiresIn');
  const expiresMs = Number(refOrText(ctx, expiresNode) || 3600000);
  const now = Date.now();
  const token = newToken();
  const rec = { token, clientId: credential.consumerKey, appName: app.name, developerEmail: developer.email, developerId: developer.developerId, products: productNames, scope, issuedAt: now, expiresAt: now + expiresMs, grantType: grant, username, attributes: {} };
  for (const a of arr(child(child(cfg, 'Attributes'), 'Attribute'))) rec.attributes[attr(a, 'name')] = refOrText(ctx, a);
  svc.state.tokens.set(token, rec);

  const expiresIn = String(Math.max(0, Math.floor(expiresMs / 1000) - 1));
  const p = `oauthv2accesstoken.${policy.name}`;
  ctx.setVariable(`${p}.access_token`, token);
  ctx.setVariable(`${p}.expires_in`, expiresIn);
  ctx.setVariable(`${p}.token_type`, 'BearerToken');
  ctx.setVariable(`${p}.scope`, scope);
  ctx.setVariable(`${p}.issued_at`, String(now));
  ctx.setVariable(`${p}.client_id`, credential.consumerKey);

  const gr = child(cfg, 'GenerateResponse');
  if (gr !== undefined && attr(gr, 'enabled') !== 'false') {
    const body = {
      refresh_token_expires_in: '0',
      api_product_list: `[${productNames.join(', ')}]`,
      api_product_list_json: productNames,
      organization_name: svc.org,
      'developer.email': developer.email,
      token_type: 'BearerToken',
      issued_at: String(now),
      client_id: credential.consumerKey,
      access_token: token,
      application_name: app.name,
      scope,
      expires_in: expiresIn,
      refresh_count: '0',
      status: 'approved',
    };
    ctx.response.status = 200;
    ctx.response.reasonPhrase = 'OK';
    ctx.response.setHeader('content-type', 'application/json');
    ctx.response.content = JSON.stringify(body, null, 2);
  }
}

function verifyAccessToken(policy, ctx, svc) {
  const cfg = policy.config;
  const fail = (f) => { ctx.setVariable(`oauthV2.${policy.name}.failed`, true); return new Fault({ status: 401, ...f }); };
  let token = null;
  const atNode = child(cfg, 'AccessToken');
  if (atNode !== undefined) {
    const v = ctx.getVariable(attr(atNode, 'ref') || text(atNode).trim());
    const prefix = attr(atNode, 'prefix');
    token = v && prefix ? String(v).replace(new RegExp(`^${prefix}\\s+`, 'i'), '') : v;
  } else {
    const auth = ctx.getVariable('request.header.authorization');
    const m = auth ? /^Bearer\s+(.+)$/i.exec(auth) : null;
    token = m ? m[1].trim() : null;
  }
  if (!token) throw fail({ name: 'InvalidAccessToken', errorcode: 'oauth.v2.InvalidAccessToken', faultstring: 'Invalid access token' });
  const rec = svc.state.tokens.get(String(token));
  if (!rec) throw fail({ name: 'invalid_access_token', errorcode: 'keymanagement.service.invalid_access_token', faultstring: 'Invalid Access Token' });
  if (Date.now() > rec.expiresAt) throw fail({ name: 'access_token_expired', errorcode: 'keymanagement.service.access_token_expired', faultstring: 'Access Token expired' });
  const found = svc.store.findByConsumerKey(rec.clientId);
  if (!found || found.app.status !== 'approved' || found.credential.status !== 'approved') {
    throw fail({ name: 'app_not_approved', errorcode: 'keymanagement.service.invalid_client-app_not_approved', faultstring: 'Client is not approved' });
  }
  const product = matchProduct(svc.store, rec.products, ctx.getVariable('apiproxy.name'), svc.env, ctx.getVariable('proxy.pathsuffix'));
  if (!product) throw fail({ name: 'InvalidAPICallAsNoApiProductMatchFound', errorcode: 'keymanagement.service.InvalidAPICallAsNoApiProductMatchFound', faultstring: 'Invalid API call as no apiproduct match found' });
  const required = text(child(cfg, 'Scope')).split(/\s+/).filter(Boolean);
  const have = new Set(rec.scope.split(/\s+/).filter(Boolean));
  if (required.length && !required.some((s) => have.has(s))) {
    ctx.setVariable(`oauthV2.${policy.name}.failed`, true);
    throw new Fault({ name: 'InsufficientScope', errorcode: 'steps.oauth.v2.InsufficientScope', status: 403, faultstring: `Required scope(s) : ${required.join(' ')}` });
  }
  const set = (k, v) => ctx.setVariable(k, v);
  set('access_token', rec.token);
  set('client_id', rec.clientId);
  set('developer.app.name', rec.appName);
  set('developer.email', rec.developerEmail);
  set('developer.id', rec.developerId);
  set('scope', rec.scope);
  set('expires_in', String(Math.max(0, Math.floor((rec.expiresAt - Date.now()) / 1000))));
  set('issued_at', String(rec.issuedAt));
  set('grant_type', rec.grantType);
  set('status', 'approved');
  if (rec.username) set('username', rec.username);
  for (const [k, v] of Object.entries(rec.attributes)) set(`accesstoken.${k}`, v);
  setProductVars(ctx, '', product);
  set(`oauthV2.${policy.name}.failed`, false);
}

function execute(policy, ctx, svc) {
  const op = text(child(policy.config, 'Operation')).trim();
  if (op === 'GenerateAccessToken') return generateAccessToken(policy, ctx, svc);
  if (op === 'VerifyAccessToken') return verifyAccessToken(policy, ctx, svc);
  throw new Fault({ name: 'UnsupportedOperation', errorcode: 'apigeelite.UnsupportedOperation', status: 500, faultstring: `OAuthV2 operation ${op || '(none)'} is not supported in Apigee Lite (supported: GenerateAccessToken, VerifyAccessToken)` });
}

module.exports = { execute };
