export type TicketStatus = 'open' | 'in_progress' | 'blocked' | 'complete' | 'reviewed' | 'cancelled'
export type TicketStage  = 'investigate' | 'plan' | 'build' | 'test' | 'review' | 'done'

export interface Ticket {
  id: string
  title: string
  status: TicketStatus
  stage: TicketStage
  depends_on: string[]
  touches: string[]
}

export interface WorktreeInfo {
  name: string
  path: string
  branch: string
}

export interface CharmMeta {
  description: string
  created_at?: number
  updated_at?: number
}

export interface CharmState {
  tickets: Ticket[]
  worktrees: WorktreeInfo[]
  meta: CharmMeta
  coordination: string
  charm_root: string
}

export interface DirEntry {
  name: string
  path: string
  is_dir: boolean
}

// Layout output types
export type NodeType = 'orchestrator' | 'sub-orchestrator' | 'agent'
export type NodeStatus = 'active' | 'idle' | 'blocked'

export interface CanvasNode {
  id: string
  type: NodeType
  cx: number
  cy: number
  r?: number  // for agent circles
  s?: number  // for orchestrator squares
  label: string
  sublabel?: string
  status: NodeStatus
  ticketId?: string
}

export interface CanvasEdge {
  id: string
  from: string
  to: string
  active: boolean
  x1: number; y1: number
  x2: number; y2: number
  color: string
  dur: number
}

export interface WorktreeBox {
  worktreeName: string
  x: number; y: number; w: number; h: number
  label: string
}

export interface CanvasGraph {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  worktreeBoxes: WorktreeBox[]
}
