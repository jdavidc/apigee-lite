'use strict';
const { Fault, text, attr, child, bool } = require('./_util');

function execute(policy, ctx) {
  const cfg = policy.config;
  const op = text(child(cfg, 'Operation')).trim();
  const ignore = bool(child(cfg, 'IgnoreUnresolvedVariables'));
  const userRef = attr(child(cfg, 'User'), 'ref');
  const passRef = attr(child(cfg, 'Password'), 'ref');
  const unresolved = (ref) => new Fault({ name: 'UnresolvedVariable', errorcode: 'steps.basicauthentication.UnresolvedVariable', status: 500, faultstring: `Unresolved variable : ${ref}` });

  if (op === 'Encode') {
    const user = ctx.getVariable(userRef);
    const pass = ctx.getVariable(passRef);
    if (user === null || pass === null) { if (ignore) return; throw unresolved(user === null ? userRef : passRef); }
    const target = text(child(cfg, 'AssignTo')).trim() || 'request.header.Authorization';
    ctx.setVariable(target, 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'));
    return;
  }
  if (op === 'Decode') {
    const src = text(child(cfg, 'Source')).trim() || 'request.header.Authorization';
    const value = ctx.getVariable(src);
    if (value === null || value === '') { if (ignore) return; throw unresolved(src); }
    const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(String(value));
    const decoded = m ? Buffer.from(m[1], 'base64').toString('utf8') : '';
    const i = decoded.indexOf(':');
    if (!m || i < 0) {
      throw new Fault({ name: 'InvalidBasicAuthenticationSource', errorcode: 'steps.basicauthentication.InvalidBasicAuthenticationSource', status: 500, faultstring: `Source variable : ${src} for basic authentication decode policy is not valid` });
    }
    ctx.setVariable(userRef, decoded.slice(0, i));
    ctx.setVariable(passRef, decoded.slice(i + 1));
    return;
  }
  throw new Fault({ name: 'InvalidOperation', errorcode: 'steps.basicauthentication.InvalidOperation', status: 500, faultstring: `Invalid operation ${op} in ${policy.name}; use Encode or Decode` });
}

module.exports = { execute };
