'use strict';
const { Fault, text, attr, child, arr } = require('./_util');

function ipToInt(ip) {
  const p = String(ip).trim().replace(/^::ffff:/, '').split('.');
  if (p.length !== 4 || p.some((x) => !/^\d+$/.test(x) || Number(x) > 255)) return null;
  return p.reduce((acc, x) => ((acc << 8) + Number(x)) >>> 0, 0);
}

function inRange(ip, base, mask) {
  const a = ipToInt(ip);
  const b = ipToInt(base);
  if (a === null || b === null) return false;
  const m = Number(mask);
  const bits = m <= 0 ? 0 : (0xffffffff << (32 - Math.min(32, m))) >>> 0;
  return (a & bits) === (b & bits);
}

function execute(policy, ctx) {
  const cfg = policy.config;
  const rules = child(cfg, 'IPRules');
  const noMatch = (attr(rules, 'noRuleMatchAction') || 'ALLOW').toUpperCase();
  const basis = text(child(cfg, 'ValidateBasedOn')).trim();
  let ips = [ctx.getVariable('client.ip') || ''];
  if (basis.startsWith('X_FORWARDED_FOR')) {
    const xff = (ctx.getVariable('request.header.x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) ips = basis === 'X_FORWARDED_FOR_FIRST_IP' ? [xff[0]] : basis === 'X_FORWARDED_FOR_LAST_IP' ? [xff[xff.length - 1]] : xff;
  }
  const normalized = ips.map((ip) => (ip === '::1' ? '127.0.0.1' : ip.replace(/^::ffff:/, '')));
  for (const ip of normalized) {
    let action = noMatch;
    for (const rule of arr(child(rules, 'MatchRule'))) {
      const hit = arr(child(rule, 'SourceAddress')).some((sa) => inRange(ip, text(sa), attr(sa, 'mask') || 32));
      if (hit) { action = (attr(rule, 'action') || 'ALLOW').toUpperCase(); break; }
    }
    if (action === 'DENY') {
      throw new Fault({ name: 'IPDeniedAccess', errorcode: 'accesscontrol.IPDeniedAccess', status: 403, faultstring: `Access Denied for client ip : ${ip}` });
    }
  }
}

module.exports = { execute, inRange };
