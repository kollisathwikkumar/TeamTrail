# TeamTrail: 30-day no-bill deployment

## Recommendation

For a working 30-day demo with **durable PostgreSQL + FalkorDB**, run the existing Docker stack on one Google Compute Engine VM under an eligible Google Cloud Free Trial. This is credit-backed, not an always-free compute plan: Google currently provides $300 for 90 days and says the trial account is not billed; if the credit is exhausted or the trial ends without upgrade, its resources stop. Review the billing page during the month and export data before the trial ends. See [Google Cloud Free Trial](https://docs.cloud.google.com/free/docs/free-cloud-features).

This keeps app, MCP, Postgres, and FalkorDB together on a persistent VM and avoids Render sleep behavior and FalkorDB Cloud Free's lack of TLS/continuous persistence/backups. The compose stack does not publish the API or databases directly. A Cloudflare Tunnel supplies the public HTTPS front door.

## FalkorDB Cloud connection

The application already reads FalkorDB connection settings from the server environment and syncs/query routes use that graph store when `FALKORDB_HOST` is set. For FalkorDB Cloud, copy the instance endpoint host and port from **Instance details → Connectivity** and configure these values as server-side secrets/environment variables (do not put the password in frontend build variables or commit `.env`):

```dotenv
FALKORDB_HOST=<endpoint-host>
FALKORDB_PORT=<endpoint-port>
FALKORDB_GRAPH=company_brain
FALKORDB_USERNAME=falkordb
FALKORDB_PASSWORD=<instance-password>
```

The app opens a direct FalkorDB connection. On first startup it creates and immediately removes a unique probe node so FalkorDB materializes the named graph, then verifies the read path with `RETURN 1 AS ok`. Wait until the cloud instance is **Running** before testing connectivity. FalkorDB Free is suitable only for a disposable demo graph; its plan does not include TLS, continuous persistence, or automated backups. Avoid storing sensitive or sole-copy data on it.

If trial credits are not available, the strict-$0 fallback is Cloudflare Pages/Render Static for the UI, Render Free for the API, Supabase Free for PostgreSQL, and FalkorDB Cloud Free for graph storage. That is a prototype mode only: Render sleeps after 15 minutes, Supabase can pause after a week idle, and FalkorDB Free lists no TLS, continuous persistence, or automated backups. Do not place sensitive or sole-copy data there. See [Render free limits](https://render.com/docs/free), [Supabase Free](https://supabase.com/pricing), and [FalkorDB plans](https://www.falkordb.com/plans/).

## What is already in this repository

- React + Vite UI: `packages/web`; static build served by `web.Dockerfile`.
- TypeScript REST + MCP server: `packages/server`; one public origin routes `/api/*`, `/sources/*`, and `/mcp` to the API.
- PostgreSQL/pgvector: source records, episodes, and vectors.
- FalkorDB: graph facts and relationships; persistent named volume in this deployment.
- Nango connector code exists for Google Drive, Slack, and GitHub, but provider onboarding is deferred. Hosted remote MCP hides its connector setup/sync tools until the consent UI, persistent connection registry, and ACL-aware sync flow are implemented. No Nango credentials are needed for this milestone.

REST now supports Auth0 Authorization Code + PKCE in the browser and validates signed Auth0 API access tokens (issuer, audience, RS256/JWKS) on the server. Production startup requires matching `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, and `AUTH0_AUDIENCE` plus their `VITE_` build counterparts; add the deployment URL to Auth0 Allowed Callback URLs, Logout URLs, and Web Origins. The browser SDK keeps access tokens in memory. `/mcp` accepts user-scoped Auth0 OAuth access tokens with `mcp:read`/`mcp:write`, protected-resource metadata, hash-only persisted grants, and per-request revocation checks; shared-token MCP remains local-development-only. Live Auth0 API/DCR/client setup and hosted agent flow remain unverified. `/api/health` reports `status: ok` only when both PostgreSQL and FalkorDB respond. LLM synthesis and OpenAI embeddings need their configured provider keys. Provider/model usage is separate from hosting credit; Google AI Studio's unpaid API tier is free but its terms permit submitted content to be used to improve Google products, so use only approved demo data there. [Gemini API pricing and data-use table](https://ai.google.dev/gemini-api/docs/pricing).

The initial workspace owner is seeded from `TEAMTRAIL_BOOTSTRAP_SUBJECT`, which must exactly match that user's Auth0 `sub`. Production startup requires this value so the workspace does not start without an administrator. Owners/admins can manage membership through `GET`, `POST`, and `DELETE /api/workspace/members`; the API derives role and retrieval context from the verified Auth0 subject and persisted membership. Membership management is currently scoped to the configured workspace.

## Deploy steps

### Run locally first

Create `.env` as below, then start without a tunnel profile:

```sh
docker compose --env-file deploy/free-30-days/.env \
  -f deploy/free-30-days/compose.yaml up -d --build
```

Open `http://localhost:8080` (or `http://localhost:$TEAMTRAIL_PORT`). Auth0 login requires a configured Auth0 application and the callback/origin URLs described above. The API and graph database remain private to the Compose network. Check `/api/health` using the SDK-backed access token and verify `status: "ok"`, `postgres: true`, and `falkorDb: true`. For external agents, set `TEAMTRAIL_MCP_RESOURCE_URL` and matching Auth0 API audience/permissions, then verify OAuth consent and tool access against the deployed HTTPS origin; the code path is implemented but no live hosted Auth0 flow has been certified.

1. **Create the trial and VM.** If eligible, start Google's Free Trial. Create one Debian 12 VM with 2 vCPU / 8 GB RAM, a 30 GB boot disk, and a region near the team. Keep the VM within the $300 credit, don't upgrade the billing account, and set a billing-budget alert. A VM type/region can affect credit consumption; check the Billing estimate first. No inbound app/database firewall rules are needed because the tunnel uses outbound connections.
2. **Install Docker Engine + Compose plugin and Git** on the VM. Clone this repository after the deployment files are committed/pushed. Run from the repository root.
3. **Create private secrets** (never commit this file):

   ```sh
   cp deploy/free-30-days/.env.example deploy/free-30-days/.env
   python3 - <<'PY'
   from pathlib import Path
   import secrets
   p = Path('deploy/free-30-days/.env')
   lines = p.read_text().splitlines()
   generated = {'POSTGRES_PASSWORD'}
   lines = [f'{line.split("=", 1)[0]}={secrets.token_hex(32)}'
            if line.split('=', 1)[0] in generated else line for line in lines]
   p.write_text('\n'.join(lines) + '\n')
   p.chmod(0o600)
   PY
   ```

4. **Keep provider credentials unset for this milestone.** Drive/Slack/GitHub OAuth onboarding is deferred; no user-facing provider consent flow is wired yet. Keep `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` blank for the no-key demo path; add a model key only if its account has an approved no-cost quota and the data terms fit the demo.
5. **Start the working stack with a temporary public HTTPS URL** (good for a 30-day demo, not a stable production hostname):

   ```sh
   docker compose --env-file deploy/free-30-days/.env \
     -f deploy/free-30-days/compose.yaml --profile quick-tunnel \
     up -d --build
   docker compose --env-file deploy/free-30-days/.env \
     -f deploy/free-30-days/compose.yaml --profile quick-tunnel \
     logs -f quick-tunnel
   ```

   Copy the printed `https://….trycloudflare.com` URL and open it for the UI. Production `/mcp` requires a valid Auth0 token and exact public resource URL; it will not accept the local shared token. Live Auth0 consent/DCR and callback behavior still need setup and verification. The UI and REST API use the same origin. Quick Tunnel URLs change when the tunnel process restarts, have no uptime guarantee, and don't support SSE; restart/reconfigure the agent if it changes. For a stable hostname and full MCP streaming, use a Cloudflare named tunnel and a domain you control: configure its public hostname to `http://caddy:80`, put its tunnel token in `.env`, and start with `--profile named-tunnel` instead. [Cloudflare Quick Tunnel limits](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

6. **Smoke test:**

   ```sh
   docker compose --env-file deploy/free-30-days/.env \
     -f deploy/free-30-days/compose.yaml ps
   # Authenticate in the browser first. Use an Auth0-issued API access token for API smoke checks.
   curl -i https://YOUR-TRY-CLOUDFLARE-HOST/api/health
   curl -i https://YOUR-TRY-CLOUDFLARE-HOST/mcp
   ```

   Sign into the UI and confirm `/api/health` reports `status: "ok"`, `postgres: true`, and `falkorDb: true`. `/api/health/live` is only a process liveness check. Test `/.well-known/oauth-protected-resource/mcp`, Auth0 authorization/consent, MCP initialize, scoped tools, and grant revocation on the deployed origin before enabling juror/client access. Provider-source testing still depends on live Nango setup and sync work.

## 30-day delivery plan

| Days | Build/operate | Exit check |
|---|---|---|
| 1–2 | Start VM, deploy this compose stack, initialize DBs, HTTPS tunnel, configure Auth0 | UI and authenticated `/api/health` report both datastores ready; production MCP remains disabled pending OAuth grants |
| 3–5 | Connect Codex/Claude/other remote MCP client; exercise ingest/search/answer; ingest approved real sample knowledge | Agent can ingest and return source-backed answer; no secret or prompt values in app logs |
| 6–10 | Connect Google Drive, Slack, and GitHub one at a time through Nango; select smallest useful sync models/scopes | Each source syncs; citation links identify source; record Nango connection/compute/transfer usage |
| 11–16 | Build persistent connector registry and reconnect UI; add scheduled sync only after restart/idempotency tests | API restart doesn't lose connector definitions; retry/sync cursor doesn't duplicate records |
| 17–22 | Validate workspace and source ACLs, delete/revoke source test, restore from DB/graph exports | Cross-workspace denial tests pass; restore check reconstructs demo data |
| 23–27 | Demo rehearsal, load check, trim logs/data, inspect credit use and Nango quota | MCP + UI stable under expected demo load; spend and usage inside budget |
| 28–30 | Export Postgres and FalkorDB data, capture environment/restore notes, tear down VM before trial/credit ends | Export files verified; VM stopped/deleted; billing dashboard confirms no charge |

## Data backup and day-30 exit

For a quick manual export before stopping the VM:

```sh
docker compose --env-file deploy/free-30-days/.env -f deploy/free-30-days/compose.yaml exec -T postgres \
  pg_dump -U brain -d company_brain > teamtrail-postgres.sql
docker compose --env-file deploy/free-30-days/.env -f deploy/free-30-days/compose.yaml exec -T falkordb \
  redis-cli --rdb /tmp/teamtrail.rdb
docker compose --env-file deploy/free-30-days/.env -f deploy/free-30-days/compose.yaml cp \
  falkordb:/tmp/teamtrail.rdb ./teamtrail-falkordb.rdb
```

Verify both files are non-empty and retain them somewhere outside the VM. To stop spending, stop/delete the VM before day 30. Deleting the VM also deletes its attached local persistent data unless you deliberately retain/export disks; keep the SQL/RDB exports first. Never commit `.env`, provider OAuth credentials, Nango keys, or the MCP token.

## Security review (demo deployment)

| Area | Result / operating limit |
|---|---|
| Secrets | Tokens and provider keys are environment-only; `.env` is chmod `0600` in the setup example and must remain untracked. |
| Network | Compose publishes only the tunnel ingress; Postgres, FalkorDB, and API stay on the private Docker network. Use a named Cloudflare Tunnel for stable HTTPS and MCP streaming. |
| Browser auth | Auth0 SDK handles PKCE and keeps tokens in memory; API verifies the Auth0 JWT using its issuer, audience, and signing keys. A live tenant flow still needs to be verified. |
| MCP auth | Shared-token MCP is disabled in production until per-user OAuth grants are enabled; local development may use `TEAMTRAIL_MCP_TOKEN`. |
| Authorization | REST body/query workspace IDs are overridden to the configured `BRAIN_GROUP_ID`; MCP tools are also pinned to that group. This is single-group demo isolation, not a multi-tenant production authorization model. Restrict access to trusted demo participants and use approved/synthetic knowledge. |
| Persistence | Named Docker volumes persist across container restarts, but are not backups. Verify Postgres/FalkorDB exports off-VM before teardown. |
| Dependency/code review | Reviewed the changed auth, REST/MCP, and deployment paths for bearer-token handling, fixed group scoping, parameterized database calls, exposed ports, and secrets in the web bundle. Run the checks below on the current checkout before deployment. |

**Security-sensitive:** YES. **OWASP areas checked:** access control, auth, input/SQL handling, error disclosure, transport, configuration, browser token handling, dependency audit, logging, and deserialization. **Dependency audit:** `npm audit --omit=dev` reports 0 vulnerabilities. **Review status:** demo-ready with the limits above; not production multi-user/OAuth-ready. MCP has per-IP request/auth-failure limits; REST auth failures are not rate-limited, so put the tunnel behind account access controls for a shared demo and rotate tokens after the event.
