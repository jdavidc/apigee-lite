'use strict';
const { text, child, template } = require('./_util');

function execute(policy, ctx, svc) {
  const cfg = policy.config;
  const target = child(cfg, 'Syslog') !== undefined ? child(cfg, 'Syslog') : child(cfg, 'File');
  const message = template(ctx, text(child(target, 'Message')));
  svc.logs.add({
    source: 'MessageLogging',
    env: svc.env,
    proxy: ctx.getVariable('apiproxy.name'),
    policy: policy.name,
    messageid: ctx.getVariable('messageid'),
    message,
  });
}

module.exports = { execute };
