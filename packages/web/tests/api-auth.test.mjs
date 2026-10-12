import assert from 'node:assert/strict';
import test from 'node:test';
import { apiTokenHeaders } from '../src/api-auth.ts';

test('returns a bearer header for a supplied browser session token', () => {
  assert.deepEqual(apiTokenHeaders('demo-token'), { Authorization: 'Bearer demo-token' });
});

test('omits auth header when no token is available', () => {
  assert.deepEqual(apiTokenHeaders(null), {});
});

test('trims token whitespace before constructing the header', () => {
  assert.deepEqual(apiTokenHeaders('  demo-token\n'), { Authorization: 'Bearer demo-token' });
});
