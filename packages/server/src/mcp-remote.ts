import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  tokenFingerprint: string;
  lastUsedAt: number;
  clientName: string;
  authInfo: AuthInfo;
  authorizationFingerprint: string;
}

interface RequestBudget {
  startedAt: number;
  requests: number;
  failures: number;
}

interface McpHttpSessionsOptions {
  token?: string;
  groupId?: string;
  verifyAccessToken?: (token: string) => Promise<AuthInfo>;
  resourceMetadataUrl?: string;
  serverFactory: (groupId: string, authInfo: AuthInfo) => Promise<McpServer>;
  maxSessions?: number;
  idleTimeoutMs?: number;
}

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const REQUEST_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 120;
const MAX_AUTH_FAILURES_PER_WINDOW = 12;

function sendError(res: ServerResponse, status: number, error: string, challenge?: string): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(challenge ? { 'www-authenticate': challenge } : {}) });
  res.end(JSON.stringify({ error }));
}

function secureTokenMatch(header: string | undefined, expected: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const supplied = Buffer.from(match[1], 'utf8');
  const configured = Buffer.from(expected, 'utf8');
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('MCP request body exceeds 2 MiB');
    chunks.push(part);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class McpHttpSessions {
  private readonly sessions = new Map<string, McpSession>();
  private readonly token: string | undefined;
  private readonly verifyAccessToken: McpHttpSessionsOptions['verifyAccessToken'];
  private readonly resourceMetadataUrl?: string;
  private readonly groupId: string;
  private readonly serverFactory: McpHttpSessionsOptions['serverFactory'];
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly requestBudgets = new Map<string, RequestBudget>();

  constructor(options: McpHttpSessionsOptions) {
    this.token = options.token;
    this.verifyAccessToken = options.verifyAccessToken;
    this.resourceMetadataUrl = options.resourceMetadataUrl;
    this.groupId = options.groupId?.trim() || 'default';
    this.serverFactory = options.serverFactory;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname !== '/mcp') return false;

    if (!this.token && !this.verifyAccessToken) {
      sendError(res, 503, 'Remote MCP is disabled; configure TEAMTRAIL_MCP_TOKEN.');
      return true;
    }
    const address = req.socket.remoteAddress || 'unknown';
    const budget = this.requestBudget(address);
    if (budget.requests > MAX_REQUESTS_PER_WINDOW) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((REQUEST_WINDOW_MS - (Date.now() - budget.startedAt)) / 1000))));
      sendError(res, 429, 'Remote MCP request limit reached.');
      return true;
    }
    const bearerToken = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
    let requestAuthInfo: AuthInfo | undefined;
    if (this.verifyAccessToken) {
      try {
        if (!bearerToken) throw new Error('missing bearer');
        requestAuthInfo = await this.verifyAccessToken(bearerToken);
      } catch {
        budget.failures += 1;
        const challenge = `Bearer error="invalid_token"${this.resourceMetadataUrl ? `, resource_metadata="${this.resourceMetadataUrl}"` : ''}`;
        sendError(res, 401, 'Unauthorized', challenge);
        return true;
      }
    } else if (!this.token || !secureTokenMatch(req.headers.authorization, this.token)) {
      budget.failures += 1;
      if (budget.failures > MAX_AUTH_FAILURES_PER_WINDOW) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((REQUEST_WINDOW_MS - (Date.now() - budget.startedAt)) / 1000))));
        sendError(res, 429, 'Remote MCP authentication attempt limit reached.');
        return true;
      }
      sendError(res, 401, 'Unauthorized');
      return true;
    } else {
      requestAuthInfo = this.sharedTokenAuthInfo();
    }
    if (!['GET', 'POST', 'DELETE'].includes(req.method || '')) {
      res.writeHead(405, { Allow: 'GET, POST, DELETE, OPTIONS' });
      res.end();
      return true;
    }

    this.expireIdleSessions();
    const sessionId = req.headers['mcp-session-id'];
    let session = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined;

    if (typeof sessionId === 'string' && !session) {
      sendError(res, 404, 'Unknown MCP session');
      return true;
    }
    if (session) {
      session.lastUsedAt = Date.now();
      if (!bearerToken || session.tokenFingerprint !== fingerprint(bearerToken) || !requestAuthInfo || session.authorizationFingerprint !== this.authorizationFingerprint(requestAuthInfo)) {
        await this.removeSession(String(sessionId));
        sendError(res, 401, 'Unauthorized');
        return true;
      }
      if (req.method === 'POST') {
        const contentType = req.headers['content-type'] || '';
        if (!contentType.toLowerCase().includes('application/json')) {
          sendError(res, 415, 'MCP POST requests require application/json.');
          return true;
        }
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Invalid MCP JSON body';
          sendError(res, message.includes('exceeds 2 MiB') ? 413 : 400, message);
          return true;
        }
        this.logToolCalls(body, session);
        const authenticatedReq = req as IncomingMessage & { auth?: AuthInfo };
        authenticatedReq.auth = requestAuthInfo;
        try {
          await session.transport.handleRequest(authenticatedReq, res, body);
        } catch {
          if (!res.headersSent) sendError(res, 500, 'MCP request failed');
        }
        return true;
      }
    } else {
      if (req.method !== 'POST') {
        sendError(res, 400, 'Initialize an MCP session with POST /mcp first.');
        return true;
      }
      const contentType = req.headers['content-type'] || '';
      if (!contentType.toLowerCase().includes('application/json')) {
        sendError(res, 415, 'MCP POST requests require application/json.');
        return true;
      }
      if (this.sessions.size >= this.maxSessions) {
        sendError(res, 503, 'Remote MCP session capacity reached.');
        return true;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid MCP JSON body';
        sendError(res, message.includes('exceeds 2 MiB') ? 413 : 400, message);
        return true;
      }
      if (!isInitializeRequest(body)) {
        sendError(res, 400, 'A new MCP session must start with initialize.');
        return true;
      }

      const created = await this.createSession(body, requestAuthInfo || this.sharedTokenAuthInfo());
      session = created.session;
      body = created.initializationBody;
      const authenticatedReq = req as IncomingMessage & { auth?: AuthInfo };
      authenticatedReq.auth = session.authInfo;
      try {
        await session.transport.handleRequest(authenticatedReq, res, body);
      } catch (error) {
        this.removeSession(created.sessionId);
        if (!res.headersSent) sendError(res, 500, 'MCP initialization failed');
      }
      return true;
    }

    const authenticatedReq = req as IncomingMessage & { auth?: AuthInfo };
    authenticatedReq.auth = requestAuthInfo;
    try {
      await session.transport.handleRequest(authenticatedReq, res);
    } catch (error) {
      if (!res.headersSent) sendError(res, 500, 'MCP request failed');
    }
    return true;
  }

  async close(): Promise<void> {
    const current = [...this.sessions.keys()];
    for (const sessionId of current) await this.removeSession(sessionId);
  }

  private async createSession(initializationBody: unknown, authInfo: AuthInfo): Promise<{ session: McpSession; sessionId: string; initializationBody: unknown }> {
    let sessionId = '';
    const session: McpSession = {
      server: await this.serverFactory(this.groupId, authInfo),
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sessionId = id;
          this.sessions.set(id, session);
        },
        onsessionclosed: (id) => { void this.removeSession(id); },
      }),
      tokenFingerprint: fingerprint(authInfo.token),
      lastUsedAt: Date.now(),
      clientName: this.clientNameFrom(initializationBody),
      authInfo,
      authorizationFingerprint: this.authorizationFingerprint(authInfo),
    };
    await session.server.connect(session.transport);
    return { session, sessionId, initializationBody };
  }

  private expireIdleSessions(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastUsedAt > this.idleTimeoutMs) void this.removeSession(sessionId);
    }
  }

  private sharedTokenAuthInfo(): AuthInfo {
    // This single-principal credential is development-only; production disables it.
    return { token: this.token || '', clientId: 'teamtrail-shared-token', scopes: ['mcp:read', 'mcp:write'], extra: { groupId: this.groupId, role: 'admin', accessContext: { groups: [this.groupId] } } };
  }

  private authorizationFingerprint(authInfo: AuthInfo): string {
    return createHash('sha256').update(JSON.stringify({ clientId: authInfo.clientId, scopes: [...authInfo.scopes].sort(), extra: authInfo.extra || {} })).digest('hex');
  }

  private clientNameFrom(body: unknown): string {
    if (typeof body !== 'object' || body === null) return 'unknown';
    const params = (body as { params?: unknown }).params;
    if (typeof params !== 'object' || params === null) return 'unknown';
    const clientInfo = (params as { clientInfo?: unknown }).clientInfo;
    if (typeof clientInfo !== 'object' || clientInfo === null) return 'unknown';
    const name = (clientInfo as { name?: unknown }).name;
    return typeof name === 'string' ? name.slice(0, 100).replace(/[\r\n\t]/g, ' ') : 'unknown';
  }

  private logToolCalls(body: unknown, session: McpSession): void {
    const messages = Array.isArray(body) ? body : [body];
    for (const message of messages) {
      if (typeof message !== 'object' || message === null) continue;
      const request = message as { method?: unknown; params?: unknown };
      if (request.method !== 'tools/call' || typeof request.params !== 'object' || request.params === null) continue;
      const tool = (request.params as { name?: unknown }).name;
      if (typeof tool !== 'string') continue;
      console.info(JSON.stringify({
        event: 'teamtrail.mcp.tool_call',
        client: session.clientName,
        tool,
        groupId: this.groupId,
        at: new Date().toISOString(),
      }));
    }
  }

  private requestBudget(address: string): RequestBudget {
    const now = Date.now();
    for (const [key, value] of this.requestBudgets) {
      if (now - value.startedAt >= REQUEST_WINDOW_MS) this.requestBudgets.delete(key);
    }
    if (this.requestBudgets.size > 5000) this.requestBudgets.clear();
    let budget = this.requestBudgets.get(address);
    if (!budget || now - budget.startedAt >= REQUEST_WINDOW_MS) {
      budget = { startedAt: now, requests: 0, failures: 0 };
      this.requestBudgets.set(address, budget);
    }
    budget.requests += 1;
    return budget;
  }

  private async removeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    await Promise.allSettled([session.transport.close(), session.server.close()]);
  }
}
