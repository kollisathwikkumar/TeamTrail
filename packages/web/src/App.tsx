import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import type { GraphEdge, GraphNode } from './GraphViewport';
import { apiTokenHeaders } from './api-auth';

const GraphViewport = lazy(() => import('./GraphViewport'));

const API_TOKEN_KEY = 'teamtrail-api-token';

interface GraphData {
  groupId: string;
  graph: string;
  nodes: GraphNode[];
  links: GraphEdge[];
}

interface Citation {
  id: string;
  resultId: string;
  sourceEpisodeId?: string | null;
  sourceLabel?: string;
  sourceUrl?: string;
  content: string;
  quote?: string;
  relation?: string;
  confidence?: number;
  validAt?: string;
  freshness?: string;
}

interface AnswerResult {
  query: string;
  answer: string;
  citations: Citation[];
  claims: Array<{ text: string; evidenceIds: string[] }>;
  path: Array<{ from: string; edge: string; to: string }>;
  results: Array<{ id: string; metadata: Record<string, unknown> }>;
  missing: string[];
  confidence: number;
  store?: string;
}

interface HealthResult {
  status: string;
  graph: string;
  postgres: boolean;
  falkorDb: boolean;
}

interface WorkspaceStatus {
  workspaceId: string;
  authentication: { mode: string; auth0Configured: boolean };
  integrations: { broker: string; configured: string[]; connected: string[]; note: string };
  mcp: { endpoint: string; transport: string; enabled: boolean; auth: string };
}

type View = 'answer' | 'graph' | 'sources' | 'timeline' | 'connections' | 'mcp';

async function api<T>(path: string, init?: RequestInit, explicitToken?: string | null): Promise<T> {
  const token = explicitToken === undefined ? window.sessionStorage.getItem(API_TOKEN_KEY) : explicitToken;
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...apiTokenHeaders(token), ...init?.headers },
  });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  const paths: Record<string, ReactNode> = {
    trail: <><circle cx="5" cy="12" r="2" /><circle cx="19" cy="5" r="2" /><circle cx="19" cy="19" r="2" /><path d="m7 11 10-5M7 13l10 5" /></>,
    spark: <><path d="m12 3 1.6 6.4L20 11l-6.4 1.6L12 19l-1.6-6.4L4 11l6.4-1.6L12 3Z" /><path d="m19 14 1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Z" /></>,
    graph: <><circle cx="6" cy="7" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="13" cy="18" r="2" /><path d="m8 7 8-1M7 9l5 7m5-8-3 8" /></>,
    file: <><path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10Z" /><path d="M13 3v7h7M8 14h8m-8 4h8" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.3" /><path d="m16 16 4.5 4.5" /></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.6 9a7 7 0 0 1 12-2L20 12M4 12l2.4 5a7 7 0 0 0 12-2" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    external: <><path d="M14 4h6v6m0-6-9 9" /><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></>,
  };
  return <svg {...common}>{paths[name] || paths.trail}</svg>;
}

function StatusDot({ ok }: { ok: boolean }) {
  return <span className={`status-dot${ok ? ' status-dot-live' : ''}`} aria-label={ok ? 'Connected' : 'Disconnected'} />;
}

function ConfidenceBar({ value }: { value: number }) {
  return <span className="confidence-track" title={`${Math.round(value * 100)}% confidence`}><span style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} /></span>;
}

export default function App() {
  const auth0Configured = Boolean(import.meta.env.VITE_AUTH0_DOMAIN && import.meta.env.VITE_AUTH0_CLIENT_ID && import.meta.env.VITE_AUTH0_AUDIENCE);
  return auth0Configured ? <Auth0Workspace /> : <WorkspaceApp />;
}

function Auth0Workspace() {
  const { isAuthenticated, isLoading, user, getAccessTokenSilently, loginWithRedirect, logout } = useAuth0();
  const getToken = useCallback(async () => {
    const token = await getAccessTokenSilently({ authorizationParams: { audience: import.meta.env.VITE_AUTH0_AUDIENCE } });
    if (!token) throw new Error('Auth0 did not return an API access token. Check the configured audience and API permissions.');
    return token;
  }, [getAccessTokenSilently]);
  return <WorkspaceApp auth0={{ isAuthenticated, isLoading, name: user?.name || user?.email || 'Account', getToken, login: () => loginWithRedirect(), logout: () => logout({ logoutParams: { returnTo: window.location.origin } }) }} />;
}

interface Auth0WorkspaceProps {
  isAuthenticated: boolean;
  isLoading: boolean;
  name: string;
  getToken: () => Promise<string>;
  login: () => void;
  logout: () => void;
}

function WorkspaceApp({ auth0 }: { auth0?: Auth0WorkspaceProps }) {
  const [apiToken, setApiToken] = useState<string | null>(() => auth0 ? (auth0.isAuthenticated ? 'auth0-session' : null) : window.sessionStorage.getItem(API_TOKEN_KEY));
  const [authChecked, setAuthChecked] = useState(() => Boolean(auth0) || window.sessionStorage.getItem(API_TOKEN_KEY) !== null);
  const [authError, setAuthError] = useState('');
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [workspaceStatus, setWorkspaceStatus] = useState<WorkspaceStatus | null>(null);
  const [graph, setGraph] = useState<GraphData>({ groupId: '', graph: 'FalkorDB', nodes: [], links: [] });
  const [query, setQuery] = useState('');
  const [answer, setAnswer] = useState<AnswerResult | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [view, setView] = useState<View>('answer');
  const [loading, setLoading] = useState(true);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const [asOf, setAsOf] = useState('');
  const [entitySearch, setEntitySearch] = useState('');

  const request = useCallback(async <T,>(path: string, init?: RequestInit) => {
    const token = auth0 ? await auth0.getToken() : undefined;
    return api<T>(path, init, token);
  }, [auth0?.getToken]);

  useEffect(() => {
    if (!auth0) return;
    setAuthChecked(true);
    setApiToken(auth0.isAuthenticated ? 'auth0-session' : null);
  }, [auth0?.isAuthenticated]);

  const authenticate = useCallback(async (token: string) => {
    const normalized = token.trim();
    if (!normalized) return;
    try {
      await api<HealthResult>('/api/health', undefined, normalized);
      window.sessionStorage.setItem(API_TOKEN_KEY, normalized);
      setAuthError('');
      setLoading(true);
      setApiToken(normalized);
    } catch (cause) {
      setAuthError(cause instanceof Error ? cause.message : 'Could not authenticate with TeamTrail.');
    }
  }, [request]);

  const refreshGraph = useCallback(async () => {
    const next = await request<GraphData>('/api/graph');
    setGraph(next);
    return next;
  }, [request]);

  useEffect(() => {
    if (apiToken === null) {
      if (auth0) return;
      if (authChecked) return;
      let active = true;
      void api<HealthResult>('/api/health', undefined, null).then(() => {
        if (active) setApiToken('');
      }).catch(cause => {
        if (active) setAuthError(cause instanceof Error && cause.message === 'Unauthorized'
          ? 'Enter the workspace API token to continue.'
          : cause instanceof Error ? cause.message : 'The Company Brain API is not available.');
      }).finally(() => { if (active) setAuthChecked(true); });
      return () => { active = false; };
    }
    let active = true;
    async function boot() {
      try {
        const connection = await request<HealthResult>('/api/health');
        if (!active) return;
        setHealth(connection);
        const next = await request<GraphData>('/api/graph');
        if (!active) return;
        setGraph(next);
        const status = await request<WorkspaceStatus>('/api/workspace/status');
        if (!active) return;
        setWorkspaceStatus(status);
      } catch (cause) {
        if (active && cause instanceof Error && cause.message === 'Unauthorized') {
          window.sessionStorage.removeItem(API_TOKEN_KEY);
          setApiToken(null);
          setAuthError('Your TeamTrail token was rejected. Enter the current token to reconnect.');
        } else if (active) setError(cause instanceof Error ? cause.message : 'The Company Brain API is not available.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void boot();
    return () => { active = false; };
  }, [apiToken, authChecked, auth0?.isAuthenticated, request]);

  const ask = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || asking) return;
    setAsking(true);
    setError('');
    try {
      const result = await request<AnswerResult>('/api/answer', {
        method: 'POST',
        body: JSON.stringify({ query: trimmed, limit: 14, ...(asOf ? { asOf: new Date(`${asOf}T23:59:59`).toISOString() } : {}) }),
      });
      setAnswer(result);
      setView('answer');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The answer request failed.');
    } finally {
      setAsking(false);
    }
  }, [query, asking, asOf, request]);

  const highlightedFactIds = useMemo(() => answer?.results.map(result => result.id) || [], [answer]);
  const sourceNodes = useMemo(() => graph.nodes.filter(node => node.kind === 'episode'), [graph.nodes]);
  const visibleNodes = useMemo(() => {
    const needle = entitySearch.trim().toLowerCase();
    if (!needle) return graph.nodes;
    return graph.nodes.filter(node => `${node.name} ${node.type} ${node.summary}`.toLowerCase().includes(needle));
  }, [graph.nodes, entitySearch]);

  const selectView = (next: View) => {
    setView(next);
    setSelected(null);
  };

  if (apiToken === null && auth0?.isLoading) return <main className="access-gate"><div className="access-card"><span className="access-eyebrow">TEAMTRAIL</span><h1>Checking your session…</h1></div></main>;
  if (apiToken === null && auth0) return <main className="access-gate"><div className="access-card"><span className="access-mark">T</span><div className="access-eyebrow">TEAMTRAIL · SECURE LOGIN</div><h1>Sign in to your workspace</h1><p>Continue with your organization account to access TeamTrail.</p><button type="button" onClick={() => auth0.login()}>Continue with Auth0</button></div></main>;
  if (apiToken === null) return authChecked
    ? <ApiAccessGate error={authError} onAuthenticate={authenticate} />
    : <main className="access-gate"><div className="access-card"><span className="access-eyebrow">TEAMTRAIL</span><h1>Connecting securely…</h1></div></main>;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-row"><span className="brand-mark"><Icon name="trail" size={19} /></span><span>teamtrail</span><span className="brand-beta">BRAIN</span></div>
        <div className="workspace-switcher"><div className="workspace-avatar">T</div><div className="workspace-name"><strong>TeamTrail workspace</strong><small>company knowledge</small></div><span className="chevron">⌄</span></div>
        <div className="side-group-label">KNOWLEDGE</div>
        <nav className="primary-nav" aria-label="Main navigation">
          <button className={view === 'answer' ? 'nav-item nav-active' : 'nav-item'} onClick={() => selectView('answer')}><Icon name="spark" /><span>Ask the brain</span><kbd>⌘ K</kbd></button>
          <button className={view === 'graph' ? 'nav-item nav-active' : 'nav-item'} onClick={() => selectView('graph')}><Icon name="graph" /><span>Graph explorer</span></button>
          <button className={view === 'sources' ? 'nav-item nav-active' : 'nav-item'} onClick={() => selectView('sources')}><Icon name="file" /><span>Source library</span><span className="nav-count">{sourceNodes.length || '—'}</span></button>
          <button className={view === 'timeline' ? 'nav-item nav-active' : 'nav-item'} onClick={() => selectView('timeline')}><Icon name="clock" /><span>Decision timeline</span></button>
        </nav>
        <div className="side-group-label secondary-nav-label">CONNECTIONS</div>
        <nav className="primary-nav" aria-label="Connections and agents">
          <button className={view === 'connections' ? 'nav-item nav-active' : 'nav-item'} onClick={() => selectView('connections')}><Icon name="file" /><span>Apps & sources</span><span className="nav-count">{workspaceStatus?.integrations.connected.length ?? '—'}</span></button>
          <button className={view === 'mcp' ? 'nav-item nav-active' : 'nav-item'} onClick={() => selectView('mcp')}><Icon name="trail" /><span>Agent access · MCP</span></button>
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-graph-card">
          <div className="sidebar-graph-head"><span className="mini-graph-mark"><Icon name="graph" size={14} /></span><span>Graph status</span><StatusDot ok={Boolean(health?.falkorDb)} /></div>
          <strong>{health?.falkorDb ? 'FalkorDB connected' : loading ? 'Connecting…' : 'Graph unavailable'}</strong>
          <small>{health?.postgres ? 'PostgreSQL ready' : loading ? 'Checking PostgreSQL…' : 'PostgreSQL unavailable'} · {graph.nodes.length} records</small>
        </div>
        <div className="profile-row"><div className="profile-avatar">{auth0?.name.slice(0, 1) || 'T'}</div><div><strong>{auth0?.name || 'TeamTrail'}</strong><small>{auth0 ? 'Signed in' : 'Workspace token'}</small></div>{auth0 ? <button className="icon-button more-button" onClick={() => auth0.logout()} aria-label="Sign out">↪</button> : <button className="icon-button more-button" aria-label="More workspace actions">···</button>}</div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>TeamTrail</span><span className="crumb-divider">/</span><strong>{viewTitle(view)}</strong></div>
          <div className="topbar-actions"><span className="connection-pill"><StatusDot ok={Boolean(health?.falkorDb && health?.postgres)} />{health?.status === 'ok' ? 'Systems online' : (loading ? 'Connecting' : 'Degraded')}</span><button className="icon-button" onClick={() => void refreshGraph().catch(cause => setError(cause.message))} title="Refresh graph" aria-label="Refresh graph"><Icon name="refresh" size={16} /></button><span className="avatar-small">TT</span></div>
        </header>

        <section className="content-area">
          <div className="page-heading">
            <div><div className="eyebrow">COMPANY BRAIN <span className="eyebrow-line" /></div><h1>{viewTitle(view)}</h1><p>{viewDescription(view)}</p></div>
            {view === 'graph' && <button className="seed-button" onClick={() => void refreshGraph().catch(cause => setError(cause.message))} disabled={!health?.falkorDb}><Icon name="refresh" size={15} /> Refresh graph</button>}
          </div>

          {error && <div className="alert alert-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><Icon name="close" size={16} /></button></div>}

          <div hidden={view !== 'answer' && view !== 'graph'}>
            <div className={`workbench${view === 'graph' ? ' workbench-graph-only' : ''}${view === 'answer' ? ' workbench-answer' : ''}`}>
              <section className="graph-column">
                <div className="graph-toolbar">
                  <div className="graph-title"><span className="graph-title-icon"><Icon name="graph" size={16} /></span><div><strong>Connected company knowledge</strong><small>{graph.graph || 'FalkorDB'} <span>·</span> {graph.nodes.length} nodes <span>·</span> {graph.links.length} edges</small></div></div>
                  <div className="graph-actions"><span className="live-indicator"><i /> LIVE GRAPH</span><button className="icon-button" onClick={() => setSelected(null)} title="Clear selection" aria-label="Clear selection"><Icon name="close" size={16} /></button></div>
                </div>
                <div className="graph-stage" aria-label="Interactive FalkorDB knowledge graph">
                  <Suspense fallback={<div className="graph-empty"><strong>Preparing live graph…</strong><span>The graph renderer loads only when needed.</span></div>}>
                    <GraphViewport nodes={graph.nodes} links={graph.links} selectedId={selected?.id || null} highlightedFactIds={highlightedFactIds} onSelect={setSelected} onClear={() => setSelected(null)} />
                  </Suspense>
                  {graph.nodes.length > 0 && <div className="stage-hint"><span className="hint-dot" /> Select a node to inspect <span className="hint-divider">·</span> Zoom with the controls</div>}
                  <div className="graph-legend"><span><i className="legend-person" /> People</span><span><i className="legend-system" /> Systems</span><span><i className="legend-decision" /> Decisions</span><span><i className="legend-evidence" /> Evidence</span></div>
                </div>
                <div className="graph-subnav">
                  <div className="node-search"><Icon name="search" size={14} /><input value={entitySearch} onChange={event => setEntitySearch(event.target.value)} placeholder="Find a person, service, or decision…" aria-label="Filter graph nodes" /></div>
                  <div className="graph-count"><span>{visibleNodes.length}</span> / {graph.nodes.length} visible</div>
                </div>
                <div className="node-list" aria-label="Accessible graph records">
                  {visibleNodes.slice(0, 10).map(node => <button key={node.id} className={`node-chip${selected?.id === node.id ? ' node-chip-active' : ''}`} onClick={() => setSelected(node)}><span className={`node-chip-dot type-${node.kind === 'episode' ? 'source' : node.kind === 'fact' ? 'fact' : node.type.toLowerCase()}`} />{node.name}<span className="node-chip-type">{node.type}</span></button>)}
                  {visibleNodes.length > 10 && <span className="more-nodes">+{visibleNodes.length - 10} more</span>}
                </div>
              </section>

              <aside className="inspector-column">
                {view !== 'graph' && <>
                  <div className="ask-panel">
                    <div className="panel-kicker"><Icon name="spark" size={14} /><span>ASK THE BRAIN</span><span className="panel-kicker-rule" /></div>
                    <form onSubmit={ask}>
                      <label className="sr-only" htmlFor="question">Ask a question about your company</label>
                      <textarea id="question" value={query} onChange={event => setQuery(event.target.value)} rows={3} placeholder="Ask about ownership, decisions, code, or process…" />
                      <div className="ask-actions"><label className="as-of-label" htmlFor="as-of">AS OF</label><input id="as-of" className="date-input" type="date" value={asOf} onChange={event => setAsOf(event.target.value)} title="Optional as-of date" /><button className="ask-submit" type="submit" disabled={asking || !query.trim() || !health?.falkorDb}>{asking ? 'Tracing…' : 'Trace answer'}<Icon name="arrow" size={15} /></button></div>
                    </form>
                    {graph.nodes.filter(node => node.kind === 'entity').slice(0, 3).length > 0 && <>
                      <div className="suggestion-label">ASK ABOUT THIS WORKSPACE</div>
                      <div className="suggestion-list">
                        {graph.nodes.filter(node => node.kind === 'entity').slice(0, 3).map(node => {
                          const prompt = `What does the workspace know about ${node.name}?`;
                          return <button key={node.id} onClick={() => setQuery(prompt)}>{prompt}<Icon name="arrow" size={13} /></button>;
                        })}
                      </div>
                    </>}
                  </div>

                  <div className="answer-panel">
                    <div className="answer-panel-header"><div><span className="section-index">01</span><strong>Answer trace</strong></div>{answer && <span className="confidence-label"><ConfidenceBar value={answer.confidence} />{Math.round(answer.confidence * 100)}% grounded</span>}</div>
                    {answer ? <>
                      <p className="answer-text">{answer.answer}</p>
                      {answer.path.length > 0 && <div className="path-strip" aria-label="Graph path used"><span className="path-label">PATH</span>{answer.path.slice(0, 3).map((step, index) => <span className="path-step" key={`${step.from}-${step.edge}-${index}`}><span>{step.from}</span><b>{step.edge.replaceAll('_', ' ')}</b><span>{step.to}</span></span>)}</div>}
                      <div className="citation-heading"><span>SOURCE EVIDENCE</span><span>{answer.citations.length} verified spans</span></div>
                      <div className="citation-list">{answer.citations.map(citation => <a className="citation-card" key={citation.id + citation.resultId} href={citation.sourceUrl || '#'} target={citation.sourceUrl ? '_blank' : undefined} rel="noreferrer">
                        <span className={`source-type source-${citationType(citation.sourceLabel, citation.relation)}`}>{citationTypeLabel(citation.sourceLabel, citation.relation)}</span>
                        <strong>{citation.sourceLabel || citation.sourceEpisodeId || 'Source record'}<Icon name="external" size={13} /></strong>
                        <span className="citation-quote">“{citation.quote || citation.content}”</span>
                        {citation.validAt && <span className="citation-date">VALID FROM {new Date(citation.validAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>}
                      </a>)}</div>
                      {answer.missing.map(item => <p className="missing-note" key={item}>{item}</p>)}
                    </> : <div className="answer-empty"><span className="answer-empty-icon"><Icon name="spark" size={18} /></span><strong>Ask a question to reveal the path</strong><span>The backend will traverse FalkorDB, return supporting facts, and link each claim to its source.</span></div>}
                  </div>
                </>}

                {view === 'graph' && <GraphInspector selected={selected} nodes={graph.nodes} links={graph.links} />}
                {selected && <NodeInspector node={selected} onClose={() => setSelected(null)} />}
              </aside>
            </div>
          </div>
          {view === 'sources' && <SourceLibrary sources={sourceNodes} />}
          {view === 'timeline' && <DecisionTimeline graph={graph} onOpenSource={url => window.open(url, '_blank', 'noopener,noreferrer')} />}
          {view === 'connections' && <ConnectionsPage status={workspaceStatus} />}
          {view === 'mcp' && <McpPage status={workspaceStatus} />}
        </section>
      </main>
    </div>
  );
}

function ApiAccessGate({ error, onAuthenticate }: { error: string; onAuthenticate: (token: string) => void }) {
  const [token, setToken] = useState('');
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState(error);
  useEffect(() => setMessage(error), [error]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setChecking(true);
    setMessage('');
    try {
      await onAuthenticate(token);
    } finally {
      setChecking(false);
    }
  };
  return <main className="access-gate">
    <form className="access-card" onSubmit={submit}>
      <span className="access-mark">T</span>
      <div className="access-eyebrow">TEAMTRAIL · PRIVATE WORKSPACE</div>
      <h1>Connect to your company brain</h1>
      <p>Enter the workspace API token provided by your administrator. This tab keeps it only for the current browser session.</p>
      <label htmlFor="workspace-token">Workspace API token</label>
      <input id="workspace-token" type="password" autoComplete="current-password" value={token} onChange={event => setToken(event.target.value)} placeholder="Paste bearer token" required />
      {message && <div className="access-error" role="alert">{message}</div>}
      <button type="submit" disabled={checking || !token.trim()}>{checking ? 'Connecting…' : 'Connect securely'}</button>
    </form>
  </main>;
}

function viewTitle(view: View): string {
  return ({ answer: 'Ask the brain', graph: 'Graph explorer', sources: 'Source library', timeline: 'Decision timeline', connections: 'Apps & sources', mcp: 'Agent access · MCP' })[view];
}

function viewDescription(view: View): string {
  return ({
    answer: 'Ask about company work. Every answer stays connected to its source.',
    graph: 'Inspect the live relationships that power Company Brain answers.',
    sources: 'Browse the source records connected to this workspace.',
    timeline: 'See what changed and which decision replaced the previous one.',
    connections: 'Connect knowledge sources through a configured provider broker. Status reflects verified connection records only.',
    mcp: 'Give compatible AI clients a live endpoint for Company Brain tools.',
  })[view];
}

function ConnectionsPage({ status }: { status: WorkspaceStatus | null }) {
  const apps = [
    { id: 'google-drive', label: 'Google Drive', detail: 'Docs and files', icon: 'G' },
    { id: 'slack', label: 'Slack', detail: 'Messages and channels', icon: '#' },
    { id: 'github', label: 'GitHub', detail: 'Repositories and pull requests', icon: '⌘' },
  ];
  const configured = new Set(status?.integrations.configured || []);
  const connected = new Set(status?.integrations.connected || []);
  return <div className="integration-page">
    <div className="integration-intro"><div><span className="integration-kicker">SOURCE CONNECTIONS</span><h2>Bring your team's existing knowledge</h2><p>Each source remains the system of record. TeamTrail indexes approved content and keeps citations linked to its origin.</p></div><span className="integration-count">{connected.size} connected</span></div>
    <div className="integration-list">{apps.map(app => {
      const isConnected = connected.has(app.id);
      const isConfigured = [...configured].some(key => key.toLowerCase().includes(app.id.split('-')[0]));
      return <article className="integration-card" key={app.id}><span className={`integration-logo logo-${app.id}`}>{app.icon}</span><div className="integration-copy"><strong>{app.label}</strong><span>{app.detail}</span></div><span className={`integration-state${isConnected ? ' integration-state-live' : ''}`}><StatusDot ok={isConnected} />{isConnected ? 'Connected' : isConfigured ? 'Provider configured · not connected' : 'Not connected'}</span><button className="integration-action" disabled={!isConnected} title="Provider consent requires per-user identity and a configured OAuth integration">{isConnected ? 'Manage' : 'Connect'}</button></article>;
    })}</div>
    <div className="integration-notice"><strong>{status?.integrations.broker === 'nango-configured' ? 'Nango is configured' : 'Connection broker not configured'}</strong><p>{status?.integrations.note || 'Checking workspace connection configuration…'} Provider consent and sync are not represented as complete until the provider and per-user connection are verified.</p></div>
  </div>;
}

function McpPage({ status }: { status: WorkspaceStatus | null }) {
  const [copied, setCopied] = useState(false);
  const endpoint = `${window.location.origin}${status?.mcp.endpoint || '/mcp'}`;
  const config = JSON.stringify({ mcpServers: { teamtrail: { url: endpoint } } }, null, 2);
  const copy = async () => { await navigator.clipboard.writeText(config); setCopied(true); window.setTimeout(() => setCopied(false), 1800); };
  return <div className="mcp-page">
    <div className="mcp-status-card"><div className="mcp-status-heading"><span className="mcp-mark"><Icon name="trail" size={20} /></span><div><span className="integration-kicker">MODEL CONTEXT PROTOCOL</span><h2>{status?.mcp.enabled ? 'Remote MCP endpoint available' : 'Remote MCP is not enabled'}</h2></div><span className={`integration-state${status?.mcp.enabled ? ' integration-state-live' : ''}`}><StatusDot ok={Boolean(status?.mcp.enabled)} />{status?.mcp.auth || 'Checking'}</span></div><p>Hosted endpoint for compatible agents using {status?.mcp.transport || 'Streamable HTTP'}. This deployment currently reports its actual authentication mode.</p><code className="endpoint-code">{endpoint}</code></div>
    <div className="mcp-setup-card"><div><span className="integration-kicker">CLIENT CONFIGURATION</span><h3>Connect an MCP client</h3><p>Add this endpoint to the client's remote MCP server list. Client setup may require the workspace token.</p></div><pre>{config}</pre><button className="integration-action" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy config'}</button></div>
    <div className="mcp-note"><strong>Production authorization remains: {status?.mcp.auth || 'unknown'}</strong><span>Hosted user-level OAuth, scoped grants, per-user client records, discovery, consent, and revocation are not active yet.</span></div>
  </div>;
}

function citationType(title?: string, relation?: string): string {
  const text = `${title || ''} ${relation || ''}`.toLowerCase();
  if (text.includes('adr') || text.includes('decision')) return 'decision';
  if (text.includes('runbook')) return 'runbook';
  if (text.includes('code') || text.includes('retry')) return 'code';
  if (text.includes('pr')) return 'change';
  return 'source';
}

function citationTypeLabel(title?: string, relation?: string): string {
  return ({ decision: 'DECISION', runbook: 'RUNBOOK', code: 'CODE', change: 'CHANGE', source: 'SOURCE' }[citationType(title, relation)] || 'SOURCE');
}

function SourceLibrary({ sources }: { sources: GraphNode[] }) {
  if (!sources.length) return <EmptyState title="No source records yet" detail="Connect a source or ingest a document to build this workspace from real knowledge." />;
  return <div className="source-library">{sources.map((source, index) => <a href={source.sourceUrl || '#'} target={source.sourceUrl ? '_blank' : undefined} rel="noreferrer" className="source-library-card" key={source.id}>
    <span className="source-sequence">{String(index + 1).padStart(2, '0')}</span><span className="source-type source-source">{source.type.toUpperCase()}</span><strong>{source.name}<Icon name="external" size={14} /></strong><p>{source.summary}</p><span className="source-open">Open source <Icon name="arrow" size={13} /></span>
  </a>)}</div>;
}

function DecisionTimeline({ graph, onOpenSource }: { graph: GraphData; onOpenSource: (url: string) => void }) {
  const facts = graph.nodes.filter(node => node.kind === 'fact' && node.validAt)
    .sort((left, right) => new Date(right.validAt || 0).getTime() - new Date(left.validAt || 0).getTime());
  const sourceFor = (fact: GraphNode) => {
    const link = graph.links.find(edge => edge.source === fact.id && edge.relation === 'SUPPORTED_BY');
    return graph.nodes.find(node => node.id === link?.target);
  };
  if (facts.length === 0) return <EmptyState title="No temporal records yet" detail="Ingest source-backed knowledge to see facts, changes, and validity periods here." />;
  return <div className="timeline-view"><div className="timeline-intro"><span className="timeline-pulse" /><div><strong>Knowledge history</strong><p>Source-backed facts are ordered by their recorded validity dates.</p></div><span className="timeline-current">CURRENT + HISTORY</span></div>
    <div className="timeline-rail">{facts.map(fact => {
      const source = sourceFor(fact);
      const isCurrent = !fact.invalidAt;
      const date = fact.validAt ? new Date(fact.validAt).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }).toUpperCase() : 'DATE UNKNOWN';
      return <article className={`timeline-item${isCurrent ? ' timeline-item-current' : ' timeline-item-old'}`} key={fact.id}>
        <span className="timeline-date">{date}</span><span className="timeline-mark" /><div className="timeline-card"><div className="timeline-card-top"><span className={`source-type ${isCurrent ? 'source-decision' : 'source-source'}`}>{isCurrent ? 'CURRENT DECISION' : 'PREVIOUS DECISION'}</span><span className={`timeline-state${isCurrent ? '' : ' timeline-state-old'}`}>{isCurrent ? 'ACTIVE' : 'SUPERSEDED'}</span></div><h2>{source?.name || fact.name}</h2><p>{fact.summary}</p><div className="timeline-meta"><span>{fact.relation || 'DECISION'}</span><span>·</span><span>{fact.invalidAt ? `valid until ${new Date(fact.invalidAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : 'current graph state'}</span>{source?.sourceUrl && <button onClick={() => onOpenSource(source.sourceUrl!)}>Open source <Icon name="external" size={13} /></button>}</div></div>
      </article>;
    })}</div>
  </div>;
}

function GraphInspector({ selected, nodes, links }: { selected: GraphNode | null; nodes: GraphNode[]; links: GraphEdge[] }) {
  return <div className="graph-inspector"><div className="section-heading"><span className="section-index">02</span><strong>Graph inspector</strong></div>
    {selected ? <NodeInspector node={selected} onClose={() => {}} compact /> : <div className="inspector-empty"><span className="inspect-rings" /><strong>Choose a record</strong><p>Click any graph node to inspect its summary, evidence, and connected edges.</p></div>}
    <div className="inspector-metrics"><div><span>RECORDS</span><strong>{nodes.length}</strong></div><div><span>RELATIONSHIPS</span><strong>{links.length}</strong></div></div>
    <div className="inspector-subhead">RELATIONSHIP TYPES</div>
    <div className="relation-list">{[...new Set(links.map(link => link.relation))].slice(0, 7).map(relation => <div key={relation}><span className="relation-line" /><span>{relation.replaceAll('_', ' ')}</span><span>{links.filter(link => link.relation === relation).length}</span></div>)}</div>
  </div>;
}

function NodeInspector({ node, onClose, compact = false }: { node: GraphNode; onClose: () => void; compact?: boolean }) {
  return <div className={`node-inspector${compact ? ' node-inspector-compact' : ''}`}>
    <div className="node-inspector-head"><span className="inspector-label">SELECTED RECORD</span>{!compact && <button className="icon-button" onClick={onClose} aria-label="Close node details"><Icon name="close" size={15} /></button>}</div>
    <span className="node-inspector-kind">{(node.kind || 'entity').toUpperCase()} · {node.type.toUpperCase()}</span><h3>{node.name}</h3><p>{node.summary || 'No additional description is attached.'}</p>
    {node.sourceUrl && <a className="node-source-link" href={node.sourceUrl} target="_blank" rel="noreferrer">Open linked source <Icon name="external" size={13} /></a>}
  </div>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="generic-empty"><span className="answer-empty-icon"><Icon name="file" size={18} /></span><strong>{title}</strong><span>{detail}</span></div>;
}
