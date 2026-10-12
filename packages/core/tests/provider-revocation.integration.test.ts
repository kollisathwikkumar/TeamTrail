import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { Brain, canAccessVisibility } from '../src/index.js';

const url = process.env.DATABASE_URL || 'postgresql://brain:brain@localhost:5432/company_brain';
const probe = postgres(url, { max: 1, connect_timeout: 1 });
let available = false;
try { await probe`SELECT 1`; available = true; } catch { /* opt-in local DB integration suite */ }
await probe.end();

describe.skipIf(!available)('provider identity revocation and source deletion (PostgreSQL)', () => {
  const groupId = `acl_delete_${crypto.randomUUID().replace(/-/g, '')}`;
  const sql = postgres(url, { max: 1 });
  const brain = new Brain({ database: url, defaultGroupId: groupId });

  beforeAll(async () => {
    await brain.init();
    await sql`INSERT INTO groups (id, name) VALUES (${groupId}, ${groupId}) ON CONFLICT DO NOTHING`;
  });

  afterAll(async () => {
    await sql`DELETE FROM groups WHERE id = ${groupId}`;
    await brain.close();
    await sql.end();
  });

  it('maps provider identities to ACL keys and revokes them immediately', async () => {
    await brain.setProviderIdentityLink({
      principalId: 'auth0|acl-test-user', groupId, provider: 'slack', providerUserId: 'U_123',
      providerGroups: ['channel:C_PRIVATE', 'group:G_SECURITY'],
    });
    const access = await brain.getProviderAccessContext('auth0|acl-test-user', groupId);
    expect(access.sourceAccounts?.slack).toBe('U_123');
    expect(access.groups).toContain('slack:channel:C_PRIVATE');
    expect(canAccessVisibility({ sourceAcl: [{ provider: 'slack', id: 'C_PRIVATE', type: 'channel', access: 'allow' }] }, access)).toBe(true);

    await brain.revokeProviderIdentityLink('auth0|acl-test-user', groupId, 'slack');
    const afterRevoke = await brain.getProviderAccessContext('auth0|acl-test-user', groupId);
    expect(afterRevoke.sourceAccounts?.slack).toBeUndefined();
    expect(canAccessVisibility({ sourceAcl: [{ provider: 'slack', id: 'C_PRIVATE', type: 'channel', access: 'allow' }] }, afterRevoke)).toBe(false);
    expect(await sql`SELECT id FROM audit_log WHERE group_id = ${groupId} AND action = 'provider_identity_revoked' AND actor = 'auth0|acl-test-user'`).toHaveLength(1);
  });

  it('maps Drive users/groups and GitHub repository teams independently, then removes each identity on revocation', async () => {
    await brain.setProviderIdentityLink({
      principalId: 'auth0|acl-test-user', groupId, provider: 'google-drive', providerUserId: 'drive-user@example.test',
      providerGroups: ['drive-team@example.test'],
    });
    await brain.setProviderIdentityLink({
      principalId: 'auth0|acl-test-user', groupId, provider: 'github', providerUserId: 'octocat',
      providerGroups: ['repo:acme/private-docs', 'team:acme/platform'],
    });
    const access = await brain.getProviderAccessContext('auth0|acl-test-user', groupId);
    expect(access.sourceAccounts).toMatchObject({ 'google-drive': 'email:drive-user@example.test', github: 'octocat' });
    expect(access.groups).toContain('google-drive:email:drive-team@example.test');
    expect(access.groups).toContain('github:repo:acme/private-docs');
    expect(canAccessVisibility({ sourceAcl: [{ provider: 'google-drive', id: 'email:drive-user@example.test', type: 'user', access: 'allow' }] }, access)).toBe(true);
    expect(canAccessVisibility({ sourceAcl: [{ provider: 'google-drive', id: 'email:drive-team@example.test', type: 'group', access: 'allow' }] }, access)).toBe(true);
    expect(canAccessVisibility({ sourceAcl: [{ provider: 'github', id: 'repo:acme/private-docs', type: 'group', access: 'allow' }] }, access)).toBe(true);

    await brain.revokeProviderIdentityLink('auth0|acl-test-user', groupId, 'google-drive');
    const driveRevoked = await brain.getProviderAccessContext('auth0|acl-test-user', groupId);
    expect(driveRevoked.sourceAccounts?.['google-drive']).toBeUndefined();
    expect(canAccessVisibility({ sourceAcl: [{ provider: 'google-drive', id: 'email:drive-user@example.test', type: 'user', access: 'allow' }] }, driveRevoked)).toBe(false);
    expect(canAccessVisibility({ sourceAcl: [{ provider: 'github', id: 'repo:acme/private-docs', type: 'group', access: 'allow' }] }, driveRevoked)).toBe(true);
    await brain.revokeProviderIdentityLink('auth0|acl-test-user', groupId, 'github');
    const allRevoked = await brain.getProviderAccessContext('auth0|acl-test-user', groupId);
    expect(allRevoked.sourceAccounts?.github).toBeUndefined();
    expect(canAccessVisibility({ sourceAcl: [{ provider: 'github', id: 'repo:acme/private-docs', type: 'group', access: 'allow' }] }, allRevoked)).toBe(false);
  });

  it('deletes a revoked connection’s episode, derived fact, memory, and orphan graph entities; repeat is idempotent', async () => {
    await sql`INSERT INTO entity_types (id, group_id, label) VALUES ('person', ${groupId}, 'Person') ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO relation_types (id, group_id, label) VALUES ('related_to', ${groupId}, 'Related to') ON CONFLICT DO NOTHING`;
    const [episode] = await sql<{ id: string }[]>`
      INSERT INTO episodes (group_id, source_type, source_id, content, metadata, visibility, valid_at)
      VALUES (${groupId}, 'nango:slack', 'rec_1', 'private test record', ${sql.json({ nangoConnectionId: 'conn_revoked_1' })}, '{}', now())
      RETURNING id
    `;
    const [source] = await sql<{ id: string }[]>`
      INSERT INTO entities (group_id, entity_type, name) VALUES (${groupId}, 'person', 'Deletion Source') RETURNING id
    `;
    const [target] = await sql<{ id: string }[]>`
      INSERT INTO entities (group_id, entity_type, name) VALUES (${groupId}, 'person', 'Deletion Target') RETURNING id
    `;
    const [unrelatedOrphan] = await sql<{ id: string }[]>`
      INSERT INTO entities (group_id, entity_type, name) VALUES (${groupId}, 'person', 'Unrelated Orphan') RETURNING id
    `;
    await sql`
      INSERT INTO facts (group_id, source_entity_id, target_entity_id, relation, fact_text, valid_at, source_episode_id)
      VALUES (${groupId}, ${source.id}, ${target.id}, 'related_to', 'derived from revoked record', now(), ${episode.id})
    `;
    await sql`
      INSERT INTO organizational_memory (group_id, kind, title, summary, valid_at, source_episode_id)
      VALUES (${groupId}, 'decision', 'revoked-source-memory', 'derived from revoked record', now(), ${episode.id})
    `;

    const removed = await brain.deleteSourceData({ groupId, sourceType: 'nango:slack', connectionId: 'conn_revoked_1' });
    expect(removed).toEqual({ episodes: 1, facts: 1, memories: 1, orphanEntities: 2 });
    expect(await sql`SELECT id FROM episodes WHERE id = ${episode.id}`).toHaveLength(0);
    expect(await sql`SELECT id FROM facts WHERE source_episode_id = ${episode.id}`).toHaveLength(0);
    expect(await sql`SELECT id FROM organizational_memory WHERE source_episode_id = ${episode.id}`).toHaveLength(0);
    expect(await sql`SELECT id FROM entities WHERE id = ANY(${[source.id, target.id]}::uuid[])`).toHaveLength(0);
    expect(await sql`SELECT id FROM entities WHERE id = ${unrelatedOrphan.id}`).toHaveLength(1);
    expect(await brain.deleteSourceData({ groupId, sourceType: 'nango:slack', connectionId: 'conn_revoked_1' })).toEqual({ episodes: 0, facts: 0, memories: 0, orphanEntities: 0 });
  });

  it('persists only an OAuth token hash and makes grant revocation non-revivable', async () => {
    const input = {
      tokenHash: `sha256:${crypto.randomUUID()}`,
      principalId: 'auth0|mcp-grant-test', clientId: 'mcp-test-client', groupId,
      scopes: ['mcp:read'], expiresAt: new Date(Date.now() + 60_000),
    };
    expect(await brain.registerMcpGrant(input)).toBe(true);
    const grants = await brain.listMcpGrants(input.principalId, groupId);
    const grant = grants.find(value => value.clientId === input.clientId);
    expect(grant).toBeDefined();
    expect(grant?.revokedAt).toBeNull();
    expect(grant?.id).not.toBe(input.tokenHash);
    expect(await brain.revokeMcpGrant(grant!.id, input.principalId, groupId)).toBe(true);
    expect(await brain.registerMcpGrant(input)).toBe(false);
    expect(await brain.revokeMcpGrant(grant!.id, 'auth0|different-user', groupId)).toBe(false);
    expect(await sql`SELECT id FROM audit_log WHERE group_id = ${groupId} AND action = 'mcp_grant_revoked' AND resource_id = ${grant!.id}`).toHaveLength(1);
  });
});
