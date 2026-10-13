'use strict';
const http = require('node:http');

class Fault extends Error {
  // name: short fault.name (e.g. InvalidApiKey); errorcode: Edge error code; status: HTTP status.
  constructor({ name, errorcode, status = 500, faultstring, reasonPhrase, response, body, contentType, keepResponse, headers } = {}) {
    super(faultstring || errorcode || name || 'Fault');
    this.faultName = name || (errorcode ? errorcode.split('.').pop() : 'Fault');
    this.errorcode = errorcode || 'messaging.runtime.UnknownError';
    this.status = status;
    this.faultstring = faultstring || this.message;
    this.reasonPhrase = reasonPhrase || http.STATUS_CODES[status] || '';
    this.response = response || null;
    this.body = body;
    this.contentType = contentType;
    this.keepResponse = !!keepResponse;
    this.headers = headers || {};
    this.policy = null;
  }

  defaultBody() {
    if (this.body !== undefined) return typeof this.body === 'string' ? this.body : JSON.stringify(this.body);
    return JSON.stringify({ fault: { faultstring: this.faultstring, detail: { errorcode: this.errorcode } } });
  }
}

module.exports = { Fault };
