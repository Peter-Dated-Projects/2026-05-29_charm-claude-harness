import type { CanvasGraph, CanvasNode, CanvasEdge, WorktreeBox } from '../types/charm'

const VB_W = 1200
const VB_H = 800

// ─── Color helpers ────────────────────────────────────────────────────────────

function nodeStroke(node: CanvasNode): string {
  if (node.type === 'orchestrator')     return node.status === 'active' ? '#1d4ed8' : '#1a2a4a'
  if (node.type === 'sub-orchestrator') return node.status === 'active' ? '#7c3aed' : '#3b2a6a'
  if (node.status === 'active')  return '#059669'
  if (node.status === 'blocked') return '#d97706'
  return '#1e2a3a'
}

function nodeColor(node: CanvasNode): string {
  if (node.type === 'orchestrator')     return node.status === 'active' ? '#3b82f6' : '#4a5a78'
  if (node.type === 'sub-orchestrator') return node.status === 'active' ? '#a78bfa' : '#6b5fa8'
  if (node.status === 'active')  return '#10b981'
  if (node.status === 'blocked') return '#f59e0b'
  return '#2e3c55'
}

function glowFilter(node: CanvasNode): string | undefined {
  if (!['active', 'blocked'].includes(node.status)) return undefined
  if (node.type === 'orchestrator')     return 'url(#node-glow-blue)'
  if (node.type === 'sub-orchestrator') return 'url(#node-glow-violet)'
  return 'url(#node-glow-green)'
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function EdgeLine({ e }: { e: CanvasEdge }) {
  const pathId = `path-${e.id}`
  const dots = e.active ? [0, 0.45] : [0]
  return (
    <g>
      <path
        id={pathId}
        d={`M ${e.x1},${e.y1} L ${e.x2},${e.y2}`}
        stroke={e.active ? e.color : '#1a2238'}
        strokeWidth={e.active ? 1.2 : 0.8}
        strokeDasharray={e.active ? undefined : '4 4'}
        fill="none"
        opacity={e.active ? 0.6 : 0.3}
      />
      {dots.map((offset, i) => (
        <circle key={i} r={e.active ? 3 : 2} fill={e.color} filter="url(#dot-glow)" opacity={e.active ? 1 : 0.4}>
          <animateMotion dur={`${e.dur}s`} begin={`${offset * e.dur}s`} repeatCount="indefinite" rotate="auto">
            <mpath href={`#${pathId}`} />
          </animateMotion>
        </circle>
      ))}
    </g>
  )
}

function OrchestratorNode({ node }: { node: CanvasNode }) {
  const s = node.s ?? 80
  const hs = s / 2
  const color  = nodeColor(node)
  const stroke = nodeStroke(node)
  const glow   = glowFilter(node)
  return (
    <g>
      <rect
        x={node.cx - hs - 6} y={node.cy - hs - 6}
        width={s + 12} height={s + 12} rx={2}
        fill={color} opacity={0.06} filter="url(#bg-glow)"
      />
      <rect
        x={node.cx - hs} y={node.cy - hs}
        width={s} height={s} rx={1}
        fill="#0a0f1e"
        stroke={stroke} strokeWidth={1.5}
        filter={glow}
      />
      <line
        x1={node.cx - hs + 4} y1={node.cy - hs}
        x2={node.cx + hs - 4} y2={node.cy - hs}
        stroke={color} strokeWidth={2}
      />
      <text x={node.cx} y={node.cy - 6} textAnchor="middle"
        fill={color} fontSize={8} letterSpacing={2} fontFamily="ui-monospace, monospace">
        ORCH
      </text>
      <text x={node.cx} y={node.cy + 8} textAnchor="middle"
        fill="#8b9ab8" fontSize={10} fontFamily="ui-monospace, monospace">
        {node.label.length > 14 ? node.label.slice(0, 13) + '…' : node.label}
      </text>
    </g>
  )
}

function AgentNode({ node }: { node: CanvasNode }) {
  const r      = node.r ?? 26
  const color  = nodeColor(node)
  const stroke = nodeStroke(node)
  const active = node.status === 'active'
  const glow   = glowFilter(node)
  return (
    <g>
      {active && (
        <circle cx={node.cx} cy={node.cy} r={r + 8} fill={color} opacity={0.05} filter="url(#bg-glow)" />
      )}
      <circle cx={node.cx} cy={node.cy} r={r}
        fill="#0a0f1e" stroke={stroke} strokeWidth={1.2}
        filter={glow}
      />
      <circle cx={node.cx + r - 7} cy={node.cy - r + 7} r={4}
        fill={color} filter={active ? 'url(#dot-glow)' : undefined}
      />
      <text x={node.cx} y={node.cy + 4} textAnchor="middle"
        fill={active ? '#8b9ab8' : '#3d4a68'} fontSize={9} fontFamily="ui-monospace, monospace">
        {node.label}
      </text>
    </g>
  )
}

function WorktreeRect({ box }: { box: WorktreeBox }) {
  return (
    <g>
      <rect
        x={box.x} y={box.y} width={box.w} height={box.h} rx={3}
        fill="rgba(167,139,250,0.03)"
        stroke="#5b3db0" strokeWidth={1} strokeDasharray="6 4"
        opacity={0.8}
      />
      <text x={box.x + 10} y={box.y + 18}
        fill="#5b3db0" fontSize={9} letterSpacing={1.5} fontFamily="ui-monospace, monospace">
        {box.label.length > 22 ? box.label.slice(0, 21) + '…' : box.label}
      </text>
    </g>
  )
}

function EmptyState() {
  return (
    <g>
      <text x={VB_W / 2} y={VB_H / 2 + 80} textAnchor="middle"
        fill="#3d4a68" fontSize={11} fontFamily="ui-monospace, monospace" letterSpacing={1}>
        no active agents
      </text>
      <text x={VB_W / 2} y={VB_H / 2 + 100} textAnchor="middle"
        fill="#2a3450" fontSize={9} fontFamily="ui-monospace, monospace">
        create a ticket to spawn agents
      </text>
    </g>
  )
}

// ─── Canvas ───────────────────────────────────────────────────────────────────

interface Props {
  graph: CanvasGraph
  onNodeClick?: (nodeId: string) => void
}

export default function OrchestrationCanvas({ graph, onNodeClick }: Props) {
  const { nodes, edges, worktreeBoxes } = graph
  const hasAgents = nodes.some(n => n.type === 'agent')

  return (
    <div className="canvas-svg-wrap">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="xMidYMid meet"
        width="100%" height="100%"
        style={{ display: 'block' }}
      >
        <defs>
          <pattern id="dot-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <circle cx="20" cy="20" r="0.7" fill="#0f1824" />
          </pattern>

          <filter id="dot-glow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>

          <filter id="bg-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="12" />
          </filter>

          <filter id="node-glow-blue" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>

          <filter id="node-glow-green" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>

          <filter id="node-glow-violet" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        <rect width={VB_W} height={VB_H} fill="#090b10" />
        <rect width={VB_W} height={VB_H} fill="url(#dot-grid)" />

        {worktreeBoxes.map(box => <WorktreeRect key={box.worktreeName} box={box} />)}

        {edges.map(e => <EdgeLine key={e.id} e={e} />)}

        {nodes.map(node => (
          <g
            key={node.id}
            onClick={() => onNodeClick?.(node.id)}
            style={{ cursor: onNodeClick ? 'pointer' : undefined }}
          >
            {(node.type === 'orchestrator' || node.type === 'sub-orchestrator')
              ? <OrchestratorNode node={node} />
              : <AgentNode node={node} />
            }
          </g>
        ))}

        {!hasAgents && <EmptyState />}

        <g transform={`translate(${VB_W - 180}, ${VB_H - 110})`}>
          <rect width={170} height={100} rx={2} fill="#0d1117" stroke="#1a2035" strokeWidth={1} />
          <text x={12} y={18} fill="#3d4a68" fontSize={8} letterSpacing={1.5} fontFamily="ui-monospace, monospace">LEGEND</text>
          <rect x={12} y={28} width={10} height={10} fill="none" stroke="#3b82f6" strokeWidth={1} />
          <text x={28} y={37} fill="#5e6f92" fontSize={9} fontFamily="ui-monospace, monospace">orchestrator</text>
          <rect x={12} y={46} width={10} height={10} fill="none" stroke="#a78bfa" strokeWidth={1} strokeDasharray="3 2" />
          <text x={28} y={55} fill="#5e6f92" fontSize={9} fontFamily="ui-monospace, monospace">worktree</text>
          <circle cx={17} cy={70} r={5} fill="none" stroke="#10b981" strokeWidth={1} />
          <text x={28} y={74} fill="#5e6f92" fontSize={9} fontFamily="ui-monospace, monospace">active agent</text>
          <circle cx={17} cy={86} r={5} fill="none" stroke="#2e3c55" strokeWidth={1} />
          <text x={28} y={90} fill="#5e6f92" fontSize={9} fontFamily="ui-monospace, monospace">idle agent</text>
        </g>
      </svg>
    </div>
  )
}
