import { FalkorDB } from 'falkordb';
import { randomUUID } from 'node:crypto';
import type { AccessContext, Entity, Episode, Fact } from '../types.js';
import { canAccessVisibility, normalizeVisibility } from '../security.js';

type FalkorClient = Awaited<ReturnType<typeof FalkorDB.connect>>;
type FalkorGraph = ReturnType<FalkorClient['selectGraph']>;

export interface GraphAnswerRow {
  factId?: unknown;
  relation?: unknown;
  factText?: unknown;
  confidence?: unknown;
  validAt?: unknown;
  invalidAt?: unknown;
  sourceId?: unknown;
  sourceName?: unknown;
  targetId?: unknown;
  targetName?: unknown;
  episodeId?: unknown;
  sourceType?: unknown;
  sourceLabel?: unknown;
  episodeContent?: unknown;
  sourceUrl?: unknown;
  visibility?: unknown;
  episodeVisibility?: unknown;
}

export interface TeamTrailGraphNode {
  id: string;
  name: string;
  type: string;
  kind: 'entity' | 'fact' | 'episode';
  summary: string;
  sourceUrl?: string;
  relation?: string;
  validAt?: string;
  invalidAt?: string | null;
}

export interface TeamTrailGraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  text?: string;
  confidence?: number;
}

export interface TeamTrailGraphSnapshot {
  groupId: string;
  graph: string;
  nodes: TeamTrailGraphNode[];
  links: TeamTrailGraphEdge[];
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'who', 'what', 'where', 'when', 'why', 'how', 'does', 'did', 'can', 'should', 'could', 'about', 'with', 'from', 'into', 'this', 'that', 'was', 'were', 'are', 'is', 'our', 'their', 'they', 'you', 'tell', 'show', 'me', 'please', 'explain']);

function unpackRows(result: unknown): Record<string, unknown>[] {
  if (!result || typeof result !== 'object') return [];
  const value = result as { data?: unknown[]; headers?: string[] };
  if (!Array.isArray(value.data)) return [];
  if (value.data.every(row => row && !Array.isArray(row) && typeof row === 'object')) {
    return value.data as Record<string, unknown>[];
  }
  const headers = Array.isArray(value.headers) ? value.headers : [];
  return value.data.map(row => {
    const items = Array.isArray(row) ? row : [];
    return Object.fromEntries(headers.map((header, index) => [header, items[index]]));
  });
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asDateString(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function tokenize(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) || [])]
    .filter(token => (token.length > 2 || /^\d{2,}$/.test(token)) && !STOP_WORDS.has(token))
    .slice(0, 12);
}

export function rankFalkorAnswerRows<T extends GraphAnswerRow>(query: string, rows: T[], limit = 12): T[] {
  const tokens = tokenize(query);
  const scored = rows.map((row, index) => {
    const factText = String(row.factText || '').toLowerCase();
    const episodeText = String(row.episodeContent || '').toLowerCase();
    const sourceText = String(row.sourceLabel || '').toLowerCase();
    const names = `${String(row.sourceName || '')} ${String(row.targetName || '')}`.toLowerCase();
    const directMatches = tokens.filter(token => factText.includes(token) || sourceText.includes(token)).length;
    const score = tokens.reduce((total, token) => total + (factText.includes(token) ? 4 : 0) + (sourceText.includes(token) ? 2 : 0) + (names.includes(token) ? 1 : 0) + (episodeText.includes(token) ? 1 : 0), 0);
    const validAt = row.validAt ? new Date(String(row.validAt)).getTime() : 0;
    return { row, index, score, validAt, directMatches };
  }).filter(item => item.score > 0 && item.directMatches > 0);
  scored.sort((a, b) => b.score - a.score || b.validAt - a.validAt || a.index - b.index);
  return scored.slice(0, Math.max(1, limit)).map(item => item.row);
}

export function composeFalkorAnswer(query: string, rows: GraphAnswerRow[], access?: AccessContext) {
  const distinct = new Map<string, GraphAnswerRow>();
  for (const row of rows) {
    const id = String(row.factId || '');
    if (!id || !row.episodeId || !row.episodeContent) continue;
    if (!canAccessVisibility(normalizeVisibility(parseJson(row.visibility)), access)) continue;
    if (!canAccessVisibility(normalizeVisibility(parseJson(row.episodeVisibility)), access)) continue;
    if (!distinct.has(id)) distinct.set(id, row);
  }
  const facts = [...distinct.values()];
  const citations = facts.map(row => ({
    id: String(row.episodeId),
    resultId: String(row.factId),
    type: 'fact' as const,
    content: String(row.episodeContent),
    quote: String(row.episodeContent),
    confidence: Number(row.confidence || 0),
    sourceEpisodeId: String(row.episodeId),
    relation: String(row.relation || ''),
    validAt: row.validAt ? new Date(String(row.validAt)) : undefined,
    freshness: row.invalidAt ? 'historical' : 'current',
    sourceLabel: row.sourceLabel ? String(row.sourceLabel) : undefined,
    sourceUrl: row.sourceUrl ? String(row.sourceUrl) : undefined,
  }));
  const claims = facts.map(row => ({
    text: String(row.factText || `${row.sourceName} ${row.relation} ${row.targetName}`),
    evidenceIds: [String(row.episodeId)],
  }));
  const path = facts.map(row => ({
    from: String(row.sourceName || 'Unknown source'),
    edge: String(row.relation || 'RELATED_TO'),
    to: String(row.targetName || 'Unknown target'),
  }));
  const missing = facts.length === 0 ? ['No source-backed facts in the FalkorDB graph matched this question.'] : [];
  return {
    query,
    answer: claims.length ? claims.map(claim => claim.text).join(' ') : 'No source-backed facts in FalkorDB match this question.',
    claims,
    citations,
    path,
    inference: [],
    missing,
    confidence: facts.length ? facts.reduce((sum, row) => sum + Number(row.confidence || 0), 0) / facts.length : 0,
    results: facts.map((row, index) => ({
      type: 'fact' as const,
      id: String(row.factId),
      score: Number(row.confidence || 0) * (1 - index * 0.015),
      content: String(row.factText || ''),
      metadata: { relation: String(row.relation || ''), sourceEpisodeId: String(row.episodeId), sourceId: String(row.sourceId || ''), targetId: String(row.targetId || ''), sourceUrl: row.sourceUrl || null },
      relation: String(row.relation || ''),
      validAt: row.validAt ? new Date(String(row.validAt)) : undefined,
      invalidAt: row.invalidAt ? new Date(String(row.invalidAt)) : null,
    })),
    store: 'FalkorDB',
  };
}

export class FalkorDBStore {
  private client: FalkorClient | null = null;
  private graph: FalkorGraph | null = null;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly graphName = 'company_brain',
    private readonly username?: string,
    private readonly password?: string,
  ) {}

  static fromEnvironment(): FalkorDBStore | null {
    const host = process.env.FALKORDB_HOST;
    if (!host) return null;
    return new FalkorDBStore(
      host,
      Number(process.env.FALKORDB_PORT || 6379),
      process.env.FALKORDB_GRAPH || 'company_brain',
      process.env.FALKORDB_USERNAME,
      process.env.FALKORDB_PASSWORD,
    );
  }

  async connect(): Promise<void> {
    if (this.graph) return;
    this.client = await FalkorDB.connect({
      host: this.host,
      port: this.port,
      ...(this.username ? { username: this.username } : {}),
      ...(this.password ? { password: this.password } : {}),
    });
    this.graph = this.client.selectGraph(this.graphName);
    // FalkorDB creates a graph key on the first write. A read-only probe against
    // a new hosted graph fails with "Invalid graph operation on empty key", so
    // create and immediately remove a unique probe node before checking reads.
    await this.graph.query(
      'CREATE (n:TeamTrailStartupProbe {id: $id}) DELETE n RETURN 1 AS ok',
      { params: { id: randomUUID() } },
    );
    await this.graph.roQuery('RETURN 1 AS ok');
  }

  private getGraph(): FalkorGraph {
    if (!this.graph) throw new Error('FalkorDB is not connected. Call connect() first.');
    return this.graph;
  }

  async health(): Promise<boolean> {
    try {
      const result = unpackRows(await this.getGraph().roQuery('RETURN 1 AS ok'));
      return result.length > 0;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.client) await this.client.close();
    this.graph = null;
    this.client = null;
  }

  async syncGroup(groupId: string, entities: Entity[], facts: Fact[], episodes: Episode[]): Promise<{ entities: number; facts: number; episodes: number }> {
    const graph = this.getGraph();
    for (const episode of episodes) await this.upsertEpisode(graph, episode);
    for (const entity of entities) await this.upsertEntity(graph, entity);
    for (const fact of facts) await this.upsertFact(graph, fact);
    return { entities: entities.length, facts: facts.length, episodes: episodes.length };
  }

  private async upsertEntity(graph: FalkorGraph, entity: Record<string, unknown> | Entity): Promise<void> {
    const record = entity as Record<string, unknown>;
    const groupId = String(record.groupId || 'default');
    await graph.query(
      'MERGE (n:Entity {id: $id, groupId: $groupId}) SET n.name = $name, n.entityType = $entityType, n.summary = $summary, n.attributes = $attributes, n.aliases = $aliases, n.visibility = $visibility',
      { params: {
        id: String(record.id), groupId, name: String(record.name || ''), entityType: String(record.entityType || 'Entity'),
        summary: String(record.summary || ''), attributes: JSON.stringify(record.attributes || {}),
        aliases: Array.isArray(record.aliases) ? record.aliases.map(String) : [], visibility: JSON.stringify(record.visibility || {}),
      } },
    );
  }

  private async upsertEpisode(graph: FalkorGraph, episode: Record<string, unknown> | Episode): Promise<void> {
    const record = episode as Record<string, unknown>;
    const metadata = parseJson(record.metadata);
    await graph.query(
      'MERGE (e:Episode {id: $id, groupId: $groupId}) SET e.sourceType = $sourceType, e.sourceId = $sourceId, e.sourceLabel = $sourceLabel, e.sourceUrl = $sourceUrl, e.content = $content, e.metadata = $metadata, e.visibility = $visibility, e.validAt = $validAt',
      { params: {
        id: String(record.id), groupId: String(record.groupId || 'default'), sourceType: String(record.sourceType || 'source'),
        sourceId: record.sourceId == null ? '' : String(record.sourceId), sourceLabel: String(record.sourceLabel || metadata.title || record.sourceType || 'Source'),
        sourceUrl: String(record.sourceUrl || metadata.sourceUrl || ''), content: String(record.content || ''),
        metadata: JSON.stringify(metadata), visibility: JSON.stringify(record.visibility || {}), validAt: asDateString(record.validAt || record.createdAt) || new Date().toISOString(),
      } },
    );
  }

  private async upsertFact(graph: FalkorGraph, fact: Record<string, unknown> | Fact): Promise<void> {
    const record = fact as Record<string, unknown>;
    const groupId = String(record.groupId || 'default');
    const validAt = asDateString(record.validAt || record.validAt) || new Date().toISOString();
    await graph.query(
      'MERGE (f:Fact {id: $id, groupId: $groupId}) SET f.relation = $relation, f.factText = $factText, f.confidence = $confidence, f.validAt = $validAt, f.invalidAt = $invalidAt, f.evidence = $evidence, f.extractor = $extractor, f.visibility = $visibility, f.metadata = $metadata',
      { params: {
        id: String(record.id), groupId, relation: String(record.relation || 'RELATED_TO'), factText: String(record.factText || ''),
        confidence: Number(record.confidence ?? 1), validAt, invalidAt: asDateString(record.invalidAt),
        evidence: JSON.stringify(record.evidence || {}), extractor: String(record.extractor || 'company-brain'),
        visibility: JSON.stringify(record.visibility || {}), metadata: JSON.stringify(record.metadata || {}),
      } },
    );
    await graph.query(
      'MATCH (source:Entity {id: $sourceId, groupId: $groupId}), (f:Fact {id: $factId, groupId: $groupId}), (target:Entity {id: $targetId, groupId: $groupId}) MERGE (source)-[:SUBJECT_OF]->(f) MERGE (f)-[:OBJECT_OF]->(target)',
      { params: { sourceId: String(record.sourceEntityId), targetId: String(record.targetEntityId), factId: String(record.id), groupId } },
    );
    if (record.sourceEpisodeId) {
      await graph.query(
        'MATCH (f:Fact {id: $factId, groupId: $groupId}), (e:Episode {id: $episodeId, groupId: $groupId}) MERGE (f)-[:SUPPORTED_BY]->(e)',
        { params: { factId: String(record.id), episodeId: String(record.sourceEpisodeId), groupId } },
      );
    }
  }

  async snapshot(groupId = 'default', access?: AccessContext): Promise<TeamTrailGraphSnapshot> {
    const graph = this.getGraph();
    const [entityRows, factRows, episodeRows, subjectRows, objectRows, sourceRows] = await Promise.all([
      graph.roQuery('MATCH (n:Entity {groupId: $groupId}) RETURN n.id AS id, n.name AS name, n.entityType AS type, n.summary AS summary, n.visibility AS visibility', { params: { groupId } }),
      graph.roQuery('MATCH (n:Fact {groupId: $groupId}) RETURN n.id AS id, n.relation AS relation, n.factText AS text, n.confidence AS confidence, n.validAt AS validAt, n.invalidAt AS invalidAt, n.visibility AS visibility', { params: { groupId } }),
      graph.roQuery('MATCH (n:Episode {groupId: $groupId}) RETURN n.id AS id, n.sourceLabel AS name, n.sourceType AS type, n.content AS summary, n.sourceUrl AS sourceUrl, n.visibility AS visibility', { params: { groupId } }),
      graph.roQuery('MATCH (source:Entity {groupId: $groupId})-[:SUBJECT_OF]->(fact:Fact {groupId: $groupId}) RETURN source.id AS source, fact.id AS target, fact.id AS factId, fact.relation AS relation, fact.factText AS text, fact.confidence AS confidence', { params: { groupId } }),
      graph.roQuery('MATCH (fact:Fact {groupId: $groupId})-[:OBJECT_OF]->(target:Entity {groupId: $groupId}) RETURN fact.id AS source, target.id AS target, fact.id AS factId, fact.relation AS relation, fact.factText AS text, fact.confidence AS confidence', { params: { groupId } }),
      graph.roQuery('MATCH (fact:Fact {groupId: $groupId})-[:SUPPORTED_BY]->(episode:Episode {groupId: $groupId}) RETURN fact.id AS source, episode.id AS target, fact.id AS factId, "SUPPORTED_BY" AS relation', { params: { groupId } }),
    ]);
    const nodeRows: Array<Record<string, unknown>> = [
      ...unpackRows(entityRows).map(row => ({ ...row, kind: 'entity' })),
      ...unpackRows(factRows).map(row => ({ ...row, name: row.relation || 'Fact', type: 'Fact', summary: row.text || '', kind: 'fact' })),
      ...unpackRows(episodeRows).map(row => ({ ...row, kind: 'episode' })),
    ];
    const nodes: TeamTrailGraphNode[] = nodeRows.filter(row => canAccessVisibility(normalizeVisibility(parseJson(row.visibility)), access)).map(row => ({
      id: String(row.id || ''), name: String(row.name || row.id || ''), type: String(row.type || row.kind || 'Entity'), summary: String(row.summary || ''),
      kind: String(row.kind || 'entity') as TeamTrailGraphNode['kind'],
      ...(row.relation ? { relation: String(row.relation) } : {}),
      ...(row.validAt ? { validAt: String(row.validAt) } : {}),
      ...(row.invalidAt ? { invalidAt: String(row.invalidAt) } : {}),
      ...(row.sourceUrl ? { sourceUrl: String(row.sourceUrl) } : {}),
    }));
    const allowedIds = new Set(nodes.map(node => node.id));
    const links = [
      ...unpackRows(subjectRows), ...unpackRows(objectRows), ...unpackRows(sourceRows),
    ].filter(row => allowedIds.has(String(row.source)) && allowedIds.has(String(row.target))).map(row => ({
      id: String(row.factId || `${String(row.source)}:${String(row.relation)}:${String(row.target)}`),
      source: String(row.source), target: String(row.target), relation: String(row.relation || 'RELATED_TO'),
      ...(row.text ? { text: String(row.text) } : {}), ...(row.confidence !== undefined ? { confidence: Number(row.confidence) } : {}),
    }));
    return { groupId, graph: this.graphName, nodes, links };
  }

  async answer(query: string, options: { groupId?: string; access?: AccessContext; asOf?: Date; limit?: number } = {}) {
    const groupId = options.groupId || 'default';
    const tokens = tokenize(query);
    if (tokens.length === 0) return composeFalkorAnswer(query, [], options.access);
    const seedRows = unpackRows(await this.getGraph().roQuery(
      'MATCH (entity:Entity {groupId: $groupId}) WHERE any(token IN $tokens WHERE toLower(entity.name) CONTAINS token OR toLower(entity.summary) CONTAINS token OR any(alias IN coalesce(entity.aliases, []) WHERE toLower(alias) CONTAINS token)) RETURN entity.id AS id ORDER BY entity.name LIMIT 12',
      { params: { groupId, tokens } },
    ));
    const seedIds = seedRows.map(row => String(row.id || '')).filter(Boolean);
    const asOf = (options.asOf || new Date()).toISOString();
    const includeHistory = /\b(change|changed|prior|previous|old|original|history|replaced|supersed)\w*/i.test(query);
    const rows = unpackRows(await this.getGraph().roQuery(
      'MATCH (source:Entity {groupId: $groupId})-[:SUBJECT_OF]->(fact:Fact {groupId: $groupId})-[:OBJECT_OF]->(target:Entity {groupId: $groupId}) MATCH (fact)-[:SUPPORTED_BY]->(episode:Episode {groupId: $groupId}) WHERE fact.validAt <= $asOf AND (fact.invalidAt IS NULL OR fact.invalidAt > $asOf OR $includeHistory) AND (source.id IN $seedIds OR target.id IN $seedIds OR any(token IN $tokens WHERE toLower(fact.factText) CONTAINS token OR toLower(episode.content) CONTAINS token OR toLower(episode.sourceLabel) CONTAINS token)) RETURN DISTINCT fact.id AS factId, fact.relation AS relation, fact.factText AS factText, fact.confidence AS confidence, fact.validAt AS validAt, fact.invalidAt AS invalidAt, source.id AS sourceId, source.name AS sourceName, target.id AS targetId, target.name AS targetName, episode.id AS episodeId, episode.sourceType AS sourceType, episode.sourceLabel AS sourceLabel, episode.content AS episodeContent, episode.sourceUrl AS sourceUrl, fact.visibility AS visibility, episode.visibility AS episodeVisibility ORDER BY fact.confidence DESC LIMIT $limit',
      { params: { groupId, seedIds, tokens, asOf, includeHistory, limit: Math.min(30, Math.max(1, options.limit || 12)) } },
    ));
    return composeFalkorAnswer(query, rankFalkorAnswerRows(query, rows as GraphAnswerRow[], options.limit || 12), options.access);
  }
}
