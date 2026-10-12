# TeamTrail remote MCP: Motion benchmark and current implementation

## What the Motion reference demonstrates

The user-provided screenshots and Motion's public MCP guide show a polished remote MCP flow:

- One stable remote endpoint: `https://mcp.motion.so/mcp`.
- OAuth-protected-resource and authorization-server discovery; a compliant agent can start OAuth when the endpoint challenges an unauthenticated request.
- Dynamic client registration plus OAuth 2.1 Authorization Code + PKCE for browser-capable agents, and Device Authorization Grant for agents without a callback browser.
- Optional service-account registration with `client_credentials` for autonomous agents.
- Normal MCP tool calls with structured outputs; Motion adds MCP Apps resources/widgets for live async job progress.

The MCP guide says the product is not depending on a special Claude/Codex plugin or API-key integration: clients speak the standard Streamable HTTP MCP protocol and OAuth handshake. Motion's app-specific “self sign up” path is an additional service-account and billing product, not a requirement of MCP itself.

Research used the Scrapling CLI with `--ai-targeted` on the public Motion landing page, its MCP guide, and its protected-resource metadata endpoint:

- https://motion.so/agent
- https://docs.motion.so/guides/mcp
- https://mcp.motion.so/.well-known/oauth-protected-resource

## What TeamTrail has now

- `POST /mcp` on the existing TeamTrail REST listener uses MCP Streamable HTTP and preserves state per MCP session, so an agent can list tools and call them on the same connection.
- In production, `/mcp` verifies an Auth0-issued JWT as an OAuth resource server (issuer, exact resource audience, RS256/JWKS, expiry, `mcp:read`, client identity, and active workspace membership). Local development may still use `TEAMTRAIL_MCP_TOKEN`; production disables that shared-token fallback.
- `GET /.well-known/oauth-protected-resource/mcp` publishes RFC 9728 resource metadata with the Auth0 authorization-server issuer and `mcp:read` / `mcp:write` scopes. A missing or invalid bearer response includes a `WWW-Authenticate` resource-metadata challenge.
- First successful token use records a PostgreSQL grant containing only the access-token SHA-256 hash, subject, client ID, workspace, scopes, and expiry. Authenticated users can list their grants and revoke a grant using `GET /api/mcp/grants` and `DELETE /api/mcp/grants/:grantId`. The resource server checks revocation on every request; revoked sessions are closed.
- OAuth tool access derives the subject, workspace role, provider identity mappings, and source ACL context from server-verified claims and stored membership. `mcp:read` exposes read tools; `ingest` additionally requires `mcp:write` and a non-viewer role. The shared development token is a local single-operator credential only.
- Each remote MCP session is restricted to `BRAIN_GROUP_ID` and a focused tool allowlist: `version`, `ingest`, `search`, `answer`, memory search/list, entity lookup, Nango connect, connector list/connect, and connector sync. The agent cannot select another group or invoke graph/cleanup/webhook/admin operations through the remote endpoint.
- `answer`, `search`, and `ingest` now return both normal readable MCP content and `structuredContent`, which makes agent integrations easier to consume consistently.
- Sessions expire after 30 minutes of inactivity and are capped at 100 per process. The endpoint caps bodies at 2 MiB, limits each IP to 120 requests/minute and 12 failed bearer attempts/minute, and emits a metadata-only server log for each MCP tool call (client name, tool name, group, timestamp). It never logs tool arguments/results or conversation transcripts; durable agent contributions enter the brain only through an explicit `ingest` call.
- `NANGO_API_KEY` is now passed into the Docker server if supplied in `.env`, enabling the existing Google Drive, Slack, GitHub, and other Nango-based connector tools.

## Connect the local endpoint

Generate and keep a private development token in the ignored project `.env` file if one is not already configured, then recreate the server:

```sh
python3 - <<'PY'
from pathlib import Path
import secrets
p = Path('.env')
lines = p.read_text().splitlines() if p.exists() else []
if not any(line.startswith('TEAMTRAIL_MCP_TOKEN=') and line.partition('=')[2] for line in lines):
    lines = [line for line in lines if not line.startswith('TEAMTRAIL_MCP_TOKEN=')]
    lines.append('TEAMTRAIL_MCP_TOKEN=' + secrets.token_hex(32))
    p.write_text('\n'.join(lines) + '\n')
    p.chmod(0o600)
else:
    print('TEAMTRAIL_MCP_TOKEN already configured (value hidden)')
PY
docker compose up -d server
curl -i http://localhost:3334/mcp
```

The curl probe should return `401 Unauthorized` without a bearer token; the endpoint is reachable while protected. Local Codex stdio access remains available through the existing `teamtrail` MCP registration. For an HTTP client, supply the same bearer token as an environment variable/header. For example, with Claude Code launched from a shell that has the token in its environment:

```sh
claude mcp add --transport http teamtrail http://localhost:3334/mcp \
  --header "Authorization: Bearer $TEAMTRAIL_MCP_TOKEN"
```

For a remote agent such as ChatGPT, deploy TeamTrail behind a public HTTPS origin and configure that client for the remote URL. `localhost:3334` only works for clients on the same computer.

## Remaining external OAuth setup and differences from Motion

The TeamTrail resource-server side is implemented and locally tested, but no live Auth0 tenant or deployed HTTPS origin has been validated. Configure an Auth0 API whose Identifier exactly matches `TEAMTRAIL_MCP_RESOURCE_URL` and `AUTH0_AUDIENCE` (for example `https://teamtrail.example.com/mcp`), enable the `mcp:read` and `mcp:write` permissions, allow the intended client grant types, and enable Auth0 Dynamic Client Registration if target agents depend on DCR. Auth0 DCR is tenant-configured and is disabled by default; verify its public registration policy before exposing it. Browser/agent consent, PKCE, refresh, and identity token issuance are performed by the chosen Auth0 client flow, not by TeamTrail's MCP handler. Device flow is not implemented by TeamTrail itself and depends on the selected Auth0/client configuration. TeamTrail records and revokes the resource-side access grant; it does not store refresh tokens or manage Auth0 client registrations.

TeamTrail does not yet offer Motion-style “self sign up,” service-account provisioning, a client-specific Connect Agent screen, or MCP Apps widgets. Provider OAuth onboarding/sync is separate and still depends on configured Nango integrations and per-provider consent.

## Next milestone to complete seamless access

1. Configure and verify the live Auth0 API, audience, permissions, allowed callback/origin values, PKCE clients, and (if needed) DCR policy. Run an end-to-end authorization, tool call, expiry, and revocation test against the public endpoint.
2. Complete a provider permission lifecycle from Nango consent through ACL refresh, permission change/revocation, and data deletion across PostgreSQL/FalkorDB/caches. Current identity links are verified mappings but require administrator provisioning.
3. Add a polished in-app “Connect agent” screen with client-specific setup and grant-revocation controls. Add Device Flow only if an intended client requires and the Auth0 tenant supports it.
4. Add service-account provisioning only after workspace owners can scope, rotate, and revoke agent identities. Add MCP Apps resources later for citations/evidence cards if target hosts support them.

The next implementation should prioritize authenticated tenant mapping and one complete real-source flow (Drive or Slack) over multiple provider integrations or widgets.

## Security review

**Security-sensitive:** yes (remote MCP API and bearer authentication). **Status:** issues fixed for a single-workspace development endpoint; not production multi-tenant ready.

| Area | Result |
|---|---|
| Token handling | Production Auth0 JWT signature, issuer, audience, algorithm, expiry, scope, and client identity are verified. The database stores only token hashes. Local shared bearer uses constant-time comparison and is disabled in production. |
| Workspace isolation | The configured group is fixed server-side; active membership and stored provider identity mappings create access context. Read/write scope and viewer role filter tools. |
| Request/resource limits | 2 MiB JSON body cap, 120 requests/IP/minute, 12 invalid tokens/IP/minute, at most 100 active sessions, 30-minute inactivity expiry. |
| Transport | Local Compose endpoint is plain HTTP; production must terminate HTTPS at a trusted proxy and configure an allowed host/origin. |
| Audit/observability | Logs client/tool/group/time only; no prompt, arguments, source content, or result body. Current logs are process logs, not a durable audit ledger. |
| Dependencies | `npm audit --omit=dev`: 0 vulnerabilities after compatible updates (MCP SDK 1.32.1). Full audit still reports 6 development/test-toolchain advisories across Vitest/Vite/tinypool; resolving them requires a major Vitest upgrade, so they remain a build-tool follow-up. |

The remaining release gates are **live Auth0 OAuth/DCR verification**, **authoritative provider ACL updates/revocation propagation**, and **hosted deployment validation**. Local OAuth tests do not certify a deployed tenant or production identity configuration.
