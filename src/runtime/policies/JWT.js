'use strict';
const crypto = require('node:crypto');
const { Fault, text, attr, child, arr, refOrText, durationMs } = require('./_util');

const ALGS = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' };
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64u = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function secretKey(ctx, cfg, policy) {
  const valNode = child(child(cfg, 'SecretKey'), 'Value');
  const ref = attr(valNode, 'ref');
  const v = ref ? ctx.getVariable(ref) : null;
  if (v === null || v === undefined || v === '') {
    throw new Fault({ name: 'FailedToResolveVariable', errorcode: 'steps.jwt.FailedToResolveVariable', status: 401, faultstring: `Failed to resolve variable ${ref || '(SecretKey/Value ref)'}: policy(${policy.name})` });
  }
  return String(v);
}

function algorithm(cfg, policy) {
  const alg = text(child(cfg, 'Algorithm')).trim() || 'HS256';
  if (!ALGS[alg]) throw new Fault({ name: 'UnsupportedAlgorithm', errorcode: 'apigeelite.UnsupportedAlgorithm', status: 500, faultstring: `Algorithm ${alg} is not supported in Apigee Lite (use HS256/HS384/HS512): policy(${policy.name})` });
  return alg;
}

function claimValue(ctx, c) {
  const v = refOrText(ctx, c);
  if (v === null) return null;
  const type = (attr(c, 'type') || 'string').toLowerCase();
  const isArray = attr(c, 'array') === 'true';
  const conv = (x) => (type === 'number' || type === 'integer' || type === 'long' ? Number(x) : type === 'boolean' ? String(x) === 'true' : String(x));
  return isArray ? String(v).split(',').map((x) => conv(x.trim())) : conv(v);
}

function generate(policy, ctx) {
  const cfg = policy.config;
  const alg = algorithm(cfg, policy);
  const key = secretKey(ctx, cfg, policy);
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now };
  const std = { Subject: 'sub', Issuer: 'iss', Audience: 'aud', Id: 'jti' };
  for (const [tag, claim] of Object.entries(std)) {
    const node = child(cfg, tag);
    if (node === undefined) continue;
    const v = refOrText(ctx, node);
    if (v !== null) payload[claim] = String(v);
    else if (tag === 'Id') payload.jti = crypto.randomUUID();
  }
  const exp = refOrText(ctx, child(cfg, 'ExpiresIn'));
  if (exp !== null) payload.exp = now + Math.round(durationMs(exp) / 1000);
  const nbf = refOrText(ctx, child(cfg, 'NotBefore'));
  if (nbf !== null) payload.nbf = now + Math.round((durationMs(nbf) || 0) / 1000);
  for (const c of arr(child(child(cfg, 'AdditionalClaims'), 'Claim'))) {
    const v = claimValue(ctx, c);
    if (v !== null) payload[attr(c, 'name')] = v;
  }
  const header = { typ: 'JWT', alg };
  for (const c of arr(child(child(cfg, 'AdditionalHeaders'), 'Claim'))) { const v = claimValue(ctx, c); if (v !== null) header[attr(c, 'name')] = v; }
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const sig = b64u(crypto.createHmac(ALGS[alg], key).update(signingInput).digest());
  const out = text(child(cfg, 'OutputVariable')).trim() || `jwt.${policy.name}.generated_jwt`;
  ctx.setVariable(out, `${signingInput}.${sig}`);
}

function verify(policy, ctx) {
  const cfg = policy.config;
  const p = `jwt.${policy.name}`;
  const fail = (name, msg) => { ctx.setVariable(`${p}.valid`, false); ctx.setVariable(`${p}.error`, msg); return new Fault({ name, errorcode: `steps.jwt.${name}`, status: 401, faultstring: `${msg}: policy(${policy.name})` }); };
  const srcName = text(child(cfg, 'Source')).trim();
  let token = ctx.getVariable(srcName || 'request.header.authorization');
  if (!srcName && token) token = String(token).replace(/^Bearer\s+/i, '');
  if (token === null || token === '') throw fail('FailedToResolveVariable', `Failed to resolve variable ${srcName || 'request.header.authorization'}`);
  const parts = String(token).trim().split('.');
  let header, payload;
  try {
    if (parts.length !== 3) throw new Error('parts');
    header = JSON.parse(fromB64u(parts[0]).toString('utf8'));
    payload = JSON.parse(fromB64u(parts[1]).toString('utf8'));
  } catch { throw fail('FailedToDecode', 'Failed to Decode Token'); }
  ctx.setVariable(`${p}.decoded.header.alg`, header.alg);
  ctx.setVariable(`${p}.decoded.header.typ`, header.typ);
  const alg = algorithm(cfg, policy);
  if (!header.alg) throw fail('NoAlgorithmFoundInHeader', 'No algorithm found in header');
  if (header.alg !== alg) throw fail('AlgorithmMismatch', `Algorithm in header (${header.alg}) does not match the policy (${alg})`);
  const key = secretKey(ctx, cfg, policy);
  const expected = b64u(crypto.createHmac(ALGS[alg], key).update(`${parts[0]}.${parts[1]}`).digest());
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw fail('InvalidToken', 'Invalid token');
  const allowance = Math.round((durationMs(refOrText(ctx, child(cfg, 'TimeAllowance')) || '0s') || 0) / 1000);
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp !== undefined && now > payload.exp + allowance) throw fail('TokenExpired', 'The Token has expired');
  if (payload.nbf !== undefined && now + allowance < payload.nbf) throw fail('TokenNotYetValid', 'The Token is not yet valid');
  const checks = { Issuer: ['iss', 'JwtIssuerMismatch'], Subject: ['sub', 'JwtSubjectMismatch'], Audience: ['aud', 'JwtAudienceMismatch'] };
  for (const [tag, [claim, err]] of Object.entries(checks)) {
    const node = child(cfg, tag);
    if (node === undefined) continue;
    const want = refOrText(ctx, node);
    const got = payload[claim];
    const ok = Array.isArray(got) ? got.includes(want) : String(got) === String(want);
    if (want !== null && !ok) throw fail(err, `${tag} mismatch: expected ${want}, found ${got}`);
  }
  for (const c of arr(child(child(cfg, 'AdditionalClaims'), 'Claim'))) {
    const want = claimValue(ctx, c);
    if (want !== null && JSON.stringify(payload[attr(c, 'name')]) !== JSON.stringify(want)) throw fail('InvalidClaim', `Invalid claim ${attr(c, 'name')}`);
  }
  const names = { sub: 'subject', iss: 'issuer', aud: 'audience', exp: 'expiry', iat: 'issued_at', nbf: 'notbefore', jti: 'id' };
  for (const [k, v] of Object.entries(payload)) {
    const val = typeof v === 'object' ? JSON.stringify(v) : v;
    ctx.setVariable(`${p}.claim.${names[k] || k}`, val);
    if (names[k]) ctx.setVariable(`${p}.claim.${k}`, val);
  }
  ctx.setVariable(`${p}.payload-json`, JSON.stringify(payload));
  ctx.setVariable(`${p}.header-json`, JSON.stringify(header));
  ctx.setVariable(`${p}.valid`, true);
}

function execute(policy, ctx) {
  return policy.type === 'GenerateJWT' ? generate(policy, ctx) : verify(policy, ctx);
}

module.exports = { execute };
