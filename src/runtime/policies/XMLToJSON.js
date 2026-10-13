'use strict';
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { Fault, text, child, bool, messageByName, writeOutput, isXmlType } = require('./_util');

function execute(policy, ctx) {
  const cfg = policy.config;
  const srcName = text(child(cfg, 'Source')).trim() || 'request';
  const msg = messageByName(ctx, srcName);
  if (msg && !isXmlType(msg.getHeader('content-type'))) return;
  const content = msg ? msg.content : String(ctx.getVariable(srcName) || '');
  const opt = child(cfg, 'Options') || {};
  const recognizeNumber = bool(child(opt, 'RecognizeNumber'));
  const recognizeBoolean = bool(child(opt, 'RecognizeBoolean'));
  const recognizeNull = bool(child(opt, 'RecognizeNull'));
  const valid = XMLValidator.validate(content);
  if (valid !== true) {
    throw new Fault({ name: 'ExecutionFailed', errorcode: 'steps.xmltojson.ExecutionFailed', status: 500, faultstring: `XMLToJSON[${policy.name}]: Execution failed due to reason: ${valid.err.msg} at line ${valid.err.line}` });
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: text(child(opt, 'AttributePrefix')) || '',
    textNodeName: text(child(opt, 'TextNodeName')) || '#text',
    removeNSPrefix: bool(child(opt, 'StripNamespaces'), false) || text(child(opt, 'NamespaceSeparator')) === '',
    ignoreDeclaration: true,
    parseTagValue: false,
    parseAttributeValue: false,
  });
  const convert = (v) => {
    if (Array.isArray(v)) return v.map(convert);
    if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = convert(x); return o; }
    if (typeof v !== 'string') return v;
    if (recognizeNumber && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
    if (recognizeBoolean && (v === 'true' || v === 'false')) return v === 'true';
    if (recognizeNull && v === '') return null;
    return v;
  };
  const json = convert(parser.parse(content));
  const out = text(child(cfg, 'OutputVariable')).trim() || srcName;
  writeOutput(ctx, out, JSON.stringify(json), 'application/json');
}

module.exports = { execute };
