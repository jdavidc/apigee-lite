'use strict';
const { Fault, Message, text, attr, child, arr, bool, template, messageByName } = require('./_util');
const { rawPayload } = require('../xml');

function unresolvedFault(policy, e) {
  return new Fault({ name: 'UnresolvedVariable', errorcode: 'steps.assignmessage.UnresolvedVariable', status: 500, faultstring: `${e.message.replace('Unresolved variable : ', 'Unresolved variable : ')}` });
}

function namedItems(node, tag) { return arr(child(node, tag)); }

// Applies Copy, Remove, Add, Set to msg (shared with RaiseFault and ServiceCallout).
function applyOps(cfg, msg, ctx, { strict, policyType = 'assignmessage' } = {}) {
  const tpl = (s, opts = {}) => {
    try { return template(ctx, s, { strict, ...opts }); } catch (e) {
      throw new Fault({ name: 'UnresolvedVariable', errorcode: `steps.${policyType}.UnresolvedVariable`, status: 500, faultstring: e.message });
    }
  };

  for (const copy of arr(child(cfg, 'Copy'))) {
    const src = messageByName(ctx, attr(copy, 'source') || 'request');
    if (!src) continue;
    const hdrs = child(copy, 'Headers');
    if (hdrs !== undefined) {
      const list = namedItems(hdrs, 'Header');
      if (!list.length) Object.entries(src.headers).forEach(([k, v]) => msg.setHeader(k, v));
      for (const h of list) { const v = src.getHeader(attr(h, 'name')); if (v !== null) msg.setHeader(attr(h, 'name'), v); }
    }
    const qps = child(copy, 'QueryParams');
    if (qps !== undefined) {
      const list = namedItems(qps, 'QueryParam');
      if (!list.length) src.query.forEach(([k, v]) => msg.addQueryParam(k, v));
      for (const q of list) { const v = src.getQueryParam(attr(q, 'name')); if (v !== null) msg.setQueryParam(attr(q, 'name'), v); }
    }
    const fps = child(copy, 'FormParams');
    if (fps !== undefined) {
      const list = namedItems(fps, 'FormParam');
      if (!list.length) src.formParams().forEach(([k, v]) => msg.addFormParam(k, v));
      for (const f of list) { const v = src.getFormParam(attr(f, 'name')); if (v !== null) msg.setFormParam(attr(f, 'name'), v); }
    }
    if (bool(child(copy, 'Payload'))) { msg.content = src.content; const ct = src.getHeader('content-type'); if (ct) msg.setHeader('content-type', ct); }
    if (bool(child(copy, 'Verb'))) msg.verb = src.verb;
    if (bool(child(copy, 'Path'))) msg.path = src.path;
    if (bool(child(copy, 'StatusCode'))) msg.status = src.status;
    if (bool(child(copy, 'ReasonPhrase'))) msg.reasonPhrase = src.reasonPhrase;
  }

  for (const rm of arr(child(cfg, 'Remove'))) {
    if (typeof rm !== 'object') continue;
    const hdrs = child(rm, 'Headers');
    if (hdrs !== undefined) {
      const list = namedItems(hdrs, 'Header');
      if (!list.length) msg.headers = {};
      list.forEach((h) => msg.removeHeader(attr(h, 'name')));
    }
    const qps = child(rm, 'QueryParams');
    if (qps !== undefined) {
      const list = namedItems(qps, 'QueryParam');
      if (!list.length) msg.querystring = '';
      list.forEach((q) => msg.removeQueryParam(attr(q, 'name')));
    }
    const fps = child(rm, 'FormParams');
    if (fps !== undefined) {
      const list = namedItems(fps, 'FormParam');
      if (!list.length) msg.content = '';
      list.forEach((f) => msg.removeFormParam(attr(f, 'name')));
    }
    if (bool(child(rm, 'Payload'))) msg.content = '';
  }

  for (const add of arr(child(cfg, 'Add'))) {
    for (const h of namedItems(child(add, 'Headers'), 'Header')) msg.addHeader(attr(h, 'name'), tpl(text(h)));
    for (const q of namedItems(child(add, 'QueryParams'), 'QueryParam')) msg.addQueryParam(attr(q, 'name'), tpl(text(q)));
    for (const f of namedItems(child(add, 'FormParams'), 'FormParam')) msg.addFormParam(attr(f, 'name'), tpl(text(f)));
  }

  for (const set of arr(child(cfg, 'Set'))) {
    if (typeof set !== 'object') continue;
    for (const h of namedItems(child(set, 'Headers'), 'Header')) msg.setHeader(attr(h, 'name'), tpl(text(h)));
    for (const q of namedItems(child(set, 'QueryParams'), 'QueryParam')) msg.setQueryParam(attr(q, 'name'), tpl(text(q)));
    for (const f of namedItems(child(set, 'FormParams'), 'FormParam')) msg.setFormParam(attr(f, 'name'), tpl(text(f)));
    const payload = child(set, 'Payload');
    if (payload !== undefined) {
      const opts = {};
      if (attr(payload, 'variablePrefix')) opts.prefix = attr(payload, 'variablePrefix');
      if (attr(payload, 'variableSuffix')) opts.suffix = attr(payload, 'variableSuffix');
      msg.content = tpl(rawPayload(payload), opts);
      const ct = attr(payload, 'contentType');
      if (ct) msg.setHeader('content-type', ct);
    }
    if (child(set, 'Verb') !== undefined) msg.verb = tpl(text(child(set, 'Verb'))).toUpperCase();
    if (child(set, 'Path') !== undefined) msg.path = tpl(text(child(set, 'Path')));
    if (child(set, 'StatusCode') !== undefined) {
      const sc = Number(tpl(text(child(set, 'StatusCode'))));
      msg.status = sc;
      if (child(set, 'ReasonPhrase') === undefined) msg.reasonPhrase = require('node:http').STATUS_CODES[sc] || '';
    }
    if (child(set, 'ReasonPhrase') !== undefined) msg.reasonPhrase = tpl(text(child(set, 'ReasonPhrase')));
  }
}

function assignVariables(cfg, ctx, strict) {
  for (const av of arr(child(cfg, 'AssignVariable'))) {
    const name = text(child(av, 'Name')).trim();
    if (!name) continue;
    let value = null;
    const ref = text(child(av, 'Ref')).trim();
    const tplNode = child(av, 'Template');
    if (ref) value = ctx.getVariable(ref);
    if ((value === null || value === undefined) && tplNode !== undefined) {
      const tref = attr(tplNode, 'ref');
      const t = tref ? ctx.getVariable(tref) : text(tplNode);
      value = template(ctx, t || '');
    }
    if ((value === null || value === undefined) && child(av, 'Value') !== undefined) value = text(child(av, 'Value'));
    if (value === null || value === undefined) {
      if (strict && ref) throw new Fault({ name: 'UnresolvedVariable', errorcode: 'steps.assignmessage.UnresolvedVariable', status: 500, faultstring: `Unresolved variable : ${ref}` });
      continue;
    }
    ctx.setVariable(name, value);
  }
}

function targetMessage(cfg, ctx) {
  const at = child(cfg, 'AssignTo');
  if (at === undefined) return ctx.currentMessage();
  const createNew = attr(at, 'createNew') === 'true';
  const type = (attr(at, 'type') || 'request').toLowerCase();
  const varName = text(at).trim();
  if (varName && varName !== 'request' && varName !== 'response') {
    let m = ctx.vars.get(varName);
    if (createNew || !(m instanceof Message)) {
      m = type === 'response' ? new Message({ status: 200 }) : new Message({ verb: 'GET', path: '/' });
      ctx.vars.set(varName, m);
    }
    return m;
  }
  const which = varName || type;
  if (createNew) {
    const m = which === 'response' ? new Message({ status: 200 }) : new Message({ verb: 'GET', path: '/' });
    if (which === 'response') ctx.response = m; else ctx.request = m;
    return m;
  }
  return which === 'response' ? ctx.response : ctx.request;
}

function execute(policy, ctx) {
  const cfg = policy.config;
  const strict = !bool(child(cfg, 'IgnoreUnresolvedVariables'), false);
  assignVariables(cfg, ctx, strict);
  const msg = targetMessage(cfg, ctx);
  applyOps(cfg, msg, ctx, { strict });
}

module.exports = { execute, applyOps, assignVariables };
