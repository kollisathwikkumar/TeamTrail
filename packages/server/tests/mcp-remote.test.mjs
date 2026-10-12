import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpHttpSessions } from '../dist/mcp-remote.js';
import { createMcpServer } from '../dist/mcp.js';

let httpServer;
let baseUrl;
let sessions;
let constructedGroupId;

before(async () => {
  sessions = new McpHttpSessions({
    token: 'teamtrail-test-token',
    groupId: 'teamtrail_test_workspace',
    serverFactory: async (groupId) => {
      const server = new McpServer({ name: 'teamtrail-test', version: '1.0.0' });
      server.registerTool('ping', { description: 'Returns pong', inputSchema: {} }, async () => ({
        content: [{ type: 'text', text: 'pong' }],
      }));
      constructedGroupId = groupId;
      return server;
    },
  });
  httpServer = createServer((req, res) => { void sessions.handle(req, res); });
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  baseUrl = `http://127.0.0.1:${address.port}/mcp`;
});

after(async () => {
  await sessions.close();
  httpServer.close();
  await once(httpServer, 'close');
});

test('rejects missing or incorrect bearer tokens before MCP handling', async () => {
  const response = await fetch(baseUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Unauthorized' });
});

test('keeps remote MCP disabled when no token is configured', async () => {
  const disabledSessions = new McpHttpSessions({
    token: '',
    groupId: 'teamtrail_test_workspace',
    serverFactory: async () => new McpServer({ name: 'disabled-test', version: '1.0.0' }),
  });
  const disabledServer = createServer((req, res) => { void disabledSessions.handle(req, res); });
  disabledServer.listen(0, '127.0.0.1');
  await once(disabledServer, 'listening');
  const address = disabledServer.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/mcp`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Remote MCP is disabled; configure TEAMTRAIL_MCP_TOKEN.' });
  await disabledSessions.close();
  disabledServer.close();
  await once(disabledServer, 'close');
});

test('initializes Streamable HTTP and keeps the same MCP session for tool calls', async () => {
  const headers = {
    authorization: 'Bearer teamtrail-test-token',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  const initialized = await fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test-client', version: '1.0' } },
    }),
  });
  assert.equal(initialized.status, 200);
  const sessionId = initialized.headers.get('mcp-session-id');
  assert.ok(sessionId);
  assert.equal(constructedGroupId, 'teamtrail_test_workspace');
  const initializedBody = await initialized.json();
  assert.equal(initializedBody.result.serverInfo.name, 'teamtrail-test');

  const tools = await fetch(baseUrl, {
    method: 'POST',
    headers: { ...headers, 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-03-26' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  assert.equal(tools.status, 200);
  const toolsBody = await tools.json();
  assert.deepEqual(toolsBody.result.tools.map(tool => tool.name), ['ping']);

  const called = await fetch(baseUrl, {
    method: 'POST',
    headers: { ...headers, 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-03-26' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ping', arguments: {} } }),
  });
  assert.equal(called.status, 200);
  assert.match(JSON.stringify(await called.json()), /pong/);
});

test('rejects unknown MCP session identifiers', async () => {
  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      authorization: 'Bearer teamtrail-test-token',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': 'not-a-session',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(response.status, 404);
});

test('OAuth bearer flow advertises protected-resource metadata and rechecks revocation on every session request', async () => {
  let grantActive = true;
  const oauthSessions = new McpHttpSessions({
    groupId: 'workspace-oauth',
    resourceMetadataUrl: 'https://teamtrail.example.com/.well-known/oauth-protected-resource/mcp',
    verifyAccessToken: async token => {
      if (token !== 'oauth-access-token' || !grantActive) throw new Error('revoked/invalid token');
      return { token, clientId: 'auth0-dcr-client', scopes: ['mcp:read'], expiresAt: 2_000_000_100, extra: { principalId: 'auth0|member', groupId: 'workspace-oauth', role: 'member', accessContext: { groups: ['workspace-oauth'] } } };
    },
    serverFactory: async (_groupId, authInfo) => {
      const server = new McpServer({ name: 'teamtrail-oauth-test', version: '1.0.0' });
      server.registerTool('private-read', { description: 'Read one private workspace item', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'workspace data' }] }));
      assert.deepEqual(authInfo.scopes, ['mcp:read']);
      return server;
    },
  });
  const oauthServer = createServer((req, res) => { void oauthSessions.handle(req, res); });
  oauthServer.listen(0, '127.0.0.1');
  await once(oauthServer, 'listening');
  const address = oauthServer.address();
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'oauth-client', version: '1' } } });
  try {
    const challenge = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(challenge.status, 401);
    assert.match(challenge.headers.get('www-authenticate'), /resource_metadata="https:\/\/teamtrail\.example\.com\/\.well-known\/oauth-protected-resource\/mcp"/);

    const headers = { authorization: 'Bearer oauth-access-token', 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const initialized = await fetch(endpoint, { method: 'POST', headers, body });
    assert.equal(initialized.status, 200);
    const sessionId = initialized.headers.get('mcp-session-id');
    assert.ok(sessionId);
    const requestHeaders = { ...headers, 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-03-26' };
    const tools = await fetch(endpoint, { method: 'POST', headers: requestHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
    assert.deepEqual((await tools.json()).result.tools.map(tool => tool.name), ['private-read']);

    grantActive = false;
    const revokedCall = await fetch(endpoint, { method: 'POST', headers: requestHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }) });
    assert.equal(revokedCall.status, 401);
    assert.deepEqual(await revokedCall.json(), { error: 'Unauthorized' });
  } finally {
    await oauthSessions.close();
    oauthServer.close();
    await once(oauthServer, 'close');
  }
});

test('remote TeamTrail tools stay in the configured workspace and expose a focused tool list', async () => {
  const ingested = [];
  const fakeBrain = {
    async ingest(input) {
      ingested.push(input);
      return { episodeId: 'episode-test', groupId: input.groupId };
    },
  };
  const scopedSessions = new McpHttpSessions({
    token: 'scoped-test-token',
    groupId: 'workspace-a',
    serverFactory: (groupId, authInfo) => createMcpServer(fakeBrain, { webhooksDir: '/tmp/teamtrail-no-webhooks' }, groupId, undefined, {
      accessContext: authInfo.extra?.accessContext || {}, scopes: authInfo.scopes, role: authInfo.extra?.role || 'viewer',
    }),
  });
  const scopedServer = createServer((req, res) => { void scopedSessions.handle(req, res); });
  scopedServer.listen(0, '127.0.0.1');
  await once(scopedServer, 'listening');
  const address = scopedServer.address();
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  const headers = {
    authorization: 'Bearer scoped-test-token',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  const originalInfo = console.info;
  const loggedCalls = [];
  console.info = message => loggedCalls.push(String(message));
  try {
    const initialized = await fetch(endpoint, {
      method: 'POST', headers,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'scope-test', version: '1' } },
      }),
    });
    const sessionId = initialized.headers.get('mcp-session-id');
    assert.ok(sessionId);
    const sessionHeaders = { ...headers, 'mcp-session-id': sessionId, 'mcp-protocol-version': '2025-03-26' };
    const listed = await fetch(endpoint, {
      method: 'POST', headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const names = (await listed.json()).result.tools.map(tool => tool.name);
    assert.ok(names.includes('answer'));
    assert.ok(names.includes('ingest'));
    assert.ok(!names.some(name => ['nango_connect', 'list_connectors', 'connect', 'sync_connector'].includes(name)));
    assert.ok(!names.includes('get_entity'));
    assert.ok(!names.includes('cleanup_ephemeral'));

    const ingestedResult = await fetch(endpoint, {
      method: 'POST', headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'ingest', arguments: { content: 'A captured agent note.', sourceType: 'agent_note', groupId: 'attacker-selected-group' } },
      }),
    });
    assert.equal(ingestedResult.status, 200);
    assert.equal(ingested[0].groupId, 'workspace-a');
    assert.match(loggedCalls[0], /"client":"scope-test"/);
    assert.match(loggedCalls[0], /"tool":"ingest"/);
    assert.doesNotMatch(loggedCalls[0], /A captured agent note/);
  } finally {
    console.info = originalInfo;
    await scopedSessions.close();
    scopedServer.close();
    await once(scopedServer, 'close');
  }
});
