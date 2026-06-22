// OrchestratorHub — renders as a compact window listing active orchestrators.
// Opened via Tauri WebviewWindow at ?hub=1; falls back to an inline panel in
// browser dev mode.

import { useState } from 'react'
import type { CharmState } from '../types/charm'
import { MOCK_CHARM_STATE } from '../lib/charm-ipc'

interface Session {
  id: string
  root: string
  label: string
  description: string
  activeCount: number
  worktreeCount: number
  status: 'active' | 'idle'
}

function mockSessions(): Session[] {
  return [
    {
      id: 'session-0',
      root: '/charm/demo',
      label: 'charm-demo',
      description: MOCK_CHARM_STATE.meta.description,
      activeCount: MOCK_CHARM_STATE.tickets.filter(t => t.status === 'in_progress').length,
      worktreeCount: MOCK_CHARM_STATE.worktrees.length,
      status: 'active',
    },
    {
      id: 'session-1',
      root: '/charm/backend',
      label: 'backend-api',
      description: 'Refactor auth + rate limiting',
      activeCount: 2,
      worktreeCount: 1,
      status: 'active',
    },
    {
      id: 'session-2',
      root: '/charm/docs',
      label: 'docs-site',
      description: 'Update getting started guide',
      activeCount: 0,
      worktreeCount: 0,
      status: 'idle',
    },
  ]
}

interface SessionRowProps {
  session: Session
  active: boolean
  onClick: () => void
}

function SessionRow({ session, active, onClick }: SessionRowProps) {
  return (
    <button className={`hub-session${active ? ' active' : ''}`} onClick={onClick}>
      <div className="hub-session-header">
        <span className="hub-session-label">{session.label}</span>
        <span
          className="hub-session-dot"
          style={{ background: session.status === 'active' ? '#10b981' : '#2e3c55' }}
        />
      </div>
      <div className="hub-session-desc">{session.description}</div>
      <div className="hub-session-stats">
        {session.activeCount > 0 && (
          <span className="hub-stat" style={{ color: '#10b981' }}>{session.activeCount} active</span>
        )}
        {session.worktreeCount > 0 && (
          <span className="hub-stat" style={{ color: '#a78bfa' }}>{session.worktreeCount} wt</span>
        )}
        {session.activeCount === 0 && <span className="hub-stat">idle</span>}
      </div>
    </button>
  )
}

interface Props {
  currentState?: CharmState | null
  onSelectSession?: (session: Session) => void
  compact?: boolean
}

export default function OrchestratorHub({ onSelectSession, compact }: Props) {
  const [sessions] = useState<Session[]>(mockSessions)
  const [selected, setSelected] = useState<string>('session-0')

  function handleSelect(session: Session) {
    setSelected(session.id)
    onSelectSession?.(session)
  }

  return (
    <div className={`hub-panel${compact ? ' compact' : ''}`}>
      <div className="hub-header">
        <span className="hub-title">Orchestrator Hub</span>
        <span className="hub-count">{sessions.filter(s => s.status === 'active').length} running</span>
      </div>

      <div className="hub-sessions">
        {sessions.map(s => (
          <SessionRow
            key={s.id}
            session={s}
            active={selected === s.id}
            onClick={() => handleSelect(s)}
          />
        ))}
      </div>

      <div className="hub-footer">
        <button className="hub-new-btn">+ new session</button>
      </div>
    </div>
  )
}
