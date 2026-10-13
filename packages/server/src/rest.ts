/**
 * REST API Server.
 *
 * Lightweight HTTP server using Node's built-in http module.
 * Exposes the Brain API as JSON endpoints with bearer token auth.
 * TeamTrail's REST surface keeps Company Brain's ingestion and temporal-memory
 * engine while routing graph exploration and grounded answers through FalkorDB.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  Brain,
} from '@company-brain/core';
import type { AccessContext, BrainConfig, VisibilityPolicy } from '@company-brain/core';
import { createMcpServer } from './mcp.js';
import { McpHttpSessions } from './mcp-remote.js';
import { createMcpOAuthVerifier } from './mcp-oauth.js';
import { createNangoConnectSession, deleteNangoConnection, providerIntegrationKey, verifyNangoConnection, type TeamTrailProvider } from './nango-connect.js';

export const REST_CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https:; worker-src 'self' blob:; frame-src https://connect.nango.dev; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

interface RestConfig {
  port: number;
  host: string;
  authToken?: string;
  auth0Domain?: string;
  auth0ClientId?: string;
  auth0Audience?: string;
  mcpToken?: string;
  mcpGroupId?: string;
  mcpResourceUrl?: string;
  allowedOrigins?: string[];
}

type RouteHandler = (body: any, params: URLSearchParams, rawBody?: string, headers?: Record<string, string>) => Promise<unknown>;

export async function startRestServer(brainConfig: BrainConfig, restConfig: RestConfig): Promise<void> {
  assertProductionAuth(process.env.NODE_ENV, restConfig.auth0Domain, restConfig.auth0Audience, restConfig.auth0ClientId, process.env.TEAMTRAIL_BOOTSTRAP_SUBJECT, restConfig.mcpResourceUrl);
  const brain = new Brain(brainConfig);
  await brain.init();
  const workspaceGroupId = restConfig.mcpGroupId || brainConfig.defaultGroupId || 'default';
  if (process.env.TEAMTRAIL_BOOTSTRAP_SUBJECT?.trim()) {
    await brain.setWorkspaceMember(process.env.TEAMTRAIL_BOOTSTRAP_SUBJECT.trim(), workspaceGroupId, 'owner', 'bootstrap');
  }
  const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  const restLimits = new RestRequestLimiter();
  const auth0Domain = normalizeAuth0Domain(restConfig.auth0Domain);
  const auth0Jwks = auth0Domain && restConfig.auth0Audience
    ? createRemoteJWKSet(new URL(`https://${auth0Domain}/.well-known/jwks.json`))
    : null;
  const activeMcpToken = productionMcpToken(process.env.NODE_ENV, restConfig.mcpToken);
  const groupId = restConfig.mcpGroupId || brainConfig.defaultGroupId || 'default';
  const mcpVerifier = auth0Domain && restConfig.auth0Audience && restConfig.mcpResourceUrl
    ? createMcpOAuthVerifier({ issuer: `https://${auth0Domain}/`, audience: restConfig.auth0Audience, jwksUrl: new URL(`https://${auth0Domain}/.well-known/jwks.json`), groupId, brain })
    : undefined;
  const mcpSessions = new McpHttpSessions({
    token: activeMcpToken,
    verifyAccessToken: mcpVerifier,
    resourceMetadataUrl: restConfig.mcpResourceUrl ? resourceMetadataUrl(restConfig.mcpResourceUrl) : undefined,
    groupId,
    serverFactory: (requestedGroup, authInfo) => {
      const extra = authInfo.extra || {};
      const context = extra.accessContext && typeof extra.accessContext === 'object' ? extra.accessContext as AccessContext : {};
      return createMcpServer(brain, undefined, requestedGroup, brainConfig, { accessContext: context, scopes: authInfo.scopes, role: String(extra.role || 'viewer') });
    },
  });

  const routes = new Map<string, RouteHandler>();

  // ─── Brain Routes ─────────────────────────────────────────

  routes.set('POST /api/ingest', async (body) => {
    return brain.ingest({
      content: body.content,
      sourceType: body.sourceType,
      sourceId: body.sourceId,
      validAt: body.validAt ? new Date(body.validAt) : undefined,
      metadata: body.metadata,
      visibility: body.visibility as VisibilityPolicy | undefined,
      groupId: body.groupId,
    });
  });

  routes.set('POST /api/search', async (body) => {
    return brain.search({
      query: body.query,
      groupId: body.groupId,
      limit: body.limit,
      offset: body.offset,
      asOf: body.asOf ? new Date(body.asOf) : undefined,
      entityTypes: body.entityTypes,
      relations: body.relations,
      methods: body.methods,
      minConfidence: body.minConfidence,
      access: body.access as AccessContext | undefined,
    });
  });

  routes.set('POST /api/answer', async (body) => {
    return brain.answer({
      query: body.query,
      groupId: body.groupId,
      limit: body.limit,
      offset: body.offset,
      asOf: body.asOf ? new Date(body.asOf) : undefined,
      entityTypes: body.entityTypes,
      relations: body.relations,
      methods: body.methods,
      minConfidence: body.minConfidence,
      access: body.access as AccessContext | undefined,
    });
  });

  routes.set('POST /api/memory/search', async (body) => {
    return brain.searchMemory({
      query: body.query,
      groupId: body.groupId,
      limit: body.limit,
      kinds: body.kinds,
      statuses: body.statuses,
      access: body.access as AccessContext | undefined,
    });
  });

  routes.set('POST /api/memory/list', async (body) => {
    return brain.listMemory({
      groupId: body.groupId,
      limit: body.limit,
      kinds: body.kinds,
      statuses: body.statuses,
      access: body.access as AccessContext | undefined,
    });
  });

  routes.set('POST /api/cleanup/ephemeral', async (body) => {
    return brain.cleanupEphemeralEpisodes({
      groupId: body.groupId,
      olderThanDays: body.olderThanDays,
      limit: body.limit,
    });
  });

  routes.set('GET /api/entities/:id', async (body, params) => {
    const id = params.get('id')!;
    const includeFacts = params.get('includeFacts') !== 'false';
    const includeRelated = params.get('includeRelated') === 'true';
    const includeTimeline = params.get('includeTimeline') === 'true';
    const depth = params.get('depth') ? Number(params.get('depth')) : undefined;

    // Authorization context must come from verified identity, never caller-controlled query parameters.
    const result = await brain.getEntity(id, { includeFacts, includeRelated, includeTimeline, depth, access: body.access as AccessContext | undefined });
    if (!result) throw new HttpError(404, 'Entity not found');
    return result;
  });

  routes.set('GET /api/entities/find/:name', async (body, params) => {
    const name = decodeURIComponent(params.get('name')!);
    const groupId = params.get('groupId') || undefined;

    const entity = await brain.findEntity(name, groupId, body.access as AccessContext | undefined);
    if (!entity) throw new HttpError(404, 'Entity not found');
    return entity;
  });

  routes.set('GET /api/facts/:sourceId', async (body, params) => {
    const sourceId = params.get('sourceId')!;
    const targetId = params.get('targetId') || undefined;
    const relation = params.get('relation') || undefined;
    const includeInvalidated = params.get('includeInvalidated') === 'true';
    const asOf = params.get('asOf') ? new Date(params.get('asOf')!) : undefined;

    return brain.getFacts(sourceId, targetId, { relation, includeInvalidated, asOf, access: body.access as AccessContext | undefined });
  });

  routes.set('POST /api/schema', async (body) => {
    await brain.defineSchema(body);
    return { ok: true };
  });

  routes.set('GET /api/graph', async (body, params) => {
    const groupId = params.get('groupId') || brainConfig.defaultGroupId || 'default';
    return brain.getGraphSnapshot(groupId, body.access as AccessContext | undefined);
  });

  routes.set('GET /api/health', async () => {
    const dependencies = await brain.serviceHealth();
    const ready = dependencies.postgres && dependencies.falkorDb;
    return {
      status: ready ? 'ok' : 'degraded',
      version: '0.1.5',
      graph: dependencies.falkorDb ? 'FalkorDB' : 'unavailable',
      ...dependencies,
    };
  });

  // Minimal liveness probe for the container platform. Dependency readiness stays
  // available on authenticated /api/health to avoid exposing database state.
  routes.set('GET /api/health/live', async () => ({ status: 'alive' }));

  // This endpoint reports deploy-time capabilities only. It never claims that a
  // provider account is connected unless persisted connection state is available.
  routes.set('GET /api/workspace/status', async (_body, _params, _rawBody, headers) => {
    const status = buildWorkspaceStatus(workspaceGroupId, process.env, mcpVerifier ? 'auth0-oauth' : (activeMcpToken ? 'shared-bearer' : 'disabled'));
    const actor = headers?.['x-teamtrail-actor'];
    status.integrations.connected = actor ? (await brain.listProviderConnections(actor, workspaceGroupId)).map(connection => connection.provider) : [];
    return status;
  });

  routes.set('GET /api/integrations', async (_body, _params, _rawBody, headers) => {
    const actor = headers?.['x-teamtrail-actor'];
    if (!actor) throw new HttpError(401, 'Verified identity is required to view provider connections.');
    return { connections: await brain.listProviderConnections(actor, workspaceGroupId) };
  });
  routes.set('POST /api/integrations/:provider/connect-session', async (_body, params, _rawBody, headers) => {
    const actor = headers?.['x-teamtrail-actor'];
    const provider = params.get('provider') || '';
    const key = providerIntegrationKey(provider, process.env);
    if (!actor) throw new HttpError(401, 'Verified identity is required to connect a provider.');
    if (!key) throw new HttpError(404, 'Unsupported provider.');
    const enabledIntegrations = (process.env.NANGO_INTEGRATIONS || '').split(',').map(value => value.trim()).filter(Boolean);
    if (!process.env.NANGO_API_KEY || !enabledIntegrations.includes(key)) throw new HttpError(409, 'This provider is not configured in Nango yet.');
    try {
      return await createNangoConnectSession({ apiKey: process.env.NANGO_API_KEY, provider: provider as TeamTrailProvider, integrationKey: key, principalId: actor, workspaceId: workspaceGroupId });
    } catch (error) {
      const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : 502;
      throw new HttpError(status, error instanceof Error ? error.message : 'Could not start provider authorization.');
    }
  });
  routes.set('POST /api/integrations/:provider/complete', async (body, params, _rawBody, headers) => {
    const actor = headers?.['x-teamtrail-actor'];
    const provider = params.get('provider') || '';
    const key = providerIntegrationKey(provider, process.env);
    const connectionId = body.connectionId;
    if (!actor) throw new HttpError(401, 'Verified identity is required to save a provider connection.');
    if (!key || body.providerConfigKey !== key) throw new HttpError(400, 'Provider configuration did not match the allowed integration.');
    if (typeof connectionId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(connectionId)) throw new HttpError(400, 'A valid connectionId is required.');
    const enabledIntegrations = (process.env.NANGO_INTEGRATIONS || '').split(',').map(value => value.trim()).filter(Boolean);
    if (!process.env.NANGO_API_KEY || !enabledIntegrations.includes(key)) throw new HttpError(409, 'This provider is not configured in Nango yet.');
    const verified = await verifyNangoConnection({ apiKey: process.env.NANGO_API_KEY, connectionId, providerConfigKey: key, principalId: actor, workspaceId: workspaceGroupId });
    if (!verified) throw new HttpError(400, 'Nango did not verify this provider connection.');
    await brain.upsertProviderConnection({ principalId: actor, groupId: workspaceGroupId, provider: provider as TeamTrailProvider, providerConfigKey: key, connectionId });
    return { ok: true, provider, status: 'connected' };
  });
  routes.set('DELETE /api/integrations/:provider', async (_body, params, _rawBody, headers) => {
    const actor = headers?.['x-teamtrail-actor'];
    const provider = params.get('provider') || '';
    if (!actor) throw new HttpError(401, 'Verified identity is required to disconnect a provider.');
    if (!['google-drive', 'slack', 'github'].includes(provider)) throw new HttpError(404, 'Unsupported provider.');
    const connection = await brain.getProviderConnection(actor, workspaceGroupId, provider);
    if (!connection) throw new HttpError(404, 'Provider connection not found.');
    if (!process.env.NANGO_API_KEY || !(await deleteNangoConnection({ apiKey: process.env.NANGO_API_KEY, connectionId: connection.connectionId, providerConfigKey: connection.providerConfigKey }))) {
      throw new HttpError(502, 'Nango could not revoke this provider connection.');
    }
    await brain.revokeProviderConnection(actor, workspaceGroupId, provider);
    const deleted = await brain.deleteSourceData({ groupId: workspaceGroupId, sourceType: `nango:${connection.providerConfigKey}`, connectionId: connection.connectionId });
    await brain.revokeProviderIdentityLink(actor, workspaceGroupId, provider);
    return { ok: true, deleted };
  });

  routes.set('GET /api/mcp/grants', async (_body, _params, _rawBody, headers) => {
    const actor = headers?.['x-teamtrail-actor'];
    if (!actor) throw new HttpError(401, 'Verified identity is required.');
    return brain.listMcpGrants(actor, workspaceGroupId);
  });
  routes.set('DELETE /api/mcp/grants/:grantId', async (_body, params, _rawBody, headers) => {
    const actor = headers?.['x-teamtrail-actor'];
    const grantId = params.get('grantId');
    if (!actor) throw new HttpError(401, 'Verified identity is required.');
    if (!grantId) throw new HttpError(400, 'grantId is required.');
    const revoked = await brain.revokeMcpGrant(grantId, actor, workspaceGroupId, false);
    if (!revoked) throw new HttpError(404, 'MCP grant not found.');
    return { ok: true };
  });

  routes.set('GET /api/workspace/members', async () => brain.listWorkspaceMembers(workspaceGroupId));
  routes.set('POST /api/workspace/members', async (body, _params, _rawBody, headers) => {
    const principalId = body.principalId;
    const role = body.role;
    if (typeof principalId !== 'string' || !principalId.trim() || principalId.length > 255) throw new HttpError(400, 'principalId must be a non-empty Auth0 subject.');
    if (!['owner', 'admin', 'member', 'viewer'].includes(role)) throw new HttpError(400, 'role must be owner, admin, member, or viewer.');
    await brain.setWorkspaceMember(principalId.trim(), workspaceGroupId, role, headers?.['x-teamtrail-actor'] || 'unknown');
    return { ok: true };
  });
  routes.set('DELETE /api/workspace/members', async (body) => {
    if (typeof body.principalId !== 'string' || !body.principalId.trim()) throw new HttpError(400, 'principalId is required.');
    await brain.removeWorkspaceMember(body.principalId.trim(), workspaceGroupId);
    return { ok: true };
  });

  routes.set('GET /api/provider-identities', async (_body, _params, _rawBody, headers) => {
    const actor = headers?.['x-teamtrail-actor'];
    if (!actor) throw new HttpError(401, 'Verified identity is required.');
    return brain.listProviderIdentityLinks(actor, workspaceGroupId);
  });
  routes.set('POST /api/provider-identities', async (body, _params, _rawBody, headers) => {
    const principalId = body.principalId;
    const provider = body.provider;
    const providerUserId = body.providerUserId;
    const providerGroups = body.providerGroups ?? [];
    if (typeof principalId !== 'string' || !principalId.trim()) throw new HttpError(400, 'principalId is required.');
    if (!['slack', 'google-drive', 'github'].includes(provider)) throw new HttpError(400, 'provider must be slack, google-drive, or github.');
    if (typeof providerUserId !== 'string' || !providerUserId.trim()) throw new HttpError(400, 'providerUserId is required.');
    if (!Array.isArray(providerGroups) || !providerGroups.every((value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 255)) {
      throw new HttpError(400, 'providerGroups must be an array of provider-native group IDs.');
    }
    // These mappings are written by workspace admins after validating the connected provider identity.
    await brain.setProviderIdentityLink({ principalId: principalId.trim(), groupId: workspaceGroupId, provider, providerUserId: providerUserId.trim(), providerGroups });
    return { ok: true };
  });
  routes.set('DELETE /api/provider-identities/:provider', async (body, params) => {
    const principalId = body.principalId;
    const provider = params.get('provider');
    if (typeof principalId !== 'string' || !principalId.trim()) throw new HttpError(400, 'principalId is required.');
    if (!['slack', 'google-drive', 'github'].includes(provider || '')) throw new HttpError(400, 'Unsupported provider.');
    await brain.revokeProviderIdentityLink(principalId.trim(), workspaceGroupId, provider!);
    return { ok: true };
  });
  routes.set('DELETE /api/sources/:connectionId', async (body, params) => {
    const connectionId = params.get('connectionId');
    if (!connectionId) throw new HttpError(400, 'connectionId is required.');
    if (typeof body.sourceType !== 'string' || !body.sourceType.trim()) throw new HttpError(400, 'sourceType is required.');
    const deleted = await brain.deleteSourceData({ groupId: workspaceGroupId, sourceType: body.sourceType.trim(), connectionId });
    return { ok: true, deleted };
  });

  // ─── Server ───────────────────────────────────────────────

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Same-origin is the default; split-host frontends must be explicitly allowlisted.
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const forwardedHost = firstHeaderValue(req.headers['x-forwarded-host']);
    const forwardedProto = firstHeaderValue(req.headers['x-forwarded-proto']);
    const requestHost = forwardedHost || req.headers.host || '';
    const requestProtocol = forwardedProto || 'http';
    const corsOrigin = corsOriginForRequest(origin, requestHost, requestProtocol, restConfig.allowedOrigins || []);
    if (origin && !corsOrigin) {
      sendJson(res, 403, { error: 'Origin is not allowed.' });
      return;
    }
    if (corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, MCP-Session-Id, MCP-Protocol-Version, Last-Event-ID');
    res.setHeader('Access-Control-Expose-Headers', 'MCP-Session-Id, MCP-Protocol-Version, WWW-Authenticate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', REST_CONTENT_SECURITY_POLICY);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      let principalId: string | undefined;
      let principalRole: string | undefined;
      if (url.pathname === '/mcp') {
        await mcpSessions.handle(req, res);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/mcp') {
        const metadata = buildMcpProtectedResourceMetadata(restConfig.mcpResourceUrl || undefined, auth0Domain);
        if (!metadata) { sendJson(res, 404, { error: 'MCP OAuth is not configured.' }); return; }
        res.setHeader('Cache-Control', 'public, max-age=300');
        sendJson(res, 200, metadata);
        return;
      }

      // Webhook receive/ingest endpoints skip bearer auth (they use their own signature verification)
      const isWebhook = req.url?.startsWith('/api/webhooks/');

      if (url.pathname.startsWith('/api/') && !isWebhook) {
        const limited = restLimits.consume(req.socket.remoteAddress || 'unknown');
        if (limited) {
          res.setHeader('Retry-After', String(limited.retryAfterSeconds));
          sendJson(res, 429, { error: 'API request limit reached.' });
          return;
        }
      }

      // Auth check for non-webhook routes
      // Static UI assets must load before a browser can present its bearer token;
      // keep the JSON API protected and let /mcp enforce its own MCP credential.
      if (requiresRestBearerAuth(url.pathname) && !isWebhook && auth0Jwks) {
        const auth = req.headers.authorization;
        const token = /^Bearer\s+(.+)$/i.exec(auth || '')?.[1];
        try {
          if (!token) throw new Error('missing bearer');
          const verified = await jwtVerify(token, auth0Jwks, {
            issuer: `https://${auth0Domain}/`,
            audience: restConfig.auth0Audience,
            algorithms: ['RS256'],
          });
          principalId = verified.payload.sub;
          if (!principalId) throw new Error('subject missing');
        } catch {
          restLimits.recordAuthFailure(req.socket.remoteAddress || 'unknown');
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }
        // Identity is verified here; workspace membership authorization is the next stage.
        res.setHeader('Cache-Control', 'no-store');
        (req as IncomingMessage & { teamtrailPrincipalId?: string }).teamtrailPrincipalId = principalId;
      } else if (requiresRestBearerAuth(url.pathname) && !isWebhook && restConfig.authToken) {
        const auth = req.headers.authorization;
        if (!auth || auth !== `Bearer ${restConfig.authToken}`) {
          restLimits.recordAuthFailure(req.socket.remoteAddress || 'unknown');
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }
      } else if (requiresRestBearerAuth(url.pathname) && !isWebhook && process.env.NODE_ENV === 'production') {
        sendJson(res, 503, { error: 'Authentication is not configured.' });
        return;
      }

      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        await sendStatic(res, webRoot, url.pathname);
        return;
      }
      const { rawBody, parsed } = (req.method === 'POST' || req.method === 'DELETE') ? await readBody(req) : { rawBody: '', parsed: {} };

      // Collect headers for webhook signature verification
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
      if (principalId) headers['x-teamtrail-actor'] = principalId;

      // Match route
      const { handler, params } = matchRoute(routes, req.method!, url.pathname, url.searchParams);

      if (!handler) {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }

      const scopedBody = scopeRestRequest(parsed, params, restConfig.mcpGroupId || brainConfig.defaultGroupId || 'default');
      if (principalId) {
        const membership = await brain.getWorkspaceMembership(principalId, workspaceGroupId);
        if (!membership) {
          sendJson(res, 403, { error: 'Active workspace membership is required.', code: 'membership_required' });
          return;
        }
        principalRole = membership.role;
        if (!roleCanAccess(principalRole, req.method || 'GET', url.pathname)) {
          sendJson(res, 403, { error: 'Your workspace role does not allow this action.', code: 'role_forbidden' });
          return;
        }
        // Membership-derived authorization replaces any access assertions from the request body.
        const linkedProviderAccess = await brain.getProviderAccessContext(principalId, workspaceGroupId);
        scopedBody.access = { ...linkedProviderAccess, principalId, groups: [...(linkedProviderAccess.groups || []), workspaceGroupId], roles: [principalRole] } satisfies AccessContext;
      }
      const result = await handler(scopedBody, params, rawBody, headers);
      sendJson(res, 200, result);
    } catch (err: any) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : 'Internal server error';
      if (status === 500) console.error(err);
      sendJson(res, status, { error: message });
    }
  });

  server.listen(restConfig.port, restConfig.host, () => {
    console.log(`Company Brain REST API listening on http://${restConfig.host}:${restConfig.port}`);
    console.log(`TeamTrail:   GET /api/graph, POST /api/answer, MCP POST /mcp`);
    console.log(`Company Brain: POST /api/ingest, POST /api/search, persistent temporal memory`);
  });
}

/** Keep this single-workspace deployment from accepting client-selected groups. */
export function scopeRestRequest(body: Record<string, unknown>, params: URLSearchParams, groupId: string): Record<string, unknown> {
  params.set('groupId', groupId);
  return { ...body, groupId };
}

// ─── Helpers ─────────────────────────────────────────────────

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(',')[0]?.trim() || undefined;
}

export function corsOriginForRequest(
  origin: string | undefined,
  requestHost: string,
  requestProtocol: string,
  allowedOrigins: readonly string[],
): string | null {
  if (!origin) return null;
  let normalizedOrigin: string;
  try {
    normalizedOrigin = new URL(origin).origin;
  } catch {
    return null;
  }
  const explicitlyAllowed = allowedOrigins.some(allowed => {
    try { return new URL(allowed).origin === normalizedOrigin; } catch { return false; }
  });
  if (explicitlyAllowed) return normalizedOrigin;
  try {
    const sameOrigin = new URL(`${requestProtocol}://${requestHost}`).origin === normalizedOrigin;
    return sameOrigin ? normalizedOrigin : null;
  } catch {
    return null;
  }
}

export function assertProductionAuth(environment: string | undefined, auth0Domain: string | undefined, auth0Audience: string | undefined, auth0ClientId?: string, bootstrapSubject?: string, mcpResourceUrl?: string): void {
  const normalizedResource = normalizeMcpResourceUrl(mcpResourceUrl);
  if (environment === 'production' && (!normalizeAuth0Domain(auth0Domain) || !auth0Audience?.trim() || auth0Audience !== normalizedResource || !auth0ClientId?.trim() || !bootstrapSubject?.trim() || !normalizedResource)) {
    throw new Error('Production requires valid Auth0 settings, TEAMTRAIL_BOOTSTRAP_SUBJECT, and an HTTPS TEAMTRAIL_MCP_RESOURCE_URL exactly matching AUTH0_AUDIENCE.');
  }
}

export function normalizeMcpResourceUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.pathname !== '/mcp' || url.search || url.hash || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function resourceMetadataUrl(resourceUrl: string): string {
  const resource = new URL(resourceUrl);
  return `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname}`;
}

export function buildMcpProtectedResourceMetadata(resourceUrl: string | undefined, auth0Domain: string | null) {
  const resource = normalizeMcpResourceUrl(resourceUrl);
  if (!resource || !auth0Domain) return null;
  return {
    resource,
    authorization_servers: [`https://${auth0Domain}/`],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp:read', 'mcp:write'],
  };
}

export function normalizeAuth0Domain(domain: string | undefined): string | null {
  if (!domain?.trim()) return null;
  const normalized = domain.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
  if (!/^[a-z0-9.-]+(?::\d+)?$/i.test(normalized)) return null;
  return normalized;
}

export function productionMcpToken(environment: string | undefined, token: string | undefined): string | undefined {
  // Hosted clients authenticate with OAuth; the shared-token fallback is development-only.
  return environment === 'production' ? undefined : token;
}

export function roleCanAccess(role: string, method: string, pathname: string): boolean {
  if (pathname === '/api/mcp/grants') return method === 'GET' && ['owner', 'admin', 'member', 'viewer'].includes(role);
  if (pathname.startsWith('/api/mcp/grants/')) return method === 'DELETE' && ['owner', 'admin', 'member', 'viewer'].includes(role);
  if (pathname.startsWith('/api/provider-identities')) {
    if (method === 'GET' && pathname === '/api/provider-identities') return ['owner', 'admin', 'member', 'viewer'].includes(role);
    return role === 'owner' || role === 'admin';
  }
  if (pathname.startsWith('/api/sources/')) return method === 'DELETE' && (role === 'owner' || role === 'admin');
  const adminOnly = new Set(['/api/workspace/members', '/api/provider-identities', '/api/schema', '/api/cleanup/ephemeral']);
  if (adminOnly.has(pathname)) return role === 'owner' || role === 'admin';
  const readOnlyPost = new Set(['/api/search', '/api/answer', '/api/memory/search', '/api/memory/list']);
  if (method === 'POST' && readOnlyPost.has(pathname)) return ['owner', 'admin', 'member', 'viewer'].includes(role);
  if (method === 'GET') return ['owner', 'admin', 'member', 'viewer'].includes(role);
  if (method === 'POST' || method === 'DELETE') return role !== 'viewer' && ['owner', 'admin', 'member'].includes(role);
  return false;
}

export function buildWorkspaceStatus(groupId: string, env: NodeJS.ProcessEnv, mcpEnabled: boolean | 'auth0-oauth' | 'shared-bearer' | 'disabled') {
  const auth0Configured = Boolean(env.AUTH0_DOMAIN && env.AUTH0_CLIENT_ID && env.AUTH0_AUDIENCE);
  return {
    workspaceId: groupId,
    authentication: { mode: auth0Configured ? 'auth0-jwt' : 'shared-token', auth0Configured },
    integrations: {
      broker: env.NANGO_API_KEY ? 'nango-configured' : 'not-configured',
      configured: env.NANGO_API_KEY ? (env.NANGO_INTEGRATIONS || '').split(',').map(value => value.trim()).filter(Boolean) : [],
      connected: [] as string[],
      note: env.NANGO_API_KEY ? 'Provider authorization uses Nango Connect. Connected accounts are recorded per Auth0 user; data indexing requires configured sync models.' : 'Set the server-side NANGO_API_KEY and configured NANGO_INTEGRATIONS to enable per-user provider consent.',
    },
    mcp: { endpoint: '/mcp', transport: 'Streamable HTTP', enabled: mcpEnabled !== false && mcpEnabled !== 'disabled', auth: mcpEnabled === true ? 'shared-bearer' : mcpEnabled === false ? 'disabled' : mcpEnabled },
  };
}

export function requiresRestBearerAuth(pathname: string): boolean {
  if (pathname === '/api/health/live') return false;
  return pathname.startsWith('/api/');
}

interface RestLimitBucket { start: number; requests: number; authFailures: number; blockedUntil: number }
export class RestRequestLimiter {
  private readonly buckets = new Map<string, RestLimitBucket>();
  constructor(private readonly now: () => number = Date.now) {}

  consume(key: string): { retryAfterSeconds: number } | null {
    const bucket = this.bucket(key);
    const now = this.now();
    if (bucket.blockedUntil > now) return { retryAfterSeconds: Math.ceil((bucket.blockedUntil - now) / 1000) };
    bucket.requests += 1;
    if (bucket.requests > 120) {
      bucket.blockedUntil = now + 60_000;
      return { retryAfterSeconds: 60 };
    }
    return null;
  }

  recordAuthFailure(key: string): void {
    const bucket = this.bucket(key);
    bucket.authFailures += 1;
    if (bucket.authFailures > 12) bucket.blockedUntil = this.now() + 60_000;
  }

  private bucket(key: string): RestLimitBucket {
    const now = this.now();
    for (const [id, item] of this.buckets) if (now - item.start >= 60_000) this.buckets.delete(id);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= 10_000) this.buckets.delete(this.buckets.keys().next().value!);
      bucket = { start: now, requests: 0, authFailures: 0, blockedUntil: 0 };
      this.buckets.set(key, bucket);
    }
    if (now - bucket.start >= 60_000) {
      bucket.start = now; bucket.requests = 0; bucket.authFailures = 0; bucket.blockedUntil = 0;
    }
    return bucket;
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function sendStatic(res: ServerResponse, root: string, pathname: string): Promise<void> {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^[/\\]+/, '');
  const target = resolve(root, relative);
  if (!target.startsWith(root)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }
  try {
    const body = await readFile(target);
    const type = ({
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
    } as Record<string, string>)[extname(target)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

function readBody(req: IncomingMessage): Promise<{ rawBody: string; parsed: any }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) {
        rejected = true;
        chunks.length = 0;
        reject(new HttpError(413, 'Request body exceeds 2 MiB.'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      const rawBody = Buffer.concat(chunks).toString();
      if (!rawBody) return resolve({ rawBody: '', parsed: {} });
      try {
        resolve({ rawBody, parsed: JSON.parse(rawBody) });
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function matchRoute(
  routes: Map<string, RouteHandler>,
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
): { handler: RouteHandler | null; params: URLSearchParams } {
  // Exact match first
  const exactKey = `${method} ${pathname}`;
  if (routes.has(exactKey)) {
    return { handler: routes.get(exactKey)!, params: searchParams };
  }

  // Pattern match (simple :param support)
  for (const [routeKey, handler] of routes) {
    const [routeMethod, routePattern] = routeKey.split(' ', 2);
    if (routeMethod !== method) continue;

    const routeParts = routePattern.split('/');
    const pathParts = pathname.split('/');

    if (routeParts.length !== pathParts.length) continue;

    const params = new URLSearchParams(searchParams);
    let match = true;

    for (let i = 0; i < routeParts.length; i++) {
      if (routeParts[i].startsWith(':')) {
        params.set(routeParts[i].slice(1), pathParts[i]);
      } else if (routeParts[i] !== pathParts[i]) {
        match = false;
        break;
      }
    }

    if (match) return { handler, params };
  }

  return { handler: null, params: searchParams };
}
