import assert from 'node:assert/strict';
import test from 'node:test';
import { assertProductionAuth, buildMcpProtectedResourceMetadata, buildWorkspaceStatus, corsOriginForRequest, normalizeAuth0Domain, normalizeMcpResourceUrl, productionMcpToken, requiresRestBearerAuth, resourceMetadataUrl, RestRequestLimiter, roleCanAccess, REST_CONTENT_SECURITY_POLICY } from '../dist/rest.js';

test('CSP permits the Auth0 token worker without relaxing script execution', () => {
  assert.match(REST_CONTENT_SECURITY_POLICY, /worker-src 'self' blob:/);
  assert.match(REST_CONTENT_SECURITY_POLICY, /frame-src https:\/\/connect\.nango\.dev/);
  assert.match(REST_CONTENT_SECURITY_POLICY, /script-src 'self'/);
  assert.doesNotMatch(REST_CONTENT_SECURITY_POLICY, /unsafe-eval/);
});

test('same-origin requests receive their own origin for CORS', () => {
  assert.equal(corsOriginForRequest('https://teamtrail.example', 'teamtrail.example', 'https', []), 'https://teamtrail.example');
});

test('configured frontend origin is allowed for a split frontend/API deployment', () => {
  assert.equal(corsOriginForRequest('https://app.example', 'api.example', 'https', ['https://app.example']), 'https://app.example');
});

test('unconfigured cross-origin callers receive no CORS grant', () => {
  assert.equal(corsOriginForRequest('https://attacker.example', 'api.example', 'https', []), null);
});

test('requests without an Origin header stay usable by CLI and server clients', () => {
  assert.equal(corsOriginForRequest(undefined, 'api.example', 'https', []), null);
});

test('production requires Auth0, workspace bootstrap, and a matching HTTPS MCP resource audience', () => {
  assert.throws(() => assertProductionAuth('production', undefined, undefined), /Production requires valid Auth0 settings/);
  assert.throws(() => assertProductionAuth('production', 'tenant.auth0.com', 'https://api.teamtrail.example/mcp', 'spa-client', 'auth0|owner'), /TEAMTRAIL_MCP_RESOURCE_URL/);
  assert.throws(() => assertProductionAuth('production', 'tenant.auth0.com', 'https://teamtrail.example.com/mcp', 'spa-client', 'auth0|owner', 'http://teamtrail.example.com/mcp'), /TEAMTRAIL_MCP_RESOURCE_URL/);
  assert.doesNotThrow(() => assertProductionAuth('production', 'tenant.auth0.com', 'https://teamtrail.example.com/mcp', 'spa-client', 'auth0|owner', 'https://teamtrail.example.com/mcp'));
});

test('MCP protected-resource metadata advertises the exact resource and Auth0 issuer', () => {
  assert.equal(normalizeMcpResourceUrl('https://teamtrail.example.com/mcp'), 'https://teamtrail.example.com/mcp');
  assert.equal(normalizeMcpResourceUrl('http://teamtrail.example.com/mcp'), null);
  assert.equal(resourceMetadataUrl('https://teamtrail.example.com/mcp'), 'https://teamtrail.example.com/.well-known/oauth-protected-resource/mcp');
  assert.deepEqual(buildMcpProtectedResourceMetadata('https://teamtrail.example.com/mcp', 'tenant.auth0.com'), {
    resource: 'https://teamtrail.example.com/mcp', authorization_servers: ['https://tenant.auth0.com/'],
    bearer_methods_supported: ['header'], scopes_supported: ['mcp:read', 'mcp:write'],
  });
  assert.equal(buildMcpProtectedResourceMetadata('https://teamtrail.example.com/mcp', null), null);
});

test('development REST can still run without an API credential', () => {
  assert.doesNotThrow(() => assertProductionAuth('development', undefined, undefined));
});

test('Auth0 domain is normalized and invalid origins are rejected', () => {
  assert.equal(normalizeAuth0Domain('https://tenant.us.auth0.com/'), 'tenant.us.auth0.com');
  assert.equal(normalizeAuth0Domain('https://attacker.example/path'), null);
  assert.equal(normalizeAuth0Domain(undefined), null);
});

test('shared-token MCP is disabled in production until OAuth grants exist', () => {
  assert.equal(productionMcpToken('production', 'demo-token'), undefined);
  assert.equal(productionMcpToken('development', 'demo-token'), 'demo-token');
});

test('workspace roles allow read-only viewers and restrict membership administration', () => {
  assert.equal(roleCanAccess('viewer', 'POST', '/api/answer'), true);
  assert.equal(roleCanAccess('viewer', 'GET', '/api/graph'), true);
  assert.equal(roleCanAccess('viewer', 'POST', '/api/ingest'), false);
  assert.equal(roleCanAccess('member', 'POST', '/api/ingest'), true);
  assert.equal(roleCanAccess('member', 'POST', '/api/schema'), false);
  assert.equal(roleCanAccess('member', 'POST', '/api/workspace/members'), false);
  assert.equal(roleCanAccess('admin', 'POST', '/api/workspace/members'), true);
  assert.equal(roleCanAccess('member', 'DELETE', '/api/sources/nango:slack:connection-1'), false);
  assert.equal(roleCanAccess('admin', 'DELETE', '/api/sources/nango:slack:connection-1'), true);
  assert.equal(roleCanAccess('unknown', 'GET', '/api/graph'), false);
});

test('workspace status reports only configured capabilities and no credentials or invented connections', () => {
  const status = buildWorkspaceStatus('teamtrail', {
    NANGO_API_KEY: 'secret-that-must-not-escape',
    NANGO_INTEGRATIONS: 'drive-prod, slack-prod',
    AUTH0_DOMAIN: 'tenant.example', AUTH0_CLIENT_ID: 'client', AUTH0_AUDIENCE: 'api',
  }, true);
  assert.equal(status.integrations.broker, 'nango-configured');
  assert.deepEqual(status.integrations.configured, ['drive-prod', 'slack-prod']);
  assert.deepEqual(status.integrations.connected, []);
  assert.equal(status.authentication.mode, 'auth0-jwt');
  assert.equal(status.mcp.auth, 'shared-bearer');
  assert.equal(JSON.stringify(status).includes('secret-that-must-not-escape'), false);
});

test('REST limiter caps request volume and locks repeated authentication failures for one window', () => {
  let now = 1_000;
  const limiter = new RestRequestLimiter(() => now);
  for (let i = 0; i < 120; i++) assert.equal(limiter.consume('client-a'), null);
  assert.equal(limiter.consume('client-a').retryAfterSeconds, 60);
  assert.equal(limiter.consume('client-a').retryAfterSeconds, 60);
  now += 60_001;
  for (let i = 0; i < 13; i++) limiter.recordAuthFailure('client-b');
  assert.equal(limiter.consume('client-b').retryAfterSeconds, 60);
  now += 60_001;
  assert.equal(limiter.consume('client-b'), null);
});

test('browser UI assets are reachable before token entry while JSON API remains protected', () => {
  assert.equal(requiresRestBearerAuth('/'), false);
  assert.equal(requiresRestBearerAuth('/assets/index.js'), false);
  assert.equal(requiresRestBearerAuth('/api/health'), true);
  assert.equal(requiresRestBearerAuth('/api/health/live'), false);
  assert.equal(requiresRestBearerAuth('/api/graph'), true);
});
