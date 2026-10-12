# TeamTrail × Company Brain × FalkorDB

## Source baseline

`company-brain/` is a shallow clone of `https://github.com/caelstewart/company-brain.git`, upstream commit `e7ca041c903bdf560c29d3df58ba1e63d17175bc`. Company Brain at that revision uses PostgreSQL/pgvector for episodes, entities, temporal facts, memory, and its original REST/MCP interfaces. It has no end-user frontend.

## Adaptation

- Keep Company Brain's ingestion, extraction, temporal-fact, visibility, and memory engine.
- Add `FalkorDBStore` in `packages/core/src/graph/falkordb-store.ts` with `Entity`, `Fact`, and `Episode` nodes and `SUBJECT_OF`, `OBJECT_OF`, and `SUPPORTED_BY` edges. Workspace IDs are query constraints; temporal facts keep valid/invalid times; source episodes preserve provenance.
- After Company Brain ingestion, synchronize that workspace into FalkorDB. In FalkorDB mode, `Brain.answer()` retrieves source-backed paths from FalkorDB and does not fall back to Postgres answer search. `GET /api/graph` also reads FalkorDB directly. PostgreSQL remains the current extraction/episode/memory transaction store, not the answer graph.
- Add live `/api/answer`, `/api/graph`, `/api/health`, and `/api/workspace/status` endpoints. No data seeding route is present.
- Add `packages/web`, a React 19/Vite application. Ask/graph/source/timeline pages use live API data; Apps & Sources and Agent Access/MCP status pages show configured runtime state without inventing connections. The lightweight SVG graph visualizes returned backend records.
- The focused REST demo removes runtime setup and routes for Nango/custom connectors, webhooks, user skills, skill promotion, and generalized eval/telemetry controls. Their upstream source modules remain in the clone; the demo runtime no longer starts or exposes them.

## Local ports

- UI + REST API: `http://localhost:3334`
- FalkorDB Browser: `http://localhost:3002`
- FalkorDB direct connection: `localhost:6380`
- PostgreSQL test connection: `localhost:5433` (container-internal API link remains `postgres:5432`)

## Important run and event notes

The workspace now starts empty. `POST /api/ingest` is Company Brain's extraction workflow; durable extraction may require model/embedding configuration. The UI does not pretend an empty extraction succeeded.

The Graph Hacks rules permit reuse of general libraries/infrastructure, but specify that the submission and its main FalkorDB implementation must be new work completed during the event. This clone-and-integration work began on 12 Oct 2026, before the published 15 Oct 00:01 IST kickoff, so this local spike is for preparation and must be rechecked/rebuilt as eligible event work if those rules remain unchanged.
