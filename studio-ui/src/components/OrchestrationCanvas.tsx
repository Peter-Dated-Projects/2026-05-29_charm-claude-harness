// OrchestrationCanvas — Phase 1 static layout
// All positions are hardcoded for the 1200x800 viewBox.
// Phase 2 will replace this with computed radial placement.

const VB_W = 1200
const VB_H = 800

// ─── Node data ───────────────────────────────────────────────

const MAIN = { cx: 450, cy: 400, s: 80 }  // square half-size = 40

const MAIN_AGENTS = [
  { id: 'ag-01', cx: 450, cy: 180, r: 26, label: 'investigate', status: 'active'  },
  { id: 'ag-02', cx: 672, cy: 278, r: 26, label: 'refactor',    status: 'active'  },
  { id: 'ag-03', cx: 638, cy: 534, r: 26, label: 'test suite',  status: 'idle'    },
  { id: 'ag-04', cx: 262, cy: 534, r: 26, label: 'lint + fmt',  status: 'idle'    },
  { id: 'ag-05', cx: 228, cy: 278, r: 26, label: 'docs',        status: 'active'  },
]

const SUB_ORCH = { id: 'so-01', cx: 940, cy: 260, s: 64, label: 'feat/auth' }

const SUB_AGENTS = [
  { id: 'sa-01', cx: 845, cy: 128, r: 22, label: 'jwt',    status: 'active' },
  { id: 'sa-02', cx: 1038, cy: 128, r: 22, label: 'tests',  status: 'active' },
  { id: 'sa-03', cx: 940, cy: 400, r: 22, label: 'review', status: 'idle'   },
]

// Dashed bounding box (padded convex hull of sub-orch group)
const WBOX = { x: 768, y: 60, w: 316, h: 392 }

// ─── Edge data ───────────────────────────────────────────────

const EDGES = [
  // main orch → agents
  { id: 'e-m-a1', x1: 450, y1: 360, x2: 450, y2: 206,  color: '#3b82f6', active: true,  dur: 2.4 },
  { id: 'e-m-a2', x1: 490, y1: 378, x2: 648, y2: 296,  color: '#3b82f6', active: true,  dur: 2.8 },
  { id: 'e-m-a3', x1: 476, y1: 440, x2: 618, y2: 512,  color: '#4a5a78', active: false, dur: 3.2 },
  { id: 'e-m-a4', x1: 414, y1: 440, x2: 284, y2: 512,  color: '#4a5a78', active: false, dur: 2.9 },
  { id: 'e-m-a5', x1: 410, y1: 378, x2: 252, y2: 296,  color: '#3b82f6', active: true,  dur: 3.1 },
  // main orch → sub-orch
  { id: 'e-m-s',  x1: 490, y1: 370, x2: 908, y2: 270,  color: '#a78bfa', active: true,  dur: 4.0 },
  // sub-orch → sub-agents
  { id: 'e-s-s1', x1: 924, y1: 228, x2: 858, y2: 150,  color: '#a78bfa', active: true,  dur: 2.0 },
  { id: 'e-s-s2', x1: 972, y1: 228, x2: 1016, y2: 150, color: '#a78bfa', active: true,  dur: 2.2 },
  { id: 'e-s-s3', x1: 940, y1: 292, x2: 940, y2: 378,  color: '#4a5a78', active: false, dur: 2.6 },
]

// ─── Helpers ─────────────────────────────────────────────────

function agentColor(status: string) {
  return status === 'active' ? '#10b981' : '#2e3c55'
}

function agentStroke(status: string) {
  return status === 'active' ? '#059669' : '#1e2a3a'
}

// ─── Sub-components ──────────────────────────────────────────

function EdgeLine({ e }: { e: typeof EDGES[number] }) {
  const id = `path-${e.id}`
  const dots = e.active ? [0, 0.45] : [0]
  return (
    <g>
      <path
        id={id}
        d={`M ${e.x1},${e.y1} L ${e.x2},${e.y2}`}
        stroke={e.active ? e.color : '#1a2238'}
        strokeWidth={e.active ? 1.2 : 0.8}
        strokeDasharray={e.active ? undefined : '4 4'}
        fill="none"
        opacity={e.active ? 0.6 : 0.35}
      />
      {dots.map((offset, i) => (
        <circle key={i} r={e.active ? 3 : 2} fill={e.color} filter="url(#dot-glow)" opacity={e.active ? 1 : 0.5}>
          <animateMotion
            dur={`${e.dur}s`}
            begin={`${offset * e.dur}s`}
            repeatCount="indefinite"
            rotate="auto"
          >
            <mpath href={`#${id}`} />
          </animateMotion>
        </circle>
      ))}
    </g>
  )
}

function OrchestratorNode({ cx, cy, s, label, color, strokeColor, glowFilter }: {
  cx: number; cy: number; s: number; label: string
  color: string; strokeColor: string; glowFilter: string
}) {
  const hs = s / 2
  return (
    <g>
      {/* Glow layer */}
      <rect
        x={cx - hs - 6} y={cy - hs - 6}
        width={s + 12} height={s + 12}
        rx={2}
        fill={color}
        opacity={0.07}
        filter="url(#bg-glow)"
      />
      {/* Main square */}
      <rect
        x={cx - hs} y={cy - hs}
        width={s} height={s}
        rx={1}
        fill="#0a0f1e"
        stroke={strokeColor}
        strokeWidth={1.5}
        filter={glowFilter}
      />
      {/* Inner accent line (top) */}
      <line
        x1={cx - hs + 4} y1={cy - hs}
        x2={cx + hs - 4} y2={cy - hs}
        stroke={color}
        strokeWidth={2}
      />
      {/* Label */}
      <text
        x={cx} y={cy - 6}
        textAnchor="middle"
        fill={color}
        fontSize={8}
        letterSpacing={2}
        fontFamily="ui-monospace, monospace"
        textDecoration="none"
      >
        ORCH
      </text>
      <text
        x={cx} y={cy + 8}
        textAnchor="middle"
        fill="#8b9ab8"
        fontSize={10}
        fontFamily="ui-monospace, monospace"
      >
        {label}
      </text>
    </g>
  )
}

function AgentNode({ cx, cy, r, label, status }: {
  cx: number; cy: number; r: number; label: string; status: string
}) {
  const color  = agentColor(status)
  const stroke = agentStroke(status)
  const active = status === 'active'
  return (
    <g>
      {active && (
        <circle cx={cx} cy={cy} r={r + 8} fill={color} opacity={0.06} filter="url(#bg-glow)" />
      )}
      <circle
        cx={cx} cy={cy} r={r}
        fill="#0a0f1e"
        stroke={stroke}
        strokeWidth={1.2}
        filter={active ? 'url(#node-glow-green)' : undefined}
      />
      {/* Status dot */}
      <circle
        cx={cx + r - 7}
        cy={cy - r + 7}
        r={4}
        fill={color}
        filter={active ? 'url(#dot-glow)' : undefined}
      />
      <text
        x={cx} y={cy + 4}
        textAnchor="middle"
        fill={active ? '#8b9ab8' : '#3d4a68'}
        fontSize={9}
        fontFamily="ui-monospace, monospace"
      >
        {label}
      </text>
    </g>
  )
}

// ─── Canvas ──────────────────────────────────────────────────

export default function OrchestrationCanvas() {
  return (
    <div className="canvas-svg-wrap">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="xMidYMid meet"
        width="100%"
        height="100%"
        style={{ display: 'block' }}
      >
        <defs>
          {/* Dot-grid background pattern */}
          <pattern id="dot-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <circle cx="20" cy="20" r="0.7" fill="#0f1824" />
          </pattern>

          {/* Glow filters */}
          <filter id="dot-glow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          <filter id="bg-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="12" />
          </filter>

          <filter id="node-glow-blue" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          <filter id="node-glow-green" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          <filter id="node-glow-violet" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Background */}
        <rect width={VB_W} height={VB_H} fill="#090b10" />
        <rect width={VB_W} height={VB_H} fill="url(#dot-grid)" />

        {/* Worktree bounding box (drawn first, behind nodes) */}
        <rect
          x={WBOX.x} y={WBOX.y}
          width={WBOX.w} height={WBOX.h}
          rx={3}
          fill="rgba(167,139,250,0.03)"
          stroke="#5b3db0"
          strokeWidth={1}
          strokeDasharray="6 4"
          opacity={0.8}
        />
        <text
          x={WBOX.x + 10} y={WBOX.y + 18}
          fill="#5b3db0"
          fontSize={9}
          letterSpacing={1.5}
          fontFamily="ui-monospace, monospace"
        >
          WORKTREE
        </text>

        {/* Edges (below nodes) */}
        {EDGES.map((e) => <EdgeLine key={e.id} e={e} />)}

        {/* Main orchestrator */}
        <OrchestratorNode
          cx={MAIN.cx} cy={MAIN.cy} s={MAIN.s}
          label="main"
          color="#3b82f6"
          strokeColor="#1d4ed8"
          glowFilter="url(#node-glow-blue)"
        />

        {/* Main agents */}
        {MAIN_AGENTS.map((ag) => (
          <AgentNode key={ag.id} {...ag} />
        ))}

        {/* Sub-orchestrator */}
        <OrchestratorNode
          cx={SUB_ORCH.cx} cy={SUB_ORCH.cy} s={SUB_ORCH.s}
          label={SUB_ORCH.label}
          color="#a78bfa"
          strokeColor="#7c3aed"
          glowFilter="url(#node-glow-violet)"
        />

        {/* Sub-agents */}
        {SUB_AGENTS.map((sa) => (
          <AgentNode key={sa.id} {...sa} />
        ))}

        {/* Legend — bottom right */}
        <g transform={`translate(${VB_W - 180}, ${VB_H - 110})`}>
          <rect width={170} height={100} rx={2} fill="#0d1117" stroke="#1a2035" strokeWidth={1} />
          <text x={12} y={18} fill="#3d4a68" fontSize={8} letterSpacing={1.5} fontFamily="ui-monospace, monospace">LEGEND</text>

          <rect x={12} y={28} width={10} height={10} rx={0} fill="none" stroke="#3b82f6" strokeWidth={1} />
          <text x={28} y={37} fill="#5e6f92" fontSize={9} fontFamily="ui-monospace, monospace">orchestrator</text>

          <rect x={12} y={46} width={10} height={10} rx={0} fill="none" stroke="#a78bfa" strokeWidth={1} strokeDasharray="3 2" />
          <text x={28} y={55} fill="#5e6f92" fontSize={9} fontFamily="ui-monospace, monospace">sub-orchestrator</text>

          <circle cx={17} cy={70} r={5} fill="none" stroke="#10b981" strokeWidth={1} />
          <text x={28} y={74} fill="#5e6f92" fontSize={9} fontFamily="ui-monospace, monospace">active agent</text>

          <circle cx={17} cy={86} r={5} fill="none" stroke="#2e3c55" strokeWidth={1} />
          <text x={28} y={90} fill="#5e6f92" fontSize={9} fontFamily="ui-monospace, monospace">idle agent</text>
        </g>
      </svg>
    </div>
  )
}
