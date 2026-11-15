import assert from 'node:assert/strict';
import test from 'node:test';
import { requestsClosedMessage } from './requestsOpen';

// What a player reads off /state to show "requests closed" before a listener
// types one. The decision itself is the controller's (util/requests-open.ts).

test('open, absent or an older controller: the form shows', () => {
  assert.equal(requestsClosedMessage(null), null);
  assert.equal(requestsClosedMessage({}), null);
  assert.equal(requestsClosedMessage({ requests: { open: true } }), null);
  assert.equal(requestsClosedMessage({ requests: {} }), null);
});

test('closed: the controller\'s own line, or a plain one when it sent none', () => {
  assert.equal(requestsClosedMessage({ requests: { open: false, message: 'Requests are closed during Late Mix.' } }), 'Requests are closed during Late Mix.');
  assert.equal(requestsClosedMessage({ requests: { open: false } }), 'Requests are closed right now.');
  assert.equal(requestsClosedMessage({ requests: { open: false, message: '  ' } }), 'Requests are closed right now.');
});
