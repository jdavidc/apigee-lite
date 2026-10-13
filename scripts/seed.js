'use strict';
const path = require('node:path');
const { seed } = require('../src/seed');

const dataDir = process.env.APIGEE_LITE_DATA || path.join(__dirname, '..', 'data');
const mockPort = Number(process.env.MOCK_PORT || 9002);
seed(dataDir, { mockPort });
console.log(`Seeded ${dataDir} (mock backend TargetServer -> localhost:${mockPort}). Restart the server if it is running.`);
