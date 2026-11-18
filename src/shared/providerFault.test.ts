import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FAULT_WAITS_MS, faultWait, passingFault } from './providerFault';

test('an overload or a server error passes on its own; a limit, a sign-in or a refused request does not', () => {
  assert.equal(passingFault('overloaded', ''), true);
  assert.equal(passingFault('server_error', ''), true);
  for (const code of ['rate_limit', 'billing_error', 'authentication_failed', 'invalid_request', 'model_not_found', 'max_output_tokens']) {
    assert.equal(passingFault(code, 'API Error: 529 overloaded'), false, code);
  }
});

test('an unnamed error counts only when its wording is a server status or the network', () => {
  assert.equal(passingFault('unknown', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'), true);
  assert.equal(passingFault('unknown', 'API Error: 500 Internal server error'), true);
  assert.equal(passingFault('', 'API Error: Connection error. (ECONNRESET)'), true);
  assert.equal(passingFault('unknown', 'API Error: 400 prompt is too long'), false);
  assert.equal(passingFault('unknown', 'Something else happened at line 502'), false);
  assert.equal(passingFault('unknown', ''), false);
});

test('the waits grow, stay within a quarter of their base, and end', () => {
  for (const [i, base] of FAULT_WAITS_MS.entries()) {
    assert.equal(faultWait(i + 1, 0), base * 0.75);
    assert.equal(faultWait(i + 1, 0.5), base);
    assert.ok((faultWait(i + 1, 0.999) as number) < base * 1.25);
  }
  assert.equal(faultWait(FAULT_WAITS_MS.length + 1), null);
});
