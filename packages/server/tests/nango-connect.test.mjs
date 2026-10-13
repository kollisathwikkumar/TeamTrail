import assert from 'node:assert/strict';
import test from 'node:test';
import { createNangoConnectSession, deleteNangoConnection, providerIntegrationKey, verifyNangoConnection } from '../dist/nango-connect.js';

test('resolves only the configured integration key for a known provider', () => {
  assert.equal(providerIntegrationKey('google-drive', {}), 'google-drive');
  assert.equal(providerIntegrationKey('slack', { NANGO_SLACK_INTEGRATION: 'team-slack' }), 'team-slack');
  assert.equal(providerIntegrationKey('unknown', {}), null);
});

test('creates a scoped Nango Connect session for the authenticated workspace member', async () => {
  let request;
  const result = await createNangoConnectSession({
    apiKey: 'server-secret',
    provider: 'slack',
    integrationKey: 'team-slack',
    principalId: 'auth0|member-123',
    principalEmail: 'member@example.test',
    displayName: 'Workspace member',
    workspaceId: 'teamtrail',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ data: { token: 'short-lived-token', expires_at: '2030-01-01T00:00:00Z' } }), { status: 201 });
    },
  });
  assert.equal(request.url, 'https://api.nango.dev/connect/sessions');
  assert.equal(request.init.headers.Authorization, 'Bearer server-secret');
  assert.deepEqual(JSON.parse(request.init.body), {
    tags: { end_user_id: 'auth0|member-123', end_user_email: 'member@example.test', end_user_display_name: 'Workspace member', organization_id: 'teamtrail' },
    allowed_integrations: ['team-slack'],
  });
  assert.deepEqual(result, { token: 'short-lived-token', expiresAt: '2030-01-01T00:00:00Z', provider: 'slack', providerConfigKey: 'team-slack' });
});

test('does not make a Nango request when its server credential is missing', async () => {
  await assert.rejects(() => createNangoConnectSession({
    apiKey: '', provider: 'slack', integrationKey: 'team-slack', principalId: 'subject',
    workspaceId: 'teamtrail', fetchImpl: async () => { throw new Error('must not fetch'); },
  }), /Nango is not configured/);
});

test('rejects failed Nango session creation without echoing provider response details', async () => {
  await assert.rejects(() => createNangoConnectSession({
    apiKey: 'server-secret', provider: 'slack', integrationKey: 'team-slack', principalId: 'subject',
    workspaceId: 'teamtrail', fetchImpl: async () => new Response('{"error":"private provider details"}', { status: 401 }),
  }), error => error.status === 502 && !error.message.includes('private provider details'));
});

test('persists a Nango connection only after Nango confirms its connection and integration IDs', async () => {
  let request;
  const response = JSON.stringify({ connection_id: 'conn_123', provider_config_key: 'team-slack', tags: { end_user_id: 'auth0|member-123', organization_id: 'teamtrail' } });
  const input = { apiKey: 'key', connectionId: 'conn_123', providerConfigKey: 'team-slack', principalId: 'auth0|member-123', workspaceId: 'teamtrail', fetchImpl: async (url, init) => { request = { url, init }; return new Response(response, { status: 200 }); } };
  assert.equal(await verifyNangoConnection(input), true);
  assert.equal(request.url, 'https://api.nango.dev/connections/conn_123?provider_config_key=team-slack');
  assert.equal(await verifyNangoConnection({ ...input, providerConfigKey: 'another-app' }), false);
  assert.equal(await verifyNangoConnection({ ...input, principalId: 'auth0|another-user' }), false);
  assert.equal(await verifyNangoConnection({ ...input, workspaceId: 'other-workspace' }), false);
  assert.equal(await verifyNangoConnection({ ...input, connectionId: '../conn' }), false);
});

test('disconnect revokes the exact connection and integration pair', async () => {
  let request;
  const ok = await deleteNangoConnection({ apiKey: 'key', connectionId: 'conn_123', providerConfigKey: 'team-slack', fetchImpl: async (url, init) => {
    request = { url, init };
    return new Response(null, { status: 204 });
  } });
  assert.equal(ok, true);
  assert.equal(request.url, 'https://api.nango.dev/connections/conn_123?provider_config_key=team-slack');
  assert.equal(request.init.method, 'DELETE');
});
