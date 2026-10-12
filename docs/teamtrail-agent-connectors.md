# TeamTrail agent and source connections

## What works now

- TeamTrail runs against FalkorDB for its queryable graph and PostgreSQL for source episodes, extracted facts, and memory records.
- The Company Brain MCP server already exposes grounded `answer`/`search`, `ingest`, memory search/list, and connector setup/sync tools to MCP-compatible agents.
- Nango connector code exists for Google Drive, Slack, GitHub, and other providers; it fetches configured Nango sync models and ingests records with source IDs, timestamps, and visibility metadata.
- The REST web application currently has no source-connection screen. Hosted remote MCP intentionally hides connector setup/sync tools while the user-approved, persistent integration flow is being built. Local stdio MCP remains a development surface and is not the intended judge/demo connection flow.
- Connector instances and their configuration currently live in the MCP process's in-memory registry. Sync cursors are persisted, but connector definitions are not. There is no scheduled sync worker or deletion/tombstone reconciler yet, so today's sync is explicit/manual and a restart requires reconnecting the connector.

## Connect Codex

The local Codex CLI registration is named `teamtrail` and points at this checkout's MCP launcher. Verify it with:

```sh
codex mcp list
```

Start a new Codex session (or reload MCP servers) and ask it to call `version`, `list_connectors`, or `answer` against the `teamtrail_workspace` group. The launcher enters the repository root so `.env` is loaded. Put model keys and `NANGO_API_KEY` in the ignored root `.env`; never commit credentials.

## Connect Claude Code or another stdio MCP client

The repository `.mcp.json` configures the same server for Claude Code project scope. Open Claude Code in this repository, inspect/approve `teamtrail` when prompted, then use `/mcp` to verify the connection. For a different checkout, set `TEAMTRAIL_ROOT` to its absolute path. Verify with `claude mcp list` and `claude mcp get teamtrail`.

The launch script is `/Users/chipichipi/Documents/teamtrail/company-brain/scripts/teamtrail-mcp.sh`. Other MCP clients can use that executable as a stdio server. It connects to the existing local Compose services on PostgreSQL port 5433 and FalkorDB port 6380.

## Connect Google Drive, Slack, and GitHub

1. Create a Nango account/project and configure the desired Google Drive, Slack, or GitHub integration and its sync model(s). The Nango integration's data model is required; provider OAuth alone does not define which records TeamTrail should ingest.
2. Add `NANGO_API_KEY` to the local root `.env`, then restart the MCP client/server so it receives the key.
3. In the agent, call `nango_connect` without arguments to inspect configured integrations, then call it with that integration's exact Nango key. Open the returned authorization link and complete provider OAuth.
4. Call `nango_connect` again without arguments to get the new connection's provider key and connection ID.
5. Call `connect` with `type: "nango"`, a unique `id`, `groupId: "teamtrail_workspace"` for this demo workspace, and config fields `providerConfigKey`, `connectionId`, and the configured `model`. The server injects `NANGO_API_KEY` as the connector secret.
6. Call `sync_connector` with that ID. Then ask TeamTrail questions and verify the returned source citations. Repeat sync explicitly to pull updates.

The first ingestion into a real organization should use a dedicated group/workspace and a source account with least privilege. Source ACL/visibility must be mapped and tested before querying private Slack channels or restricted Drive/GitHub repositories. Do not place personal or production data into the workspace `teamtrail_workspace`.

## Required next steps for an automated product

1. Persist connector definitions and encrypted credential references in PostgreSQL; make an admin connection screen with provider, account, scope, workspace, sync model, and status.
2. Add a durable background worker/queue for scheduled and webhook-triggered incremental sync, retries/backoff, idempotency, rate limits, dead-letter visibility, and per-connector health.
3. Implement provider deletions/revocations as tombstones and cascade deletion through episodes, extracted facts, graph edges, embeddings, and caches; support retention and export.
4. Enforce tenant/workspace isolation and source ACL at ingest and retrieval. Carry provider user/group/channel/repository permissions to citations; test allow, deny, inherited, revoked, and cross-tenant cases.
5. Keep an immutable provenance chain: provider/account, source object ID and URL, version/timestamp, ingestion run, extraction version, supporting episode, and graph fact. Preserve temporal valid/invalid intervals and cite the source for every answer.
6. Add review paths for uncertain/entity-merge/conflicting facts, temporal conflict resolution, audit logs, sync preview, freshness indicators, and user correction feedback.
7. Add other high-value sources only as needed: Google Calendar/Docs, Notion, Linear/Jira, GitLab, email, and internal file shares. Prefer the same Nango integration/sync pipeline where the data model and ACL mapping are adequate.

## Current limitation boundary

Codex MCP is registered locally now; the repository includes project-level configuration for Claude Code. Third-party OAuth connections are not yet authorized because each organization needs its own Nango/provider setup and key. Until the worker and persisted registry steps above ship, connector setup and synchronization are agent-driven rather than continuously automated.
