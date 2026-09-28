const test = require('node:test');
const assert = require('node:assert/strict');

/*
 * services/emailServices.js constructs the Resend client at module load and the
 * SDK throws if no key is present. A placeholder is set before the require so
 * this file is hermetic: it must pass on a machine with no .env, and it never
 * sends anything.
 */
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 're_test_placeholder_key';

const {
  classifyDeliveryFailure,
  isTestingSenderRestriction,
} = require('../services/emailServices');

/*
 * Email delivery diagnosis.
 *
 * These cover a failure that is invisible in the app and expensive in practice:
 * Resend's onboarding@resend.dev is a testing sender, so the moment a real
 * resident signs up every send fails, and the resident only sees a generic
 * "could not send the verification email". The cause is entirely in the server
 * log, which is the right place for it, so the classification has to be right.
 */

test('a testing-sender rejection is recognised', () => {
  // Verbatim shape Resend returns when EMAIL_FROM is the onboarding address and
  // the recipient is not the address registered to the Resend account.
  const providerError = {
    name: 'validation_error',
    message:
      'You can only send testing emails to your own email address '
      + '(kheyronsaliga@aclcbukidnon.com). To send emails to other recipients, '
      + 'please verify a domain at resend.com/domains, and change the from address '
      + 'to an email using this domain.',
  };

  assert.equal(isTestingSenderRestriction(providerError.message), true);
  assert.equal(isTestingSenderRestriction('The request body is invalid'), false);
  assert.equal(isTestingSenderRestriction(''), false);
  assert.equal(isTestingSenderRestriction(undefined), false);
});

test('a testing-sender rejection yields an actionable operator hint', () => {
  const classified = classifyDeliveryFailure({
    name: 'validation_error',
    message:
      'You can only send testing emails to your own email address '
      + '(kheyronsaliga@aclcbukidnon.com). To send emails to other recipients, '
      + 'please verify a domain at resend.com/domains.',
  });

  assert.equal(classified.code, 'EMAIL_SENDER_NOT_PERMITTED');

  // The hint is where the actual fix lives, so it has to name the variable to
  // change and the thing to go do.
  assert.match(classified.operatorHint, /EMAIL_FROM/);
  assert.match(classified.operatorHint, /verify a sending domain/i);
  assert.match(classified.operatorHint, /DNS/i);
});

test('the resident-facing message never names the mail provider', () => {
  const classified = classifyDeliveryFailure({
    message:
      'You can only send testing emails to your own email address '
      + '(owner@example.com). verify a domain at resend.com/domains.',
  });

  // Disclosing the provider to a resident tells them nothing useful and only
  // narrows the system's internals, so it is kept in the operator hint.
  assert.equal(/resend/i.test(classified.clientMessage), false);
  assert.match(classified.clientMessage, /not configured/i);
});

test('an unrelated delivery failure falls back to a generic classification', () => {
  const classified = classifyDeliveryFailure({
    message: 'The request body is invalid',
  });

  assert.equal(classified.code, 'EMAIL_DELIVERY_FAILED');
  assert.match(classified.operatorHint, /invalid/i);
  assert.equal(/resend/i.test(classified.clientMessage), false);
});

test('a missing provider message still produces a usable hint', () => {
  const classified = classifyDeliveryFailure({});

  assert.equal(classified.code, 'EMAIL_DELIVERY_FAILED');
  assert.ok(classified.operatorHint.length > 0, 'an empty hint is not diagnosable');
  assert.ok(classified.clientMessage.length > 0);
});

test('every classification carries a message the client can be shown', () => {
  for (const input of [
    { message: 'rate limited' },
    { message: 'You can only send testing emails to your own email address (a@b.c).' },
    {},
    { message: '' },
  ]) {
    const classified = classifyDeliveryFailure(input);
    assert.ok(
      classified.clientMessage && classified.clientMessage.trim().length > 0,
      'client message must never be empty'
    );
    assert.ok(classified.code, 'every failure needs a code for the log');
  }
});
