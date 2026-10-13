'use strict';
const { Fault, text, attr, child, arr } = require('./_util');

async function execute(policy, ctx, svc, exec) {
  const cfg = policy.config;
  const name = text(child(cfg, 'SharedFlowBundle')).trim();
  for (const p of arr(child(child(cfg, 'Parameters'), 'Parameter'))) {
    const ref = attr(p, 'ref');
    const v = ref ? ctx.getVariable(ref) : attr(p, 'value') !== undefined ? attr(p, 'value') : text(p);
    ctx.setVariable(attr(p, 'name'), v);
  }
  const sf = name ? svc.getSharedFlow(name) : null;
  if (!sf) throw new Fault({ name: 'SharedFlowNotFound', errorcode: 'flow.SharedFlowNotFound', status: 500, faultstring: `Shared flow ${name || '(none)'} is not deployed to environment ${svc.env}` });
  await exec.runSharedFlow(sf, 'default');
}

module.exports = { execute };
