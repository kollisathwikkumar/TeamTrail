import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMcpAuthInfo } from '../dist/mcp-oauth.js';

const now = () => 2_000_000_000_000;
function fakeBrain({ active = true } = {}) {
  const registered = [];
  return {
    registered,
    async getWorkspaceMembership(principalId, groupId) {
      return { principalId, groupId, role: 'member' };
    },
    async getProviderAccessContext(principalId) {
      return { principalId, sourceAccounts: { slack: 'U-1' }, groups: ['teamtrail_workspace', 'slack:channel:C-1'] };
    },
    async registerMcpGrant(grant) {
      registered.push(grant);
      return active;
    },
  };
}

test('builds per-user MCP AuthInfo from verified Auth0 claims and persists only a token hash', async () => {
  const brain = fakeBrain();
  const token = 'jwt-value-is-not-stored';
  const info = await buildMcpAuthInfo(token, {
    sub: 'auth0|member-1', azp: 'tpc_client-1', aud: ['https://teamtrail.example.com/mcp'],
    scope: 'mcp:read mcp:write', exp: 2_000_000_100,
  }, { audience: 'https://teamtrail.example.com/mcp', groupId: 'teamtrail_workspace', brain, now });
  assert.equal(info.clientId, 'tpc_client-1');
  assert.deepEqual(info.scopes, ['mcp:read', 'mcp:write']);
  assert.equal(info.extra.principalId, 'auth0|member-1');
  assert.equal(info.extra.role, 'member');
  assert.deepEqual(info.extra.accessContext.groups, ['teamtrail_workspace', 'slack:channel:C-1']);
  assert.notEqual(brain.registered[0].tokenHash, token);
  assert.equal(brain.registered[0].principalId, 'auth0|member-1');
});

test('rejects missing read scope, wrong audience, missing expiry, non-member, and revoked grant', async () => {
  const base = { sub: 'auth0|member-1', azp: 'client-1', aud: 'https://teamtrail.example.com/mcp', scope: 'mcp:read', exp: 2_000_000_100 };
  const options = { audience: 'https://teamtrail.example.com/mcp', groupId: 'teamtrail_workspace', brain: fakeBrain(), now };
  await assert.rejects(buildMcpAuthInfo('t', { ...base, scope: 'mcp:write' }, options), /mcp:read/);
  await assert.rejects(buildMcpAuthInfo('t', { ...base, aud: 'https://other.example/mcp' }, options), /audience/);
  await assert.rejects(buildMcpAuthInfo('t', { ...base, exp: undefined }, options), /subject and expiry/);
  const nonMember = fakeBrain();
  nonMember.getWorkspaceMembership = async () => null;
  await assert.rejects(buildMcpAuthInfo('t', base, { ...options, brain: nonMember }), /membership/);
  await assert.rejects(buildMcpAuthInfo('t', base, { ...options, brain: fakeBrain({ active: false }) }), /revoked or expired/);
});
