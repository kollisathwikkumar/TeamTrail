import { useMemo, useState } from 'react';

export interface GraphNode {
  id: string;
  name: string;
  type: string;
  kind?: string;
  summary: string;
  sourceUrl?: string;
  relation?: string;
  validAt?: string;
  invalidAt?: string | null;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  text?: string;
  confidence?: number;
}

interface Point { x: number; y: number }

interface Props {
  nodes: GraphNode[];
  links: GraphEdge[];
  selectedId: string | null;
  highlightedFactIds: string[];
  onSelect: (node: GraphNode) => void;
  onClear?: () => void;
}

const COLORS: Record<string, string> = {
  Person: '#53636a', Team: '#657b72', Service: '#8b7759', Repository: '#6f6c86',
  CodeSymbol: '#597790', Decision: '#936c67', PullRequest: '#8c6879', Runbook: '#657b6e',
  Fact: '#657c90', Source: '#8a9294',
};

function nodeColor(node: GraphNode): string {
  if (node.kind === 'fact') return COLORS.Fact;
  if (node.kind === 'episode') return COLORS.Source;
  return COLORS[node.type] || '#737e7d';
}

function graphPositions(nodes: GraphNode[]): Map<string, Point> {
  const entityCount = nodes.filter(node => (node.kind || 'entity') === 'entity').length;
  const factCount = nodes.filter(node => node.kind === 'fact').length;
  const sourceCount = nodes.filter(node => node.kind === 'episode').length;
  const positions = new Map<string, Point>();
  let entityCursor = 0;
  let factCursor = 0;
  let sourceCursor = 0;

  for (const node of nodes) {
    if (node.kind === 'fact') {
      const angle = (factCursor / Math.max(1, factCount)) * Math.PI * 2 + 0.2;
      positions.set(node.id, { x: 500 + Math.cos(angle) * 118, y: 320 + Math.sin(angle) * 92 });
      factCursor += 1;
      continue;
    }
    if (node.kind === 'episode') {
      const angle = (sourceCursor / Math.max(1, sourceCount)) * Math.PI * 2 - 0.4;
      positions.set(node.id, { x: 500 + Math.cos(angle) * 352, y: 320 + Math.sin(angle) * 238 });
      sourceCursor += 1;
      continue;
    }
    const index = entityCursor++;
    const anchors: Record<string, number> = {
      Person: 0.15, Team: 1.0, Service: 2.15, Repository: 2.8,
      CodeSymbol: 3.55, Runbook: 4.1, Decision: 4.85, PullRequest: 5.65,
    };
    const angle = (anchors[node.type] ?? (index / Math.max(1, entityCount)) * Math.PI * 2) + (index % 2 ? 0.32 : -0.26);
    const radius = node.type === 'Service' ? 14 : node.type === 'Team' ? 180 : 245;
    positions.set(node.id, { x: 500 + Math.cos(angle) * radius, y: 320 + Math.sin(angle) * radius * 0.68 });
  }
  return positions;
}

export default function GraphViewport({ nodes, links, selectedId, highlightedFactIds, onSelect, onClear }: Props) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const positions = useMemo(() => graphPositions(nodes), [nodes]);
  const highlighted = useMemo(() => new Set(highlightedFactIds), [highlightedFactIds]);
  const width = 1000 / zoom;
  const height = 640 / zoom;
  const viewBox = `${500 - width / 2} ${320 - height / 2} ${width} ${height}`;

  if (nodes.length === 0) {
    return <div className="graph-empty"><span className="empty-orbit" /><strong>No connected knowledge yet</strong><span>Connect a company source or ingest an approved document to build this graph.</span></div>;
  }

  return (
    <>
      <svg
        className="knowledge-graph"
        viewBox={viewBox}
        role="img"
        aria-label={`Knowledge graph containing ${nodes.length} records and ${links.length} relationships`}
        onClick={onClear}
      >
        <g className="graph-edges" aria-hidden="true">
          {links.map(link => {
            const start = positions.get(link.source);
            const end = positions.get(link.target);
            if (!start || !end) return null;
            const isHighlighted = highlighted.has(link.id);
            return <line key={`${link.id}-${link.source}-${link.target}`} x1={start.x} y1={start.y} x2={end.x} y2={end.y} className={isHighlighted ? 'graph-edge graph-edge-highlighted' : 'graph-edge'} />;
          })}
        </g>
        <g className="graph-nodes">
          {nodes.map(node => {
            const point = positions.get(node.id);
            if (!point) return null;
            const small = node.kind === 'fact' || node.kind === 'episode';
            const active = selectedId === node.id;
            const hovered = hoveredId === node.id;
            const showLabel = active || hovered || !small;
            return (
              <g
                key={node.id}
                className={`graph-node${active ? ' graph-node-active' : ''}`}
                role="button"
                tabIndex={0}
                aria-label={`${node.type}: ${node.name}`}
                aria-pressed={active}
                onClick={event => { event.stopPropagation(); onSelect(node); }}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node); }
                }}
                onPointerEnter={() => setHoveredId(node.id)}
                onPointerLeave={() => setHoveredId(current => current === node.id ? null : current)}
              >
                {active && <circle className="graph-node-halo" cx={point.x} cy={point.y} r={small ? 12 : 18} />}
                <circle className="graph-node-dot" cx={point.x} cy={point.y} r={small ? (node.kind === 'fact' ? 5.5 : 4.5) : 8} fill={nodeColor(node)} />
                {showLabel && <text className={`graph-node-label${active ? ' graph-node-label-active' : ''}`} x={point.x + 12} y={point.y - 10}>{node.name}</text>}
                <title>{node.name} · {node.type}{node.summary ? ` — ${node.summary}` : ''}</title>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="graph-zoom-controls" aria-label="Graph zoom controls">
        <button type="button" onClick={() => setZoom(value => Math.min(1.7, Number((value + 0.15).toFixed(2))))} aria-label="Zoom in">+</button>
        <button type="button" onClick={() => setZoom(value => Math.max(0.7, Number((value - 0.15).toFixed(2))))} aria-label="Zoom out">−</button>
        <button type="button" onClick={() => setZoom(1)} aria-label="Reset graph zoom">↺</button>
      </div>
    </>
  );
}
