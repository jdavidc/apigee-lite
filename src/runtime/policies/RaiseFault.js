'use strict';
const { Fault, Message, child, bool } = require('./_util');
const { applyOps, assignVariables } = require('./AssignMessage');

function execute(policy, ctx) {
  const cfg = policy.config;
  const fr = child(cfg, 'FaultResponse');
  const strict = !bool(child(cfg, 'IgnoreUnresolvedVariables'), false);
  if (fr === undefined || fr === '') {
    throw new Fault({ name: 'RaiseFault', errorcode: 'steps.raisefault.RaiseFault', status: 500, faultstring: `Raising fault. Fault name : ${policy.name}` });
  }
  assignVariables(fr, ctx, false);
  const msg = new Message({ status: 500 });
  applyOps(fr, msg, ctx, { strict, policyType: 'raisefault' });
  throw new Fault({ name: 'RaiseFault', errorcode: 'steps.raisefault.RaiseFault', status: msg.status, faultstring: `Raising fault. Fault name : ${policy.name}`, response: msg });
}

module.exports = { execute };
