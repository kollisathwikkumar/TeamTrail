export type TeamTrailProvider = 'google-drive' | 'slack' | 'github';

const DEFAULT_INTEGRATIONS: Record<TeamTrailProvider, string> = {
  'google-drive': 'google-drive',
  slack: 'slack',
  github: 'github-getting-started',
};

export function providerIntegrationKey(provider: string, env: NodeJS.ProcessEnv): string | null {
  if (!Object.hasOwn(DEFAULT_INTEGRATIONS, provider)) return null;
  const typedProvider = provider as TeamTrailProvider;
  const override = env[`NANGO_${provider.replace(/-/g, '_').toUpperCase()}_INTEGRATION`]?.trim();
  return override || DEFAULT_INTEGRATIONS[typedProvider];
}

export async function createNangoConnectSession(input: {
  apiKey: string;
  provider: TeamTrailProvider;
  integrationKey: string;
  principalId: string;
  principalEmail?: string;
  displayName?: string;
  workspaceId: string;
  fetchImpl?: typeof fetch;
}) {
  if (!input.apiKey.trim()) throw Object.assign(new Error('Nango is not configured.'), { status: 503 });
  if (!input.principalId.trim() || !input.workspaceId.trim() || !input.integrationKey.trim()) {
    throw Object.assign(new Error('Verified workspace identity is required.'), { status: 400 });
  }
  const fetchImpl = input.fetchImpl || fetch;
  let response: Response;
  try {
    response = await fetchImpl('https://api.nango.dev/connect/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tags: {
          end_user_id: input.principalId,
          ...(input.principalEmail ? { end_user_email: input.principalEmail } : {}),
          ...(input.displayName ? { end_user_display_name: input.displayName } : {}),
          organization_id: input.workspaceId,
        },
        allowed_integrations: [input.integrationKey],
      }),
    });
  } catch {
    throw Object.assign(new Error('Nango could not create a connection session.'), { status: 502 });
  }
  if (!response.ok) throw Object.assign(new Error('Nango could not create a connection session.'), { status: 502 });
  const payload = await response.json() as { data?: { token?: string; expires_at?: string } };
  if (!payload.data?.token) throw Object.assign(new Error('Nango returned an invalid connection session.'), { status: 502 });
  return {
    token: payload.data.token,
    expiresAt: payload.data.expires_at || null,
    provider: input.provider,
    providerConfigKey: input.integrationKey,
  };
}

export async function verifyNangoConnection(input: {
  apiKey: string;
  connectionId: string;
  providerConfigKey: string;
  principalId: string;
  workspaceId: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  if (!input.apiKey.trim() || !/^[a-zA-Z0-9_-]{1,200}$/.test(input.connectionId) || !input.providerConfigKey.trim() || !input.principalId.trim() || !input.workspaceId.trim()) return false;
  try {
    const response = await (input.fetchImpl || fetch)(`https://api.nango.dev/connections/${encodeURIComponent(input.connectionId)}?provider_config_key=${encodeURIComponent(input.providerConfigKey)}`, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
    });
    if (!response.ok) return false;
    const payload = await response.json() as {
      connection_id?: string; provider_config_key?: string;
      end_user?: { id?: string; organization?: { id?: string } };
      tags?: Record<string, string>;
      data?: { connection_id?: string; provider_config_key?: string; end_user?: { id?: string; organization?: { id?: string } }; tags?: Record<string, string> };
    };
    const connectionId = payload.connection_id || payload.data?.connection_id;
    const providerConfigKey = payload.provider_config_key || payload.data?.provider_config_key;
    const endUser = payload.end_user || payload.data?.end_user;
    const tags = payload.tags || payload.data?.tags || {};
    return connectionId === input.connectionId && providerConfigKey === input.providerConfigKey &&
      (tags.end_user_id === input.principalId || endUser?.id === input.principalId) &&
      (tags.organization_id === input.workspaceId || endUser?.organization?.id === input.workspaceId);
  } catch {
    return false;
  }
}

export async function deleteNangoConnection(input: {
  apiKey: string;
  connectionId: string;
  providerConfigKey: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  if (!input.apiKey.trim() || !/^[a-zA-Z0-9_-]{1,200}$/.test(input.connectionId) || !input.providerConfigKey.trim()) return false;
  try {
    const response = await (input.fetchImpl || fetch)(`https://api.nango.dev/connections/${encodeURIComponent(input.connectionId)}?provider_config_key=${encodeURIComponent(input.providerConfigKey)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${input.apiKey}` },
    });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}
