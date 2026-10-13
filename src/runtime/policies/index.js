'use strict';
const { Fault } = require('../fault');

const MODULES = {
  VerifyAPIKey: './VerifyAPIKey',
  OAuthV2: './OAuthV2',
  BasicAuthentication: './BasicAuthentication',
  AccessControl: './AccessControl',
  JSONThreatProtection: './JSONThreatProtection',
  RegularExpressionProtection: './RegularExpressionProtection',
  GenerateJWT: './JWT',
  VerifyJWT: './JWT',
  SpikeArrest: './SpikeArrest',
  Quota: './Quota',
  ResponseCache: './Cache',
  PopulateCache: './Cache',
  LookupCache: './Cache',
  InvalidateCache: './Cache',
  AssignMessage: './AssignMessage',
  ExtractVariables: './ExtractVariables',
  RaiseFault: './RaiseFault',
  JSONToXML: './JSONToXML',
  XMLToJSON: './XMLToJSON',
  KeyValueMapOperations: './KeyValueMapOperations',
  Javascript: './Javascript',
  JavaScript: './Javascript',
  ServiceCallout: './ServiceCallout',
  FlowCallout: './FlowCallout',
  MessageLogging: './MessageLogging',
};

const CATEGORIES = {
  Security: ['VerifyAPIKey', 'OAuthV2', 'BasicAuthentication', 'AccessControl', 'JSONThreatProtection', 'RegularExpressionProtection', 'GenerateJWT', 'VerifyJWT'],
  Traffic: ['SpikeArrest', 'Quota', 'ResponseCache', 'PopulateCache', 'LookupCache', 'InvalidateCache'],
  Mediation: ['AssignMessage', 'ExtractVariables', 'RaiseFault', 'JSONToXML', 'XMLToJSON', 'KeyValueMapOperations'],
  Extension: ['Javascript', 'ServiceCallout', 'FlowCallout', 'MessageLogging'],
};

const isSupported = (type) => Object.prototype.hasOwnProperty.call(MODULES, type);

async function execute(policy, ctx, services, exec, bundle) {
  if (!isSupported(policy.type)) {
    throw new Fault({
      name: 'UnsupportedPolicy',
      errorcode: 'apigeelite.UnsupportedPolicy',
      status: 500,
      faultstring: `Policy type ${policy.type} (${policy.name}) is not supported in Apigee Lite`,
    });
  }
  const mod = require(MODULES[policy.type]);
  return mod.execute(policy, ctx, services, exec, bundle);
}

module.exports = { execute, isSupported, CATEGORIES, SUPPORTED: Object.keys(MODULES) };
