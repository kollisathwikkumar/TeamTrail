# TeamTrail frontend reference lock

## Brief

Designing a working Company Brain workspace for engineering newcomers on desktop web, with a responsive tablet/mobile fallback. The primary task is to ask a question, inspect the FalkorDB path, and open the source records that support each answer. The graph must be live backend data, not an illustration.

## Research

Live Refero MCP tools were not available in this session. Research therefore used product references and official docs:

- **Obsidian graph view screenshot supplied by the user** — adapted as a clean light canvas, restrained graph lines, minimal node dots, and a persistent workspace sidebar; product-specific source evidence and graph inspector remain TeamTrail features.
- **Neo4j Browser visual tour** — connection state, graph results, and expandable record details share one workspace. Adapted as a persistent connection indicator and a graph-plus-inspector layout.
- **Linear's “A calmer interface for a product in motion”** — predictable placement and quieter inactive controls. Adapted as consistent page header/actions and compact navigation.
- **SVG interaction model** — the graph renders as accessible SVG with keyboard-selectable nodes and separate zoom controls. This follows the simple, lightweight 2D graph reference without sending a large 3D engine to every viewer.

## Reference lock

- **Primary direction:** follow the user's Obsidian reference: quiet light canvas, persistent file/workspace navigation on the left, tabs across the main work area, and a graph that has room to breathe. TeamTrail adds real answer citations and connector pages without imitating Obsidian branding.
- **Preserve:** honest live database status, no synthetic records or static sample states, searchable source records, useful graph navigation, and a clear MCP/source-connection workspace.
- **Borrow only:** the provided Obsidian screenshot's sidebar, tabs, quiet neutral surfaces, and sparse graph; adapt them into TeamTrail's domain language and functional backend pages.
- **Roles:** white/light-gray canvas, charcoal text, restrained gray graph edges/nodes; muted green only indicates verified connection, red indicates errors. Do not use color to imply an unverified integration is live.
- **Media:** no decorative hero imagery; render the actual FalkorDB graph. Empty workspace is the expected state before ingestion; source pages come from records actually returned by the API.
- **Reject:** a static marketing landing page, placeholder charts, an all-purpose admin console, a decorative globe, and unsupported answer claims.
- **Token commitments:** white main canvas, light neutral side panels, fine gray dividers, dark gray text, compact controls, restrained green only for verified success; no dark graphite default and no ambient gradients/heavy shadows.
- **Accessibility/performance:** browser controls and an equivalent clickable record list remain in the DOM; graph selection is not canvas-only; Canvas failure leaves the backend answer and list usable; demand rendering plus OrbitControls avoids an idle continuous render loop.

## Installed renderer versions

Verified from `packages/web`: React 19 and Vite. Three.js/React Three Fiber were removed from the frontend after the graph reference was clarified as a 2D Obsidian-style canvas; the SVG view reduces the deferred graph bundle from roughly 956 kB to 3.5 kB minified.
