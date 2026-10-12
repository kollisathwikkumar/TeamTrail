/**
 * Company Brain: Open-source temporal knowledge graph engine.
 *
 * Combines the best of gbrain (deterministic extraction, fail-improve loop),
 * Graphiti/Zep (bi-temporal facts, contradiction detection), and
 * Supermemory (simple API, profile synthesis).
 *
 * @example
 * ```typescript
 * import { Brain } from '@company-brain/core';
 *
 * const brain = new Brain({
 *   database: 'postgresql://brain:brain@localhost:5432/company_brain',
 *   embedding: { provider: 'openai' },
 *   llm: { provider: 'openai' },
 * });
 *
 * await brain.ingest({
 *   content: "Meeting with Alice from Acme. They're upgrading to enterprise.",
 *   sourceType: 'meeting_transcript',
 *   validAt: new Date(),
 * });
 *
 * const results = await brain.search({ query: "What's happening with Acme?" });
 * ```
 */

import type postgres from 'postgres';
import type {
  BrainConfig,
  EpisodeInput,
  Episode,
  Entity,
  Fact,
  AccessContext,
  SearchOptions,
  SearchResult,
  SchemaDefinition,
  OrganizationalMemoryKind,
  OrganizationalMemoryStatus,
} from './types.js';
import { connect, disconnect, initSchema, getDb } from './db.js';
import { extractAndResolve, getStats, proposeImprovements, suggestPatterns } from './extraction/index.js';
import { search } from './search/index.js';
import { embed } from './embedding.js';
import { normalizeEpisodeInput } from './normalization.js';
import { normalizeVisibility, simulatePermission, visibilitySql } from './security.js';
import { processCanonicalClusters } from './graph/index.js';
import { promoteSkillsFromProposals } from './skills/index.js';
import { answerQuestion } from './answer/index.js';
import { runDbBackedEvalSuite, runTriageEvalSuite, summarizeTriageEvalResults, type EvalFixture } from './eval/index.js';
import { deriveOrganizationalMemory, listOrganizationalMemory, searchOrganizationalMemory, storeOrganizationalMemory } from './memory/index.js';
import { triageInteraction, triageInteractionWithLLM } from './triage/index.js';
import { FalkorDBStore, type TeamTrailGraphSnapshot } from './graph/falkordb-store.js';

export * from './types.js';
export { getDb, disconnect } from './db.js';
export { search, rrfFusion, routeQuery, routeQueryWithLLM, decompose, executePlan, graphTraversalSearch, findSeedEntities, traverseGraph, personalizedPageRank, computePPR, detectCommunities, buildCommunities, searchCommunities, buildAndSummarize } from './search/index.js';
export { asOf, changedSince, validDuring, entityTimeline, recentContradictions } from './search/temporal.js';
export type { RoutingDecision, QueryIntent, QueryTier } from './search/router.js';
export type { SubQuery, DecompositionPlan } from './search/decomposer.js';
export type { TraversalOptions } from './search/graph-traversal.js';
export type { PPROptions } from './search/pagerank.js';
export type { TemporalOptions } from './search/temporal.js';
export type { Community } from './search/communities.js';
export { extractAndResolve, getStats, proposeImprovements, suggestPatterns } from './extraction/index.js';
export { SkillResolver, DEFAULT_SKILLS, loadSkillsFromDir, saveSkillToDir, skillToMarkdown, promoteSkillsFromProposals, skillFromProposal, validateSkill } from './skills/index.js';
export type { Skill, SkillMatch, ResolverConfig, SkillPromotionOptions, SkillPromotionResult } from './skills/index.js';
export { AbstractConnector, ConnectorRegistry, FilesystemConnector, NangoConnector, ConfigurableConnector, loadConnectorsFromDir, validateDefinition, ConnectorDefinitionSchema } from './connectors/index.js';
export type { ConnectorOptions, Connector, SyncOptions, SyncResult, ConnectorConfig, ConnectorDefinition } from './connectors/index.js';
export { WebhookReceiver } from './webhooks/index.js';
export type { WebhookSource, WebhookResult, RawWebhookPayload } from './webhooks/index.js';
export { normalizeEpisodeInput } from './normalization.js';
export { canAccessVisibility, isPublicVisibility, normalizeVisibility, simulatePermission, visibilityFromSourcePermissions, mergeVisibilityPolicies, visibilityWarnings } from './security.js';
export { answerQuestion } from './answer/index.js';
export type { AnswerCitation, AnswerOptions, GroundedAnswer } from './answer/index.js';
export { deriveOrganizationalMemory, listOrganizationalMemory, searchOrganizationalMemory, storeOrganizationalMemory } from './memory/index.js';
export { triageInteraction, triageInteractionWithLLM } from './triage/index.js';
export { runEvalFixture, runEvalSuite, scoreQuery, summarizeEvalResults, allEvalFixtures, baselineEvalFixtures, pressureEvalFixtures, BrainEvalAdapter, runDbBackedEvalSuite, triagePressureFixtures, runTriageEvalSuite, summarizeTriageEvalResults } from './eval/index.js';
export type { EvalAdapter, EvalFixture, EvalExpectations, EvalQueryExpectation, EvalQueryResult, EvalRunResult, TriageEvalCase, TriageEvalResult } from './eval/index.js';
export { proposeCanonicalClusters, proposeEntityClusters, proposeRelationClusters, processCanonicalClusters } from './graph/index.js';
export { FalkorDBStore, composeFalkorAnswer } from './graph/falkordb-store.js';
export type { TeamTrailGraphSnapshot, TeamTrailGraphNode, TeamTrailGraphEdge } from './graph/falkordb-store.js';
export type { CanonicalCluster, CanonicalizationPolicyResult, ClusterOptions } from './graph/index.js';

export class Brain {
  private db: postgres.Sql;
  private config: BrainConfig;
  private groupId: string;
  private falkor: FalkorDBStore | null;

  constructor(config: BrainConfig) {
    this.config = config;
    this.groupId = config.defaultGroupId || 'default';
    this.db = connect(config);
    this.falkor = FalkorDBStore.fromEnvironment();
  }

  /**
   * Initialize the database schema. Run once on first setup.
   */
  async init(): Promise<void> {
    await initSchema(this.db);
    if (this.falkor) await this.falkor.connect();
  }

  async getWorkspaceMembership(principalId: string, groupId = this.groupId): Promise<{ principalId: string; groupId: string; role: 'owner' | 'admin' | 'member' | 'viewer' } | null> {
    const rows = await this.db<{ principal_id: string; group_id: string; role: 'owner' | 'admin' | 'member' | 'viewer' }[]>`
      SELECT principal_id, group_id, role FROM workspace_memberships
      WHERE principal_id = ${principalId} AND group_id = ${groupId} AND status = 'active'
    `;
    const row = rows[0];
    return row ? { principalId: row.principal_id, groupId: row.group_id, role: row.role } : null;
  }

  async listWorkspaceMembers(groupId = this.groupId): Promise<Array<{ principalId: string; role: string; status: string; createdAt: string }>> {
    const rows = await this.db<{ principal_id: string; role: string; status: string; created_at: Date }[]>`
      SELECT principal_id, role, status, created_at FROM workspace_memberships
      WHERE group_id = ${groupId} ORDER BY created_at ASC
    `;
    return rows.map(row => ({ principalId: row.principal_id, role: row.role, status: row.status, createdAt: row.created_at.toISOString() }));
  }

  async setWorkspaceMember(principalId: string, groupId: string, role: 'owner' | 'admin' | 'member' | 'viewer', createdBy?: string): Promise<void> {
    await this.db`INSERT INTO groups (id, name) VALUES (${groupId}, ${groupId}) ON CONFLICT (id) DO NOTHING`;
    await this.db`
      INSERT INTO workspace_memberships (principal_id, group_id, role, status, created_by)
      VALUES (${principalId}, ${groupId}, ${role}, 'active', ${createdBy || null})
      ON CONFLICT (principal_id, group_id) DO UPDATE
      SET role = EXCLUDED.role, status = 'active', updated_at = now(), created_by = EXCLUDED.created_by
    `;
  }

  async removeWorkspaceMember(principalId: string, groupId: string): Promise<void> {
    await this.db`DELETE FROM workspace_memberships WHERE principal_id = ${principalId} AND group_id = ${groupId}`;
  }

  async setProviderIdentityLink(input: { principalId: string; groupId: string; provider: string; providerUserId: string; providerGroups?: string[] }): Promise<void> {
    const provider = input.provider.toLowerCase().replace(/_/g, '-');
    const normalizeGoogleDriveIdentity = (value: string): string => {
      const normalized = value.trim().toLowerCase();
      if (provider !== 'google-drive') return value.trim();
      if (normalized.startsWith('email:') || normalized.startsWith('domain:')) return normalized;
      return normalized.includes('@') ? `email:${normalized}` : normalized;
    };
    await this.db`
      INSERT INTO provider_identity_links (principal_id, group_id, provider, provider_user_id, provider_groups, status, verified_at)
      VALUES (${input.principalId}, ${input.groupId}, ${provider}, ${normalizeGoogleDriveIdentity(input.providerUserId)}, ${input.providerGroups?.map(normalizeGoogleDriveIdentity) || []}, 'active', now())
      ON CONFLICT (principal_id, group_id, provider) DO UPDATE SET
        provider_user_id = EXCLUDED.provider_user_id,
        provider_groups = EXCLUDED.provider_groups,
        status = 'active', verified_at = now(), updated_at = now()
    `;
  }

  async getProviderAccessContext(principalId: string, groupId = this.groupId): Promise<AccessContext> {
    const rows = await this.db<{ provider: string; provider_user_id: string; provider_groups: string[] }[]>`
      SELECT provider, provider_user_id, provider_groups FROM provider_identity_links
      WHERE principal_id = ${principalId} AND group_id = ${groupId} AND status = 'active'
      ORDER BY provider
    `;
    const sourceAccounts: Record<string, string> = {};
    const groups = [groupId];
    for (const row of rows) {
      sourceAccounts[row.provider] = row.provider_user_id;
      groups.push(...(row.provider_groups || []).map(value => `${row.provider}:${value}`));
    }
    return { principalId, groups: Array.from(new Set(groups)), sourceAccounts };
  }

  async listProviderIdentityLinks(principalId: string, groupId = this.groupId): Promise<Array<{ provider: string; providerUserId: string; providerGroups: string[]; verifiedAt: string }>> {
    const rows = await this.db<{ provider: string; provider_user_id: string; provider_groups: string[]; verified_at: Date }[]>`
      SELECT provider, provider_user_id, provider_groups, verified_at FROM provider_identity_links
      WHERE principal_id = ${principalId} AND group_id = ${groupId} AND status = 'active'
      ORDER BY provider
    `;
    return rows.map(row => ({ provider: row.provider, providerUserId: row.provider_user_id, providerGroups: row.provider_groups, verifiedAt: row.verified_at.toISOString() }));
  }

  async revokeProviderIdentityLink(principalId: string, groupId: string, provider: string): Promise<void> {
    const rows = await this.db<{ provider: string }[]>`
      UPDATE provider_identity_links SET status = 'revoked', updated_at = now()
      WHERE principal_id = ${principalId} AND group_id = ${groupId} AND provider = ${provider}
      RETURNING provider
    `;
    if (rows.length) await this.auditLog(groupId, 'provider_identity_revoked', 'provider_identity', `${principalId}:${provider}`, { provider }, principalId);
  }

  async registerMcpGrant(input: { tokenHash: string; principalId: string; clientId: string; groupId: string; scopes: string[]; expiresAt: Date }): Promise<boolean> {
    await this.db`
      INSERT INTO mcp_oauth_grants (token_hash, principal_id, client_id, group_id, scopes, expires_at)
      VALUES (${input.tokenHash}, ${input.principalId}, ${input.clientId}, ${input.groupId}, ${input.scopes}, ${input.expiresAt})
      ON CONFLICT (token_hash) DO NOTHING
    `;
    const rows = await this.db<{ active: boolean }[]>`
      SELECT (revoked_at IS NULL AND expires_at > now()) AS active FROM mcp_oauth_grants
      WHERE token_hash = ${input.tokenHash} AND principal_id = ${input.principalId} AND group_id = ${input.groupId}
    `;
    return rows[0]?.active === true;
  }

  async listMcpGrants(principalId: string, groupId = this.groupId): Promise<Array<{ id: string; clientId: string; scopes: string[]; expiresAt: string; createdAt: string; revokedAt: string | null }>> {
    const rows = await this.db<{ id: string; client_id: string; scopes: string[]; expires_at: Date; created_at: Date; revoked_at: Date | null }[]>`
      SELECT id, client_id, scopes, expires_at, created_at, revoked_at FROM mcp_oauth_grants
      WHERE principal_id = ${principalId} AND group_id = ${groupId}
      ORDER BY created_at DESC LIMIT 100
    `;
    return rows.map(row => ({ id: row.id, clientId: row.client_id, scopes: row.scopes, expiresAt: row.expires_at.toISOString(), createdAt: row.created_at.toISOString(), revokedAt: row.revoked_at?.toISOString() || null }));
  }

  async revokeMcpGrant(grantId: string, principalId: string, groupId = this.groupId, revokeOthers = false, revokedBy = principalId): Promise<boolean> {
    const rows = await this.db<{ id: string }[]>`
      UPDATE mcp_oauth_grants SET revoked_at = COALESCE(revoked_at, now()), revoked_by = COALESCE(revoked_by, ${revokedBy})
      WHERE id = ${grantId} AND group_id = ${groupId} AND (${revokeOthers} OR principal_id = ${principalId})
      RETURNING id
    `;
    if (rows.length) await this.auditLog(groupId, 'mcp_grant_revoked', 'mcp_oauth_grant', rows[0].id, {}, revokedBy);
    return rows.length > 0;
  }

  /** Permanently delete a provider connection's source rows and dependent derived records. */
  async deleteSourceData(input: { groupId?: string; sourceType?: string; sourceIds?: string[]; connectionId?: string }): Promise<{ episodes: number; facts: number; memories: number; orphanEntities: number }> {
    const groupId = input.groupId || this.groupId;
    if (!input.sourceType && !input.sourceIds?.length && !input.connectionId) throw new Error('At least one source selector is required');
    const sourceIds = input.sourceIds || [];
    const deleted = await this.db.begin(async tx => {
      const targets = await tx<{ id: string }[]>`
        SELECT id FROM episodes WHERE group_id = ${groupId}
          AND (${input.sourceType || null}::text IS NULL OR source_type = ${input.sourceType || null})
          AND (${sourceIds.length === 0} OR source_id = ANY(${sourceIds}::text[]))
          AND (${input.connectionId || null}::text IS NULL OR metadata->>'nangoConnectionId' = ${input.connectionId || null})
      `;
      const ids = targets.map(row => String(row.id));
      if (ids.length === 0) return { episodes: 0, facts: 0, memories: 0, orphanEntities: 0 };
      const candidateEntities = await tx<{ id: string }[]>`
        SELECT DISTINCT entity_id AS id FROM (
          SELECT source_entity_id AS entity_id FROM facts WHERE group_id = ${groupId} AND source_episode_id = ANY(${ids}::uuid[])
          UNION ALL
          SELECT target_entity_id AS entity_id FROM facts WHERE group_id = ${groupId} AND source_episode_id = ANY(${ids}::uuid[])
        ) candidates WHERE entity_id IS NOT NULL
      `;
      const candidateIds = candidateEntities.map(row => String(row.id));
      const facts = await tx`DELETE FROM facts WHERE group_id = ${groupId} AND source_episode_id = ANY(${ids}::uuid[]) RETURNING id`;
      const memories = await tx`DELETE FROM organizational_memory WHERE group_id = ${groupId} AND source_episode_id = ANY(${ids}::uuid[]) RETURNING id`;
      await tx`DELETE FROM episodes WHERE group_id = ${groupId} AND id = ANY(${ids}::uuid[])`;
      const entities = candidateIds.length ? await tx`
        DELETE FROM entities e WHERE e.group_id = ${groupId} AND e.id = ANY(${candidateIds}::uuid[])
          AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.group_id = e.group_id AND (f.source_entity_id = e.id OR f.target_entity_id = e.id))
          AND NOT EXISTS (SELECT 1 FROM organizational_memory m WHERE m.group_id = e.group_id AND (m.subject = e.name OR m.owner = e.name))
        RETURNING id
      ` : [];
      return { episodes: ids.length, facts: facts.length, memories: memories.length, orphanEntities: entities.length };
    });
    if (deleted.episodes > 0) {
      await this.auditLog(groupId, 'source_data_deleted', 'source', input.connectionId || input.sourceType || 'selected', deleted);
      await this.syncGroupToFalkor(groupId);
    }
    return deleted;
  }

  async getGraphSnapshot(groupId = this.groupId, access?: AccessContext): Promise<TeamTrailGraphSnapshot> {
    if (!this.falkor) throw new Error('FalkorDB is not configured. Set FALKORDB_HOST to enable the TeamTrail graph.');
    return this.falkor.snapshot(groupId, access);
  }

  async graphHealth(): Promise<boolean> {
    return this.falkor ? this.falkor.health() : false;
  }

  async serviceHealth(): Promise<{ postgres: boolean; falkorDb: boolean }> {
    const [postgres, falkorDb] = await Promise.all([
      this.db`SELECT 1`.then(() => true).catch(() => false),
      this.graphHealth().catch(() => false),
    ]);
    return { postgres, falkorDb };
  }

  /**
   * Ingest raw data into the brain.
   *
   * Creates an episode (raw provenance), then runs the extraction pipeline
   * to extract entities and facts, resolve them against the existing graph,
   * and store everything with full temporal tracking.
   *
   * If the episode has a sourceId that already exists, it is skipped (dedup).
   */
  async ingest(input: EpisodeInput): Promise<{
    episodeId: string;
    entitiesCreated: number;
    entitiesUpdated: number;
    factsCreated: number;
    factsInvalidated: number;
    memoryCreated: number;
    ambiguities: Array<{
      type: 'entity_resolution' | 'fact_resolution';
      reason: string;
      payload: Record<string, unknown>;
    }>;
    skipped?: boolean;
    skipReason?: string;
  }> {
    const groupId = input.groupId || this.groupId;
    const validAt = input.validAt || new Date();
    const normalized = normalizeEpisodeInput(input);
    const triage = await triageInteractionWithLLM(normalized.content, {
      sourceType: input.sourceType,
      metadata: { ...normalized.metadata, visibility: normalized.visibility },
      config: this.config.triage,
      llmConfig: this.config.llm,
    });
    const episodeMetadata = { ...normalized.metadata, triage };

    // 0. Ensure group exists
    await this.db`
      INSERT INTO groups (id, name) VALUES (${groupId}, ${groupId})
      ON CONFLICT (id) DO NOTHING
    `;

    if (!triage.shouldStoreEpisode) {
      await this.auditLog(groupId, 'ingest_triage_drop', 'episode', null, {
        sourceType: input.sourceType,
        sourceId: input.sourceId || null,
        triage,
      });
      return {
        episodeId: '',
        entitiesCreated: 0,
        entitiesUpdated: 0,
        factsCreated: 0,
        factsInvalidated: 0,
        memoryCreated: 0,
        ambiguities: [],
        skipped: true,
        skipReason: 'triage_drop',
      };
    }

    // 1. Store the raw episode (with dedup on source_id)
    const contentEmbedding = await embed(normalized.content, this.config.embedding).catch(() => null);
    let episodeId: string;
    try {
      const episodeResult = await this.db`
        INSERT INTO episodes (group_id, source_type, source_id, content, content_embedding, metadata, visibility, valid_at)
        VALUES (
          ${groupId},
          ${input.sourceType},
          ${input.sourceId || null},
          ${normalized.content},
          ${contentEmbedding ? `[${contentEmbedding.join(',')}]` : null},
          ${this.db.json(episodeMetadata as any)},
          ${this.db.json(normalized.visibility as any)},
          ${validAt}
        )
        ON CONFLICT (group_id, source_type, source_id) WHERE source_id IS NOT NULL
        DO NOTHING
        RETURNING id
      `;
      if (episodeResult.length === 0) {
        // Episode already exists — skip extraction entirely
        const existing = await this.db`
          SELECT id FROM episodes
          WHERE group_id = ${groupId} AND source_type = ${input.sourceType} AND source_id = ${input.sourceId || null}
          LIMIT 1
        `;
        return {
          episodeId: existing[0]?.id ?? '',
          entitiesCreated: 0,
          entitiesUpdated: 0,
          factsCreated: 0,
          factsInvalidated: 0,
          memoryCreated: 0,
          ambiguities: [],
          skipped: true,
        };
      }
      episodeId = episodeResult[0].id;
    } catch {
      // Fallback for DBs without the unique index yet
      const episodeResult = await this.db`
        INSERT INTO episodes (group_id, source_type, source_id, content, content_embedding, metadata, visibility, valid_at)
        VALUES (
          ${groupId},
          ${input.sourceType},
          ${input.sourceId || null},
          ${normalized.content},
          ${contentEmbedding ? `[${contentEmbedding.join(',')}]` : null},
          ${this.db.json(episodeMetadata as any)},
          ${this.db.json(normalized.visibility as any)},
          ${validAt}
        )
        RETURNING id
      `;
      episodeId = episodeResult[0].id;
    }

    if (!triage.shouldExtract && !triage.shouldStoreMemory) {
      await this.auditLog(groupId, 'ingest_triage_ephemeral', 'episode', episodeId, {
        sourceType: input.sourceType,
        sourceId: input.sourceId || null,
        triage,
      });
      return {
        episodeId,
        entitiesCreated: 0,
        entitiesUpdated: 0,
        factsCreated: 0,
        factsInvalidated: 0,
        memoryCreated: 0,
        ambiguities: [],
        skipped: true,
        skipReason: 'triage_ephemeral',
      };
    }

    // 2. Load known entities for deterministic matching
    const knownEntities = await this.loadKnownEntities(groupId);

    // 3. Run extraction pipeline
    const result = await extractAndResolve(this.db, normalized.content, {
      groupId,
      episodeId,
      config: this.config.extraction,
      llmConfig: this.config.llm,
      embeddingConfig: this.config.embedding,
      deterministicContext: { knownEntities },
      visibility: normalized.visibility,
    });

    const memoryObjects = await deriveOrganizationalMemory(normalized.content, {
      groupId,
      episodeId,
      sourceType: input.sourceType,
      metadata: episodeMetadata,
      visibility: normalized.visibility,
      validAt,
      llmConfig: this.config.llm,
    });
    const memoryCreated = await storeOrganizationalMemory(this.db, memoryObjects, {
      groupId,
      embeddingConfig: this.config.embedding,
    });

    // Keep FalkorDB current after Company Brain's extraction pipeline commits.
    // In FalkorDB mode, answer and graph endpoints read only from this graph.
    if (this.falkor) await this.syncGroupToFalkor(groupId);

    await this.auditLog(groupId, 'ingest', 'episode', episodeId, {
      sourceType: input.sourceType,
      sourceId: input.sourceId || null,
      visibility: normalized.visibility,
      triage,
      memoryCreated,
    });

    return {
      episodeId,
      entitiesCreated: result.entitiesCreated,
      entitiesUpdated: result.entitiesUpdated,
      factsCreated: result.factsCreated,
      factsInvalidated: result.factsInvalidated,
      memoryCreated,
      ambiguities: result.ambiguities,
    };
  }

  /**
   * Batch ingest multiple episodes efficiently.
   *
   * Shares the known-entity cache across all episodes in the batch,
   * deduplicates episodes by source_id, and refreshes the cache
   * after each episode so later episodes in the batch can resolve
   * entities created by earlier ones.
   */
  async ingestBatch(inputs: EpisodeInput[]): Promise<{
    total: number;
    ingested: number;
    skipped: number;
    entitiesCreated: number;
    entitiesUpdated: number;
    factsCreated: number;
    factsInvalidated: number;
    memoryCreated: number;
    ambiguities: Array<{
      sourceId?: string;
      type: 'entity_resolution' | 'fact_resolution';
      reason: string;
      payload: Record<string, unknown>;
    }>;
  }> {
    if (inputs.length === 0) {
      return { total: 0, ingested: 0, skipped: 0, entitiesCreated: 0, entitiesUpdated: 0, factsCreated: 0, factsInvalidated: 0, memoryCreated: 0, ambiguities: [] };
    }

    const groupId = inputs[0].groupId || this.groupId;

    // Ensure group exists once
    await this.db`
      INSERT INTO groups (id, name) VALUES (${groupId}, ${groupId})
      ON CONFLICT (id) DO NOTHING
    `;

    // Load known entities once for the whole batch
    let knownEntities = await this.loadKnownEntities(groupId);

    let ingested = 0;
    let skipped = 0;
    let totalEntitiesCreated = 0;
    let totalEntitiesUpdated = 0;
    let totalFactsCreated = 0;
    let totalFactsInvalidated = 0;
    let totalMemoryCreated = 0;
    const ambiguities: Array<{
      sourceId?: string;
      type: 'entity_resolution' | 'fact_resolution';
      reason: string;
      payload: Record<string, unknown>;
    }> = [];

    for (const input of inputs) {
      const validAt = input.validAt || new Date();
      const normalized = normalizeEpisodeInput(input);
      const triage = await triageInteractionWithLLM(normalized.content, {
        sourceType: input.sourceType,
        metadata: { ...normalized.metadata, visibility: normalized.visibility },
        config: this.config.triage,
        llmConfig: this.config.llm,
      });
      const episodeMetadata = { ...normalized.metadata, triage };

      if (!triage.shouldStoreEpisode) {
        await this.auditLog(groupId, 'ingest_triage_drop', 'episode', null, {
          sourceType: input.sourceType,
          sourceId: input.sourceId || null,
          triage,
        });
        skipped++;
        continue;
      }

      // Store episode with dedup
      const contentEmbedding = await embed(normalized.content, this.config.embedding).catch(() => null);
      let episodeId: string;
      try {
        const episodeResult = await this.db`
          INSERT INTO episodes (group_id, source_type, source_id, content, content_embedding, metadata, visibility, valid_at)
          VALUES (
            ${groupId},
            ${input.sourceType},
            ${input.sourceId || null},
            ${normalized.content},
            ${contentEmbedding ? `[${contentEmbedding.join(',')}]` : null},
            ${this.db.json(episodeMetadata as any)},
            ${this.db.json(normalized.visibility as any)},
            ${validAt}
          )
          ON CONFLICT (group_id, source_type, source_id) WHERE source_id IS NOT NULL
          DO NOTHING
          RETURNING id
        `;
        if (episodeResult.length === 0) {
          skipped++;
          continue;
        }
        episodeId = episodeResult[0].id;
      } catch {
        const episodeResult = await this.db`
          INSERT INTO episodes (group_id, source_type, source_id, content, content_embedding, metadata, visibility, valid_at)
          VALUES (
            ${groupId},
            ${input.sourceType},
            ${input.sourceId || null},
            ${normalized.content},
            ${contentEmbedding ? `[${contentEmbedding.join(',')}]` : null},
            ${this.db.json(episodeMetadata as any)},
            ${this.db.json(normalized.visibility as any)},
            ${validAt}
          )
          RETURNING id
        `;
        episodeId = episodeResult[0].id;
      }

      if (!triage.shouldExtract && !triage.shouldStoreMemory) {
        await this.auditLog(groupId, 'ingest_triage_ephemeral', 'episode', episodeId, {
          sourceType: input.sourceType,
          sourceId: input.sourceId || null,
          triage,
        });
        skipped++;
        continue;
      }

      // Run extraction with shared entity cache
      const result = await extractAndResolve(this.db, normalized.content, {
        groupId,
        episodeId,
        config: this.config.extraction,
        llmConfig: this.config.llm,
        embeddingConfig: this.config.embedding,
        deterministicContext: { knownEntities },
        visibility: normalized.visibility,
      });

      const memoryObjects = await deriveOrganizationalMemory(normalized.content, {
        groupId,
        episodeId,
        sourceType: input.sourceType,
        metadata: episodeMetadata,
        visibility: normalized.visibility,
        validAt,
        llmConfig: this.config.llm,
      });
      const memoryCreated = await storeOrganizationalMemory(this.db, memoryObjects, {
        groupId,
        embeddingConfig: this.config.embedding,
      });

      totalEntitiesCreated += result.entitiesCreated;
      totalEntitiesUpdated += result.entitiesUpdated;
      totalFactsCreated += result.factsCreated;
      totalFactsInvalidated += result.factsInvalidated;
      totalMemoryCreated += memoryCreated;
      ambiguities.push(...result.ambiguities.map(ambiguity => ({
        sourceId: input.sourceId,
        ...ambiguity,
      })));
      ingested++;

      // Refresh known entities cache if new entities were created
      // so subsequent episodes in the batch can resolve them
      if (result.entitiesCreated > 0) {
        knownEntities = await this.loadKnownEntities(groupId);
      }
    }

    if (ingested > 0 && this.falkor) await this.syncGroupToFalkor(groupId);

    return {
      total: inputs.length,
      ingested,
      skipped,
      entitiesCreated: totalEntitiesCreated,
      entitiesUpdated: totalEntitiesUpdated,
      factsCreated: totalFactsCreated,
      factsInvalidated: totalFactsInvalidated,
      memoryCreated: totalMemoryCreated,
      ambiguities,
    };
  }

  /**
   * Load all known entity aliases for a group into a Map for deterministic matching.
   */
  private async loadKnownEntities(groupId: string): Promise<Map<string, { id: string; type: string }>> {
    const knownEntities = new Map<string, { id: string; type: string }>();
    const aliases = await this.db`
      SELECT ea.alias, ea.entity_id, e.entity_type
      FROM entity_aliases ea
      JOIN entities e ON e.id = ea.entity_id
      WHERE e.group_id = ${groupId}
    `;
    for (const row of aliases) {
      knownEntities.set(row.alias, { id: row.entity_id, type: row.entity_type });
    }
    return knownEntities;
  }

  /**
   * Search the brain. Combines semantic, keyword, graph, and temporal search.
   */
  async search(options: SearchOptions): Promise<SearchResult[]> {
    const opts = {
      ...options,
      groupId: options.groupId || this.groupId,
      llmConfig: this.config.llm,
    };
    return search(this.db, opts, this.config.embedding);
  }

  /**
   * Answer a question with citations from retrieved graph evidence.
   */
  async answer(options: SearchOptions & { trace?: boolean }) {
    if (this.falkor) {
      return this.falkor.answer(options.query, {
        groupId: options.groupId || this.groupId,
        access: options.access,
        asOf: options.asOf,
        limit: options.limit,
      });
    }
    return answerQuestion(this.db, {
      ...options,
      groupId: options.groupId || this.groupId,
    }, this.config.embedding, this.config.llm);
  }

  async searchMemory(options: {
    query: string;
    groupId?: string;
    limit?: number;
    access?: AccessContext;
    kinds?: OrganizationalMemoryKind[];
    statuses?: OrganizationalMemoryStatus[];
  }): Promise<SearchResult[]> {
    return searchOrganizationalMemory(this.db, {
      ...options,
      groupId: options.groupId || this.groupId,
      embeddingConfig: this.config.embedding,
    });
  }

  async listMemory(options: {
    groupId?: string;
    limit?: number;
    access?: AccessContext;
    kinds?: OrganizationalMemoryKind[];
    statuses?: OrganizationalMemoryStatus[];
  } = {}) {
    return listOrganizationalMemory(this.db, {
      ...options,
      groupId: options.groupId || this.groupId,
    });
  }

  async cleanupEphemeralEpisodes(options?: {
    groupId?: string;
    olderThanDays?: number;
    limit?: number;
  }): Promise<{ deleted: number; episodeIds: string[] }> {
    const groupId = options?.groupId || this.groupId;
    const olderThanDays = options?.olderThanDays ?? this.config.triage?.ephemeralTtlDays ?? 14;
    const limit = options?.limit ?? 1000;
    const rows = await this.db`
      WITH expired AS (
        SELECT id
        FROM episodes e
        WHERE e.group_id = ${groupId}
          AND e.metadata #>> '{triage,retention}' = 'ephemeral'
          AND e.valid_at < now() - (${olderThanDays} * interval '1 day')
          AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.source_episode_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM organizational_memory m WHERE m.source_episode_id = e.id)
        ORDER BY e.valid_at ASC
        LIMIT ${limit}
      )
      DELETE FROM episodes
      WHERE id IN (SELECT id FROM expired)
      RETURNING id
    `;
    const episodeIds = rows.map(row => String(row.id));
    if (episodeIds.length > 0) {
      await this.auditLog(groupId, 'cleanup_ephemeral_episodes', 'episode', null, {
        olderThanDays,
        deleted: episodeIds.length,
      });
    }
    return { deleted: episodeIds.length, episodeIds };
  }

  /**
   * Get an entity by ID with all its current facts and connections.
   */
  async getEntity(id: string, options?: {
    includeFacts?: boolean;
    includeTimeline?: boolean;
    includeRelated?: boolean;
    depth?: number;
    access?: AccessContext;
  }): Promise<{
    entity: Entity;
    facts: Fact[];
    related: Entity[];
    timeline: Fact[];
  } | null> {
    const rows = await this.db`
      SELECT * FROM entities
      WHERE id = ${id}
      ${visibilitySql(this.db, this.db`visibility`, options?.access)}
    `;
    if (rows.length === 0) return null;

    const entity = this.rowToEntity(rows[0]);
    let facts: Fact[] = [];
    let related: Entity[] = [];
    let timeline: Fact[] = [];

    if (options?.includeFacts !== false) {
      const factRows = await this.db`
        SELECT * FROM facts
        WHERE (source_entity_id = ${id} OR target_entity_id = ${id})
          AND invalid_at IS NULL
          ${visibilitySql(this.db, this.db`visibility`, options?.access)}
        ORDER BY valid_at DESC
      `;
      facts = factRows.map(this.rowToFact);
    }

    if (options?.includeTimeline) {
      const timelineRows = await this.db`
        SELECT * FROM facts
        WHERE (source_entity_id = ${id} OR target_entity_id = ${id})
        ${visibilitySql(this.db, this.db`visibility`, options?.access)}
        ORDER BY valid_at DESC
      `;
      timeline = timelineRows.map(this.rowToFact);
    }

    if (options?.includeRelated) {
      const depth = options?.depth || 1;
      const relatedIds = await this.db`
        SELECT DISTINCT
          CASE WHEN source_entity_id = ${id} THEN target_entity_id ELSE source_entity_id END AS related_id
        FROM facts
        WHERE (source_entity_id = ${id} OR target_entity_id = ${id})
          AND invalid_at IS NULL
          ${visibilitySql(this.db, this.db`visibility`, options?.access)}
        LIMIT 50
      `;
      if (relatedIds.length > 0) {
        const ids = relatedIds.map(r => r.related_id);
        const relatedRows = await this.db`
          SELECT * FROM entities
          WHERE id = ANY(${ids})
          ${visibilitySql(this.db, this.db`visibility`, options?.access)}
        `;
        related = relatedRows.map(this.rowToEntity);
      }
    }

    return { entity, facts, related, timeline };
  }

  /**
   * Find an entity by name (fuzzy matching).
   */
  async findEntity(name: string, groupId?: string, access?: AccessContext): Promise<Entity | null> {
    const gid = groupId || this.groupId;
    const rows = await this.db`
      SELECT *, similarity(name, ${name}) AS sim
      FROM entities
      WHERE group_id = ${gid}
        AND similarity(name, ${name}) > 0.3
        ${visibilitySql(this.db, this.db`visibility`, access)}
      ORDER BY sim DESC
      LIMIT 1
    `;
    return rows.length > 0 ? this.rowToEntity(rows[0]) : null;
  }

  /**
   * Get all current facts between two entities.
   */
  async getFacts(sourceId: string, targetId?: string, options?: {
    relation?: string;
    includeInvalidated?: boolean;
    asOf?: Date;
    access?: AccessContext;
  }): Promise<Fact[]> {
    const includeInvalid = options?.includeInvalidated || false;
    const asOf = options?.asOf;

    let rows;
    if (targetId) {
      rows = await this.db`
        SELECT * FROM facts
        WHERE source_entity_id = ${sourceId}
          AND target_entity_id = ${targetId}
          ${options?.relation ? this.db`AND relation = ${options.relation}` : this.db``}
          ${!includeInvalid ? this.db`AND invalid_at IS NULL` : this.db``}
          ${asOf ? this.db`AND valid_at <= ${asOf}` : this.db``}
          ${visibilitySql(this.db, this.db`visibility`, options?.access)}
        ORDER BY valid_at DESC
      `;
    } else {
      rows = await this.db`
        SELECT * FROM facts
        WHERE (source_entity_id = ${sourceId} OR target_entity_id = ${sourceId})
          ${options?.relation ? this.db`AND relation = ${options.relation}` : this.db``}
          ${!includeInvalid ? this.db`AND invalid_at IS NULL` : this.db``}
          ${asOf ? this.db`AND valid_at <= ${asOf}` : this.db``}
          ${visibilitySql(this.db, this.db`visibility`, options?.access)}
        ORDER BY valid_at DESC
      `;
    }

    return rows.map(this.rowToFact);
  }

  /**
   * Define custom entity types and relation types for this brain.
   */
  async defineSchema(schema: SchemaDefinition): Promise<void> {
    if (schema.entityTypes) {
      for (const et of schema.entityTypes) {
        await this.db`
          INSERT INTO entity_types (id, group_id, label, description, schema)
          VALUES (${et.id}, ${this.groupId}, ${et.label}, ${et.description || ''}, ${JSON.stringify(et.schema || {})})
          ON CONFLICT (group_id, id) DO UPDATE SET
            label = ${et.label},
            description = ${et.description || ''},
            schema = ${JSON.stringify(et.schema || {})}
        `;
      }
    }

    if (schema.relationTypes) {
      for (const rt of schema.relationTypes) {
        await this.db`
          INSERT INTO relation_types (
            id, group_id, label, source_types, target_types, description,
            cardinality, invalidation_policy
          )
          VALUES (
            ${rt.id},
            ${this.groupId},
            ${rt.label},
            ${rt.sourceTypes || []},
            ${rt.targetTypes || []},
            ${rt.description || ''},
            ${rt.cardinality || 'many'},
            ${rt.invalidationPolicy || 'llm'}
          )
          ON CONFLICT (group_id, id) DO UPDATE SET
            label = ${rt.label},
            source_types = ${rt.sourceTypes || []},
            target_types = ${rt.targetTypes || []},
            description = ${rt.description || ''},
            cardinality = ${rt.cardinality || 'many'},
            invalidation_policy = ${rt.invalidationPolicy || 'llm'}
        `;
      }
    }
  }

  /**
   * Get fail-improve statistics. Shows how the system is getting smarter.
   */
  async getExtractionStats(since?: Date) {
    return getStats(this.db, this.groupId, since);
  }

  /**
   * Get suggested extraction guidance improvements from the fail-improve loop.
   */
  async getSuggestedPatterns(minOccurrences?: number) {
    return suggestPatterns(this.db, this.groupId, minOccurrences);
  }

  /**
   * Get audited improvement proposals from extraction logs and review signals.
   * These are suggestions for schema, extraction, canonicalization, or skill
   * changes. They should be reviewed before being applied.
   */
  async getImprovementProposals() {
    return proposeImprovements(this.db, this.groupId);
  }

  /**
   * Propose graph-level canonical clusters across entities and relations.
   * This catches duplicate communities that pairwise resolution leaves behind.
   */
  async proposeCanonicalClusters(options?: {
    groupId?: string;
    minConfidence?: number;
    limit?: number;
    autoApplyThreshold?: number;
    ambiguousThreshold?: number;
    enqueueReview?: boolean;
  }) {
    return processCanonicalClusters(this.db, {
      groupId: options?.groupId || this.groupId,
      minConfidence: options?.minConfidence,
      limit: options?.limit,
      autoApplyThreshold: options?.autoApplyThreshold,
      ambiguousThreshold: options?.ambiguousThreshold,
      enqueueReview: options?.enqueueReview,
    });
  }

  /**
   * Closed-loop skill evolution: draft skills from improvement proposals,
   * validate resolver behavior, and optionally promote them to disk.
   */
  async promoteSkills(options?: {
    skillsDir?: string;
    minConfidence?: number;
    autoPromote?: boolean;
  }) {
    const proposals = await this.getImprovementProposals();
    return promoteSkillsFromProposals(this.db, proposals, {
      groupId: this.groupId,
      skillsDir: options?.skillsDir,
      minConfidence: options?.minConfidence,
      autoPromote: options?.autoPromote,
    });
  }

  /**
   * Run DB-backed evals through the real ingest/search path.
   */
  async runEvals(fixtures: EvalFixture[], options?: { groupPrefix?: string }) {
    return runDbBackedEvalSuite(this, fixtures, options);
  }

  /**
   * Explain whether an access context can see a visibility policy.
   */
  simulatePermission(visibility: unknown, access?: AccessContext) {
    return simulatePermission(normalizeVisibility(visibility as any), access);
  }

  /**
   * Load persistent sync state for a connector.
   * Used by ConnectorRegistry for incremental sync across restarts.
   */
  async getSyncState(connectorId: string): Promise<{
    cursor?: string;
    lastSyncAt?: Date;
    metadata?: Record<string, unknown>;
  } | null> {
    const rows = await this.db`
      SELECT cursor, last_sync_at, metadata
      FROM connector_sync_state
      WHERE connector_id = ${connectorId} AND group_id = ${this.groupId}
    `.catch(() => []);
    if (rows.length === 0) return null;
    return {
      cursor: rows[0].cursor ?? undefined,
      lastSyncAt: rows[0].last_sync_at ?? undefined,
      metadata: rows[0].metadata ?? {},
    };
  }

  /**
   * Save persistent sync state for a connector.
   * Upserts so repeated calls just update the existing row.
   */
  async setSyncState(connectorId: string, state: {
    cursor?: string;
    lastSyncAt?: Date;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.db`
      INSERT INTO connector_sync_state (connector_id, group_id, cursor, last_sync_at, metadata, updated_at)
      VALUES (
        ${connectorId},
        ${this.groupId},
        ${state.cursor ?? null},
        ${state.lastSyncAt ?? new Date()},
        ${JSON.stringify(state.metadata || {})},
        now()
      )
      ON CONFLICT (connector_id, group_id) DO UPDATE SET
        cursor = EXCLUDED.cursor,
        last_sync_at = EXCLUDED.last_sync_at,
        metadata = EXCLUDED.metadata,
        updated_at = now()
    `.catch(() => {});
  }

  /**
   * Disconnect from the database.
   */
  async close(): Promise<void> {
    if (this.falkor) await this.falkor.close();
    await disconnect();
  }

  private async syncGroupToFalkor(groupId: string): Promise<void> {
    if (!this.falkor) return;
    const [entityRows, factRows, episodeRows] = await Promise.all([
      this.db`SELECT * FROM entities WHERE group_id = ${groupId}`,
      this.db`SELECT * FROM facts WHERE group_id = ${groupId}`,
      this.db`SELECT * FROM episodes WHERE group_id = ${groupId}`,
    ]);
    const entities = entityRows.map(row => this.rowToEntity(row));
    const facts = factRows.map(row => this.rowToFact(row));
    const episodes = episodeRows.map(row => ({
      id: row.id,
      groupId: row.group_id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      content: row.content,
      metadata: row.metadata || {},
      visibility: normalizeVisibility(row.visibility),
      validAt: row.valid_at,
      createdAt: row.created_at,
    } as Episode));
    await this.falkor.syncGroup(groupId, entities, facts, episodes);
  }

  // ─── Row Mappers ────────────────────────────────────────────

  private rowToEntity(row: any): Entity {
    return {
      id: row.id,
      groupId: row.group_id,
      entityType: row.entity_type,
      name: row.name,
      summary: row.summary || '',
      attributes: row.attributes || {},
      visibility: normalizeVisibility(row.visibility),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToFact(row: any): Fact {
    return {
      id: row.id,
      groupId: row.group_id,
      sourceEntityId: row.source_entity_id,
      targetEntityId: row.target_entity_id,
      relation: row.relation,
      factText: row.fact_text,
      evidence: row.evidence || {},
      extractor: row.extractor || 'unknown',
      visibility: normalizeVisibility(row.visibility),
      validAt: row.valid_at,
      invalidAt: row.invalid_at,
      confidence: Number(row.confidence),
      sourceEpisodeId: row.source_episode_id,
      metadata: row.metadata || {},
      createdAt: row.created_at,
    };
  }

  private async auditLog(
    groupId: string,
    action: string,
    resourceType: string,
    resourceId: string | null,
    metadata: Record<string, unknown> = {},
    actor?: string,
  ): Promise<void> {
    await this.db`
      INSERT INTO audit_log (group_id, actor, action, resource_type, resource_id, metadata)
      VALUES (${groupId}, ${actor || null}, ${action}, ${resourceType}, ${resourceId}, ${this.db.json(metadata as any)})
    `.catch(() => {});
  }
}
