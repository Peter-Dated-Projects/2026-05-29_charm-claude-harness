import type { CharmState, CanvasGraph, CanvasNode, CanvasEdge, WorktreeBox, NodeStatus } from '../types/charm'
import { worktreeForTicket } from './charm-parser'

const VB_W = 1200
const VB_H = 800
const CX   = VB_W / 2   // 600
const CY   = VB_H / 2   // 400

const R_AGENT    = 180   // standalone agents orbit radius
const R_WORKTREE = 340   // worktree sub-orch radius
const R_SUBAGENT = 80    // sub-agent orbit radius

const MAIN_S = 80        // main orch square half-size * 2
const SUB_S  = 64        // sub-orch square half-size * 2
const AGENT_R = 26
const SUBAGENT_R = 22

function statusOf(s: string): NodeStatus {
  if (s === 'in_progress') return 'active'
  if (s === 'blocked')     return 'blocked'
  return 'idle'
}

function edgeColor(status: NodeStatus): string {
  if (status === 'active')  return '#3b82f6'
  if (status === 'blocked') return '#f59e0b'
  return '#4a5a78'
}

function subEdgeColor(status: NodeStatus): string {
  if (status === 'active')  return '#a78bfa'
  if (status === 'blocked') return '#f59e0b'
  return '#4a5a78'
}

// Clamp a node's center to a safe margin inside the viewBox
function clamp(cx: number, cy: number, pad = 40): [number, number] {
  return [
    Math.max(pad, Math.min(VB_W - pad, cx)),
    Math.max(pad, Math.min(VB_H - pad, cy)),
  ]
}

export function computeLayout(state: CharmState): CanvasGraph {
  const nodes: CanvasNode[]   = []
  const edges: CanvasEdge[]   = []
  const worktreeBoxes: WorktreeBox[] = []

  const worktreeNames = state.worktrees.map(w => w.name)

  // Only active/open tickets go on canvas
  const liveTickets = state.tickets.filter(t =>
    t.status === 'open' || t.status === 'in_progress' || t.status === 'blocked'
  )

  // Partition tickets by worktree
  const byWorktree = new Map<string, typeof liveTickets>()
  const standalone: typeof liveTickets = []

  for (const ticket of liveTickets) {
    const wt = worktreeForTicket(ticket, worktreeNames)
    if (wt) {
      const arr = byWorktree.get(wt) ?? []
      arr.push(ticket)
      byWorktree.set(wt, arr)
    } else {
      standalone.push(ticket)
    }
  }

  // Main orchestrator
  nodes.push({
    id: '__main__', type: 'orchestrator',
    cx: CX, cy: CY, s: MAIN_S, label: 'main',
    status: standalone.length > 0 || byWorktree.size > 0 ? 'active' : 'idle',
  })

  // Standalone agents around main in R_AGENT ring
  standalone.forEach((ticket, i) => {
    const total = Math.max(standalone.length, 1)
    const angle = (i / total) * 2 * Math.PI - Math.PI / 2
    const [ncx, ncy] = clamp(CX + R_AGENT * Math.cos(angle), CY + R_AGENT * Math.sin(angle))
    const st = statusOf(ticket.status)
    nodes.push({
      id: ticket.id, type: 'agent',
      cx: ncx, cy: ncy, r: AGENT_R, label: ticket.id,
      sublabel: ticket.title.slice(0, 18),
      status: st, ticketId: ticket.id,
    })
    edges.push({
      id: `e-main-${ticket.id}`, from: '__main__', to: ticket.id,
      active: st === 'active',
      x1: CX, y1: CY, x2: ncx, y2: ncy,
      color: edgeColor(st),
      dur: 2.2 + i * 0.3,
    })
  })

  // Worktrees: distribute sub-orchestrators in outer ring
  // Include ALL worktrees, not just those with tickets
  const allWorktrees = state.worktrees.length > 0
    ? state.worktrees
    : [...byWorktree.keys()].map(n => ({ name: n, path: '', branch: '' }))

  // If there are standalone agents AND worktrees, offset the worktree ring to the right
  const wtCount = allWorktrees.length
  allWorktrees.forEach((wt, i) => {
    const baseAngle = standalone.length > 0 ? Math.PI / 6 : -Math.PI / 2
    const angle = baseAngle + (i / Math.max(wtCount, 1)) * 2 * Math.PI
    const [scx, scy] = clamp(CX + R_WORKTREE * Math.cos(angle), CY + R_WORKTREE * Math.sin(angle))

    const wtTickets = byWorktree.get(wt.name) ?? []
    const wtStatus: NodeStatus = wtTickets.some(t => t.status === 'in_progress')
      ? 'active' : wtTickets.length > 0 ? 'idle' : 'idle'

    nodes.push({
      id: `wt-${wt.name}`, type: 'sub-orchestrator',
      cx: scx, cy: scy, s: SUB_S, label: wt.branch || wt.name,
      status: wtStatus,
    })

    edges.push({
      id: `e-main-wt-${wt.name}`, from: '__main__', to: `wt-${wt.name}`,
      active: wtStatus === 'active',
      x1: CX, y1: CY, x2: scx, y2: scy,
      color: wtStatus === 'active' ? '#a78bfa' : '#4a5a78',
      dur: 3.5 + i * 0.4,
    })

    // Sub-agents around this sub-orchestrator
    wtTickets.forEach((ticket, j) => {
      const subTotal = Math.max(wtTickets.length, 1)
      const subAngle = (j / subTotal) * 2 * Math.PI - Math.PI / 2
      const [acx, acy] = clamp(scx + R_SUBAGENT * Math.cos(subAngle), scy + R_SUBAGENT * Math.sin(subAngle))
      const st = statusOf(ticket.status)
      nodes.push({
        id: ticket.id, type: 'agent',
        cx: acx, cy: acy, r: SUBAGENT_R, label: ticket.id,
        sublabel: ticket.title.slice(0, 16),
        status: st, ticketId: ticket.id,
      })
      edges.push({
        id: `e-wt-${wt.name}-${ticket.id}`, from: `wt-${wt.name}`, to: ticket.id,
        active: st === 'active',
        x1: scx, y1: scy, x2: acx, y2: acy,
        color: subEdgeColor(st),
        dur: 1.8 + j * 0.25,
      })
    })

    // Bounding box for the worktree group (sub-orch + sub-agents)
    const subAgentNodes = nodes.filter(n =>
      edges.some(e => e.from === `wt-${wt.name}` && e.to === n.id)
    )
    if (subAgentNodes.length > 0) {
      const allCx = [scx, ...subAgentNodes.map(n => n.cx)]
      const allCy = [scy, ...subAgentNodes.map(n => n.cy)]
      const pad = 36
      const bx = Math.min(...allCx) - pad
      const by = Math.min(...allCy) - pad
      const bw = Math.max(...allCx) - Math.min(...allCx) + pad * 2
      const bh = Math.max(...allCy) - Math.min(...allCy) + pad * 2
      worktreeBoxes.push({ worktreeName: wt.name, x: bx, y: by, w: bw, h: bh, label: wt.branch || wt.name })
    } else {
      // Just a box around the sub-orch alone
      const pad = 48
      worktreeBoxes.push({
        worktreeName: wt.name,
        x: scx - SUB_S / 2 - pad, y: scy - SUB_S / 2 - pad,
        w: SUB_S + pad * 2, h: SUB_S + pad * 2,
        label: wt.branch || wt.name,
      })
    }
  })

  return { nodes, edges, worktreeBoxes }
}
