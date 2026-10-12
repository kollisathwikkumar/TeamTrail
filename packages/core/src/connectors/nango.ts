/**
 * Nango Connector.
 *
 * Pulls synced records from a Nango instance (cloud or self-hosted)
 * and ingests them as episodes. Nango handles OAuth, token refresh,
 * rate limiting, and API pagination for 700+ integrations.
 *
 * This gives Company Brain access to any data source Nango supports
 * (Slack, HubSpot, Notion, Linear, Salesforce, Gmail, etc.) without
 * writing individual connectors for each one.
 *
 * Setup:
 *   1. Set up Nango (cloud at nango.dev or self-hosted)
 *   2. Configure an integration and connect a user/account
 *   3. Point this connector at your Nango instance with the connection details
 *
 * No @nangohq/node dependency needed. Uses Nango's REST API directly.
 */

import { z } from 'zod';
import type { EpisodeInput, SourceAclEntry } from '../types.js';
import type { SyncOptions } from './types.js';
import { AbstractConnector } from './base.js';

export const NangoConfigSchema = z.object({
  /** Nango secret key (from Environment Settings in Nango dashboard) */
  secretKey: z.string().min(1, 'Nango secret key is required'),
  /** Nango host. Defaults to cloud (https://api.nango.dev). Use your URL for self-hosted. */
  host: z.string().optional().default('https://api.nango.dev'),
  /** Integration ID in Nango (e.g. 'hubspot', 'linear', 'google-drive') */
  providerConfigKey: z.string().min(1, 'providerConfigKey is required'),
  /** Connection ID in Nango (identifies the specific account/user connected) */
  connectionId: z.string().min(1, 'connectionId is required'),
  /** Data model to sync (e.g. 'messages', 'contacts', 'pages'). Defined in your Nango integration. */
  model: z.string().min(1, 'model is required'),
  /**
   * Template for building episode content from record fields.
   * Use {{fieldName}} for interpolation. Nested fields: {{address.city}}.
   * If omitted, tries 'content', 'text', 'body', 'description', 'message',
   * then falls back to JSON stringifying the record.
   */
  contentTemplate: z.string().optional(),
  /** Override sourceType on episodes. Defaults to 'nango:{providerConfigKey}'. */
  sourceType: z.string().optional(),
});

export type NangoConfig = z.infer<typeof NangoConfigSchema>;

export class NangoConnector extends AbstractConnector<NangoConfig> {
  readonly id = 'nango';
  readonly name = 'Nango (700+ integrations)';
  readonly configSchema = NangoConfigSchema;

  constructor() {
    // Nango cloud rate limit is generous, but be polite
    super({ rateLimitMs: 50, maxRetries: 3 });
  }

  async setup(config: NangoConfig): Promise<void> {
    // Verify the connection exists and is active
    const res = await this.nangoApi<any>(
      'GET',
      `/connection/${config.connectionId}?provider_config_key=${config.providerConfigKey}`,
    );

    if (res.error_code) {
      throw new Error(`Nango connection failed: ${res.error_code} - ${res.error || 'unknown error'}`);
    }

    this.log('info', `Connected to Nango: ${config.providerConfigKey}/${config.connectionId}`);
  }

  async sync(options?: SyncOptions): Promise<EpisodeInput[]> {
    const limit = options?.limit ?? 500;
    const since = options?.since;
    const episodes: EpisodeInput[] = [];
    let cursor: string | undefined = options?.cursor;

    // Paginate through records
    while (episodes.length < limit) {
      const params = new URLSearchParams({
        model: this.config.model,
        connection_id: this.config.connectionId,
        provider_config_key: this.config.providerConfigKey,
        limit: String(Math.min(limit - episodes.length, 100)),
      });

      if (cursor) params.set('cursor', cursor);
      if (since) params.set('modified_after', since.toISOString());

      const res = await this.nangoApi<any>('GET', `/records?${params}`);

      if (!res.records || res.records.length === 0) break;

      for (const record of res.records) {
        const content = this.recordToContent(record);
        if (!content.trim()) continue;

        const sourceId = this.buildSourceId(record);
        const validAt = this.extractDate(record);

        episodes.push({
          content,
          sourceType: this.config.sourceType || `nango:${this.config.providerConfigKey}`,
          sourceId,
          validAt,
          groupId: this.groupId,
          metadata: {
            nangoModel: this.config.model,
            nangoProvider: this.config.providerConfigKey,
            nangoConnectionId: this.config.connectionId,
            ...this.extractMetadata(record),
          },
          visibility: this.extractVisibility(record),
        });
      }

      // Check for next page
      cursor = res.next_cursor;
      if (!cursor) break;
    }

    this.log('info', `Synced ${episodes.length} records from ${this.config.providerConfigKey}/${this.config.model}`);
    return episodes;
  }

  /**
   * Trigger a sync in Nango (tells Nango to fetch fresh data from the source).
   * Call this before sync() if you want the latest data.
   */
  async triggerNangoSync(syncNames?: string[]): Promise<void> {
    const body: any = {
      provider_config_key: this.config.providerConfigKey,
      connection_id: this.config.connectionId,
    };
    if (syncNames) body.syncs = syncNames;

    await this.nangoApi('POST', '/sync/trigger', body);
    this.log('info', `Triggered Nango sync for ${this.config.providerConfigKey}`);
  }

  // ─── Helpers ──────────────────────────────────────────────

  private async nangoApi<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.config.host}${path}`;
    return this.fetchJson<T>(url, {
      method,
      headers: {
        'Authorization': `Bearer ${this.config.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  private recordToContent(record: any): string {
    // Remove Nango metadata before processing
    const data = { ...record };
    delete data._nango_metadata;

    // Use template if provided
    if (this.config.contentTemplate) {
      return this.config.contentTemplate.replace(
        /\{\{([^}]+)\}\}/g,
        (_, path) => this.getNestedValue(data, path.trim()) ?? '',
      );
    }

    // Try common content fields in priority order
    const contentFields = ['content', 'text', 'body', 'description', 'message', 'summary', 'note'];
    for (const field of contentFields) {
      if (typeof data[field] === 'string' && data[field].trim()) {
        // If there's a title, prepend it
        const title = data.title || data.name || data.subject;
        if (title) return `${title}\n\n${data[field]}`;
        return data[field];
      }
    }

    // If there's just a title/name/subject, use that
    const titleField = data.title || data.name || data.subject;
    if (typeof titleField === 'string' && titleField.trim()) {
      return titleField;
    }

    // Last resort: JSON stringify (skipping very large fields)
    return JSON.stringify(data, null, 2);
  }

  private buildSourceId(record: any): string {
    const meta = record._nango_metadata;
    const id = record.id || record.external_id || meta?.first_seen_at || crypto.randomUUID();
    return `nango://${this.config.providerConfigKey}/${this.config.model}/${id}`;
  }

  private extractDate(record: any): Date {
    const meta = record._nango_metadata;

    // Try record-level date fields
    if (record.created_at) return new Date(record.created_at);
    if (record.date) return new Date(record.date);
    if (record.timestamp) return new Date(record.timestamp);
    if (record.updated_at) return new Date(record.updated_at);

    // Fall back to Nango metadata
    if (meta?.last_modified_at) return new Date(meta.last_modified_at);
    if (meta?.first_seen_at) return new Date(meta.first_seen_at);

    return new Date();
  }

  private extractMetadata(record: any): Record<string, unknown> {
    const meta: Record<string, unknown> = {};
    const skipFields = new Set(['_nango_metadata', 'content', 'text', 'body', 'description', 'message']);

    for (const [key, value] of Object.entries(record)) {
      if (skipFields.has(key)) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        meta[key] = value;
      }
    }

    return meta;
  }

  private extractVisibility(record: any) {
    const acl = record.permissions || record.acl || record.visibility;
    const provider = this.config.providerConfigKey;
    const providerType = provider.toLowerCase().replace(/_/g, '-');
    const aclProvider = ['google-drive', 'drive', 'gdrive'].includes(providerType) ? 'google-drive'
      : ['github', 'github-app'].includes(providerType) ? 'github' : providerType;
    if ((providerType === 'google-drive' || providerType === 'drive' || providerType === 'gdrive') && Array.isArray(acl)) {
      const permissions = acl as Array<Record<string, unknown>>;
      const publicAccess = permissions.some(permission => permission?.type === 'anyone' && permission.deleted !== true);
      const sourceAcl: SourceAclEntry[] = [];
      let aclIncomplete = permissions.length === 0;
      for (const permission of permissions) {
        if (!permission || typeof permission !== 'object' || permission.deleted === true) continue;
        const type = permission.type;
        const id = permission.emailAddress || permission.domain || permission.id;
        if (type === 'anyone') continue;
        if (type === 'user' && typeof id === 'string') sourceAcl.push({ provider: aclProvider, id: `email:${id.toLowerCase()}`, type: 'user', access: 'allow' });
        else if (type === 'group' && typeof id === 'string') sourceAcl.push({ provider: aclProvider, id: `email:${id.toLowerCase()}`, type: 'group', access: 'allow' });
        else if (type === 'domain' && typeof id === 'string') sourceAcl.push({ provider: aclProvider, id: `domain:${id.toLowerCase()}`, type: 'group', access: 'allow' });
        else aclIncomplete = true;
      }
      return {
        sourceSystem: provider,
        inheritedFrom: String(record.id || record.fileId || ''),
        sourceAcl: publicAccess ? [] : sourceAcl,
        aclIncomplete: !publicAccess && aclIncomplete,
      };
    }
    const fields = acl && typeof acl === 'object' && !Array.isArray(acl) ? acl as Record<string, unknown> : {};
    const userValue = fields.users ?? fields.allowed_users ?? fields.allowedUsers ?? record.visible_user_ids ?? record.visibleUserIds;
    const groupValue = fields.groups ?? fields.teams ?? fields.allowed_groups ?? fields.allowedGroups ?? record.visible_group_ids ?? record.visibleGroupIds;
    const deniedUserValue = fields.denied_users ?? fields.deniedUsers;
    const deniedGroupValue = fields.denied_groups ?? fields.deniedGroups;
    const hasAclPayload = acl !== undefined && acl !== null;
    const aclListsAreValid = [
      fields.users, fields.allowed_users, fields.allowedUsers, fields.groups, fields.teams,
      fields.allowed_groups, fields.allowedGroups, fields.denied_users, fields.deniedUsers,
      fields.denied_groups, fields.deniedGroups, record.visible_user_ids, record.visibleUserIds,
      record.visible_group_ids, record.visibleGroupIds,
    ].every(value => this.isInterpretableIdList(value));
    const understood = aclListsAreValid && (!hasAclPayload || (acl && typeof acl === 'object' && !Array.isArray(acl) &&
      ['users', 'allowed_users', 'allowedUsers', 'groups', 'teams', 'allowed_groups', 'allowedGroups', 'denied_users', 'deniedUsers', 'denied_groups', 'deniedGroups']
        .some(key => Object.hasOwn(fields, key))));
    const allowedUsers = this.extractIds(userValue);
    const allowedGroups = this.extractIds(groupValue);
    const deniedUsers = this.extractIds(deniedUserValue);
    const deniedGroups = this.extractIds(deniedGroupValue);

    const sourceAcl: SourceAclEntry[] = [
      ...allowedUsers.map(id => ({ provider, id, type: 'user' as const, access: 'allow' as const })),
      ...allowedGroups.map(id => ({ provider, id, type: 'group' as const, access: 'allow' as const })),
      ...deniedUsers.map(id => ({ provider, id, type: 'user' as const, access: 'deny' as const })),
      ...deniedGroups.map(id => ({ provider, id, type: 'group' as const, access: 'deny' as const })),
    ];
    if (providerType === 'slack') {
      const channelId = record.channel_id || record.channelId || record.channel?.id;
      if (typeof channelId === 'string' && channelId) sourceAcl.push({ provider: aclProvider, id: channelId, type: 'channel', access: 'allow' });
      else if (record.is_private === true || record.isPrivate === true) return { sourceSystem: provider, aclIncomplete: true, sourceAcl };
    }
    if (providerType === 'github' || providerType === 'github-app') {
      const repository = record.repository && typeof record.repository === 'object' ? record.repository as Record<string, unknown> : {};
      const repoName = repository.full_name || record.full_name || record.repository_full_name || record.repositoryName;
      const isPrivate = repository.private === true || record.private === true || record.visibility === 'private' || record.visibility === 'internal';
      const isPublic = repository.private === false || record.private === false || record.visibility === 'public';
      if (isPrivate && typeof repoName === 'string') sourceAcl.push({ provider: aclProvider, id: `repo:${repoName}`, type: 'group', access: 'allow' });
      else if (isPrivate || (!isPublic && (record.repository || record.repository_id))) return { sourceSystem: provider, aclIncomplete: true, sourceAcl };
    }

    return {
      sourceSystem: provider,
      inheritedFrom: record.id || record.external_id,
      allowedPrincipals: allowedUsers.map(id => `${provider}:user:${id}`),
      allowedGroups: allowedGroups.map(id => `${provider}:${id}`),
      deniedPrincipals: deniedUsers.map(id => `${provider}:user:${id}`),
      deniedGroups: deniedGroups.map(id => `${provider}:${id}`),
      aclIncomplete: !understood,
      sourceAcl,
    };
  }

  private extractIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .map(item => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          return record.id || record.user_id || record.group_id || record.team_id;
        }
        return undefined;
      })
      .filter((item): item is string => typeof item === 'string' && item.length > 0);
  }

  private isInterpretableIdList(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (!Array.isArray(value)) return false;
    return value.every(item => typeof item === 'string'
      ? item.length > 0
      : Boolean(item && typeof item === 'object' && ['id', 'user_id', 'group_id', 'team_id']
        .some(key => typeof (item as Record<string, unknown>)[key] === 'string' && (item as Record<string, string>)[key].length > 0)));
  }

  private getNestedValue(obj: any, path: string): string | undefined {
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
      if (current == null) return undefined;
      current = current[part];
    }
    if (current == null) return undefined;
    return String(current);
  }
}
