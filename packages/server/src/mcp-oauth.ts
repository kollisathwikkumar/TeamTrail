import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Brain } from '@company-brain/core';

export interface McpOAuthVerifierOptions {
  issuer: string;
  audience: string;
  jwksUrl: URL;
  groupId: string;
  brain: Pick<Brain, 'getWorkspaceMembership' | 'getProviderAccessContext' | 'registerMcpGrant'>;
  now?: () => number;
}

export function createMcpOAuthVerifier(options: McpOAuthVerifierOptions): (token: string) => Promise<AuthInfo> {
  const jwks = createRemoteJWKSet(options.jwksUrl);
  return async (token: string): Promise<AuthInfo> => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: ['RS256'],
        currentDate: new Date((options.now?.() ?? Date.now()) as number),
      }));
    } catch {
      throw new Error('Invalid OAuth access token');
    }
    return buildMcpAuthInfo(token, payload, options);
  };
}

export async function buildMcpAuthInfo(
  token: string,
  claims: JWTPayload,
  options: Pick<McpOAuthVerifierOptions, 'audience' | 'groupId' | 'brain' | 'now'>,
): Promise<AuthInfo> {
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
  if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.exp !== 'number' || claims.exp <= nowSeconds) {
    throw new Error('OAuth token must contain an active subject and expiry');
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : typeof claims.aud === 'string' ? [claims.aud] : [];
  if (!audiences.includes(options.audience)) throw new Error('OAuth token audience is invalid');
  const scopes = [
    ...(typeof claims.scope === 'string' ? claims.scope.split(/\s+/) : []),
    ...(Array.isArray(claims.permissions) ? claims.permissions.filter((value): value is string => typeof value === 'string') : []),
  ].filter(Boolean);
  const uniqueScopes = [...new Set(scopes)];
  if (!uniqueScopes.includes('mcp:read')) throw new Error('OAuth token is missing mcp:read');
  const clientId = typeof claims.azp === 'string' ? claims.azp : typeof claims.client_id === 'string' ? claims.client_id : undefined;
  if (!clientId) throw new Error('OAuth token is missing client identity');
  const membership = await options.brain.getWorkspaceMembership(claims.sub, options.groupId);
  if (!membership) throw new Error('Active workspace membership is required');
  const providerAccess = await options.brain.getProviderAccessContext(claims.sub, options.groupId);
  const grantActive = await options.brain.registerMcpGrant({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    principalId: claims.sub,
    clientId,
    groupId: options.groupId,
    scopes: uniqueScopes,
    expiresAt: new Date(claims.exp * 1000),
  });
  if (!grantActive) throw new Error('OAuth grant has been revoked or expired');
  const extra = {
    principalId: claims.sub,
    groupId: options.groupId,
    role: membership.role,
    accessContext: { ...providerAccess, principalId: claims.sub, roles: [membership.role] },
  };
  return { token, clientId, scopes: uniqueScopes, expiresAt: claims.exp, extra };
}
