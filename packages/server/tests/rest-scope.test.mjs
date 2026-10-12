import test from 'node:test';
import assert from 'node:assert/strict';
import { scopeRestRequest } from '../dist/rest.js';

test('forces REST body and query scope to the configured workspace', () => {
  const params = new URLSearchParams('groupId=another-workspace&limit=10');
  const body = scopeRestRequest({ groupId: 'another-workspace', query: 'test' }, params, 'teamtrail_demo');
  assert.equal(body.groupId, 'teamtrail_demo');
  assert.equal(body.query, 'test');
  assert.equal(params.get('groupId'), 'teamtrail_demo');
  assert.equal(params.get('limit'), '10');
});
