const test = require('node:test');
const assert = require('node:assert/strict');

const { parseServiceAccountJson } = require('../services/fcmService');

test('parses escaped private key newlines from a service-account JSON value', () => {
  const previous = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
    project_id: 'ecowatch-test',
    client_email: 'firebase-adminsdk@example.com',
    private_key: '-----BEGIN PRIVATE KEY-----\\nsecret\\n-----END PRIVATE KEY-----\\n',
  });
  try {
    const serviceAccount = parseServiceAccountJson();
    assert.equal(serviceAccount.project_id, 'ecowatch-test');
    assert.match(serviceAccount.private_key, /BEGIN PRIVATE KEY-----\nsecret/);
  } finally {
    if (previous === undefined) {
      delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    } else {
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = previous;
    }
  }
});
