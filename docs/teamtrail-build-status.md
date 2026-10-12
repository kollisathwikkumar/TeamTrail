# TeamTrail build status

## Verified local state (13 October 2026)

- TeamTrail starts with an empty workspace; no demo seeding route, runtime seeder, or shipped source fixture remains.
- Local FalkorDB graph `teamtrail_demo` was cleared; PostgreSQL integration-test workspace rows were cleared. Core unit-test fixtures remain tests only.
- UI pages now include Ask, Graph, Sources, Timeline, Apps & Sources, and Agent Access/MCP. Graph, answer, sources, timeline, and runtime status use backend APIs. The source connection page does not fabricate connected accounts; all providers appear disconnected until persistent provider connection records exist.
- UI uses the user-provided Obsidian graph screenshot as its reference: light canvas, left workspace/navigation, restrained graph marks, and tabular tool pages. The local Obsidian Graph view was opened and inspected. Official Obsidian site research informs data ownership/open-format principles; this is a visual/interaction reference, not a copied app.
- REST supports Auth0 PKCE in the React app and validates API bearer JWTs server-side with issuer/audience/RS256/JWKS checks. A local shared-token fallback remains for development; production MCP uses the OAuth resource-server path when Auth0 API settings and matching resource URL are configured. `GET /api/workspace/status` reports the active auth mode and integrations without leaking credentials.
- Source visibility metadata is preserved across PostgreSQL filtering and FalkorDB result filtering. Nango maps Drive emails/domains, Slack channel IDs, and GitHub private repository names to provider ACL keys; canonical provider identity links, revocation, and scoped connection-data deletion are locally integration-tested. Unknown ACL shapes fail closed. Live provider permission inheritance, automatic change/revocation synchronization, and full connector/citation end-to-end tests remain outstanding.
- Container platforms use unauthenticated `/api/health/live` for minimal process liveness; detailed dependency readiness remains behind `/api/health`.
- REST now has an in-memory per-IP request threshold and auth-failure lockout; durable/distributed rate limiting and audit storage remain release gates.
- Company Brain continues to use PostgreSQL for episodes, temporal facts, and memory; FalkorDB powers graph traversal/visualization. No hosted Neon, FalkorDB, or public deployment was verified.

## Production gates still open

1. **OIDC identity:** Auth0 React login/logout and server JWT verification are implemented. Live Auth0 callback/token tests, refresh behavior, tenant configuration, and claim-to-workspace mapping still need verification. Set `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_AUDIENCE`, and the matching `VITE_AUTH0_*` build values; production mode now rejects missing Auth0 configuration.
2. **Workspace membership:** persistent workspace memberships, a bootstrap owner subject, role-gated REST actions, and server-derived authorization context for graph/search/entity/memory retrieval are implemented for the configured REST workspace. Full multi-workspace selection, user/session management, and database-backed cross-workspace/role tests remain open. MCP checks active membership on each request.
3. **Source ACLs:** Google Drive permission emails/domains, Slack channel IDs, and GitHub private/internal repository identities are mapped to canonical provider ACL keys; Google email identity normalization and provider access context now match. PostgreSQL integration tests cover Drive/Slack/GitHub identity mappings, access, individual revocation, connection data deletion (episode/fact/memory/orphan entity), and idempotency. Unknown ACL shapes continue to fail closed. Authoritative provider ACL ingestion/inheritance, automated permission-change webhooks/refresh, full citation/answer e2e with live providers, and cross-store deletion verification remain open. Admins can revoke provider identity links and delete source connection data with `DELETE /api/sources/:connectionId` plus a `sourceType` body.
4. **MCP OAuth:** TeamTrail now acts as an Auth0 OAuth resource server: RFC 9728 protected-resource metadata and bearer challenge, RS256/JWKS/issuer/audience/expiry verification, active membership enforcement, `mcp:read` / `mcp:write` tool scopes, persisted token-hash grants, self-service grant listing/revocation, and per-request revocation checks. Unit/integration-style HTTP tests cover discovery challenge, initialize/read, and revocation invalidating an active session. Live Auth0 issuer/audience/permissions/DCR/PKCE/consent setup and end-to-end hosted client verification are still open. No Auth0 refresh-token or DCR registry is stored by TeamTrail.
5. **Provider connections:** Nango broker readiness is shown, but connect/reconnect/disconnect consent flows, per-user persistent connection records, status, and sync are not implemented. Provider integration IDs and Nango project configuration are external inputs.
6. **Synchronization:** durable workers, webhooks/signature lifecycle, incremental cursors, retries, idempotency, rate limits, tombstones/deletion propagation, health, and restore handling are outstanding.
7. **Hosted storage:** no selected TeamTrail Neon project or hosted FalkorDB service has been provisioned/validated; migrations, pooling, TLS, backup/PITR and restore evidence are outstanding.
8. **Deployment:** no hosted URL, configured domain/TLS, secrets, runtime health/restart/resource checks, or deployed end-to-end test exists. Render workspace/resource and final repository destination require selection.
9. **Operations:** REST abuse limits, durable audit trail, monitoring/alerts, log retention and redaction checks, secret rotation and incident/recovery runbooks remain outstanding.

This checkout is not production-ready and should not be represented as deployed. The visible UI reports the limitations rather than inventing provider/data state.

## Local check results

- `npm run typecheck` — pass for core, server, and web.
- `npm test` — pass: 196 core tests and 22 server tests; 11 core PostgreSQL integration tests skip under the default `localhost:5432` URL. The four new provider-ACL/revocation/deletion/MCP-grant integration tests were run against local Compose PostgreSQL at `localhost:5433` and passed.
- `DATABASE_URL=postgresql://brain:brain@localhost:5433/company_brain npm run test --workspace @company-brain/core -- --reporter=dot tests/provider-revocation.integration.test.ts` — pass, 4/4 PostgreSQL integration tests.
- `git diff --check` — pass.
- Docker Compose server rebuilt and running locally. `GET /api/health/live` returned HTTP 200 with `{"status":"alive"}`; local `GET /api/health` returned HTTP 200 and reported PostgreSQL and FalkorDB ready. The new `workspace_memberships` table exists; it contains 0 memberships.
- FalkorDB and PostgreSQL service healthchecks are healthy. Previous empty-workspace inspection found 0 graph nodes and 0 episodes; this change did not seed data.
- Production compose healthcheck now probes only liveness instead of depending on a shared token, and production compose no longer requires or advertises a shared MCP token.
- `npm audit --omit=dev` — pass, 0 vulnerabilities.

## Security review for this continuation

- Reviewed Nango provider ACL extraction, canonical Drive email identity mapping, visibility normalization/merge, PostgreSQL visibility predicate, FalkorDB visibility filter, OAuth token verification/grant revocation, REST health routes, and production Compose health check.
- Explicitly unknown provider ACL payloads deny access instead of silently becoming public; internal `bypass` remains the only override. User-supplied REST access context is replaced with Auth0-subject/workspace-membership context on the production JWT path. The local development shared-token path is not a multi-user identity boundary.
- Liveness returns only `{"status":"alive"}`; detailed dependency health remains authenticated in production. The Compose health check no longer depends on a shared REST token.
- No dependency findings from `npm audit --omit=dev`. Remaining critical release work is live-provider permission lifecycle automation, Auth0 tenant/DCR/consent validation, and deployed end-to-end verification—not the local OAuth resource-server and ACL matching path.

### OWASP review (OAuth, ACL, revocation and deletion delta)

| Category | Result |
|---|---|
| A01 Broken access control | Pass locally: verified JWT subject + active workspace membership; role/scope tool filtering; provider ACL matching; owner/admin-only source deletion; users can revoke only their own MCP grants. |
| A02 Cryptographic failures | Pass locally: RS256/JWKS and issuer/audience/expiry checks; database stores SHA-256 token hashes rather than bearer values; HTTPS resource URL required in production. |
| A03 Injection | Pass: SQL uses postgres tagged parameterized queries; provider/connection selectors remain values. |
| A04 Insecure design | Partial: resource server validates externally issued OAuth; Auth0 consent/DCR/client setup and provider webhook lifecycle remain to be verified. |
| A05 Security misconfiguration | Pass in code: production requires exact HTTPS MCP URL/audience match and Auth0 configuration; live tenant and HTTPS deployment are not tested. |
| A06 Vulnerable components | Pass: `npm audit --omit=dev` — 0 vulnerabilities. |
| A07 Authentication failures | Pass locally: invalid tokens are rejected; OAuth grants and memberships are rechecked per request; revoked sessions close. |
| A08 Data integrity/deserialization | Pass locally: bounded JSON body parser; deletion is transactional and limited to selected source episodes and entities referenced only by those deleted facts. |
| A09 Logging/monitoring | Partial: provider identity revocation, MCP grant revocation, and source deletion append durable audit records; centralized monitoring/alerting and audit retention are outstanding. |
| A10 SSRF | N/A to this delta: OAuth issuer/JWKS URLs are derived only from normalized configured Auth0 domain. |

**Review status:** local code/tests pass; live OAuth tenant and hosted deployment remain unverified.

## Hackathon eligibility

The [Graph Hacks guide](https://www.wemakedevs.org/hackathons/falkordb) states the event period as 15–18 October 2026 and requires eligible work to be completed during the event. Recheck the live guide at kickoff and keep event-period implementation and evidence distinct from this preparation work.
