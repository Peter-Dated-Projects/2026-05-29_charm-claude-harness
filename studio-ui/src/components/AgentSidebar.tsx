import { useState, useRef } from 'react'
import type { CharmState, Ticket } from '../types/charm'

type Tab = 'general' | 'orchestration'

interface Msg {
  id: string
  role: 'user' | 'assistant' | 'system'
  body: string
  time: string
  tool?: { name: string; detail: string }
}

const GENERAL_MSGS: Msg[] = [
  { id: 'g1', role: 'system', body: 'Connected to Claude claude-opus-4-8. Ask anything.', time: '' },
]

function Message({ msg }: { msg: Msg }) {
  return (
    <div className="chat-message">
      <div className="msg-header">
        <span className={`msg-role ${msg.role}`}>{msg.role}</span>
        {msg.time && <span className="msg-time">{msg.time}</span>}
      </div>
      <div
        className="msg-body"
        dangerouslySetInnerHTML={{
          __html: msg.body
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\n/g, '<br/>')
        }}
      />
      {msg.tool && (
        <div className="msg-tool">
          <div className="msg-tool-name">{msg.tool.name}</div>
          <div>{msg.tool.detail}</div>
        </div>
      )}
    </div>
  )
}

function TicketRow({ ticket }: { ticket: Ticket }) {
  const statusColor: Record<string, string> = {
    open:        '#3b82f6',
    in_progress: '#10b981',
    blocked:     '#f59e0b',
    complete:    '#3d4a68',
    reviewed:    '#3d4a68',
    cancelled:   '#3d4a68',
  }
  const color = statusColor[ticket.status] ?? '#3d4a68'
  const isLive = ticket.status === 'open' || ticket.status === 'in_progress' || ticket.status === 'blocked'
  return (
    <div className={`ticket-row${isLive ? ' live' : ''}`}>
      <div className="ticket-header">
        <span className="ticket-id">{ticket.id}</span>
        <span className="ticket-status" style={{ color }}>{ticket.status.replace('_', ' ')}</span>
      </div>
      <div className="ticket-title">{ticket.title}</div>
      {ticket.stage !== 'done' && (
        <div className="ticket-stage">{ticket.stage}</div>
      )}
    </div>
  )
}

interface Props {
  state: CharmState | null
  loading: boolean
  tauriAvailable: boolean
}

export default function AgentSidebar({ state, loading, tauriAvailable }: Props) {
  const [tab, setTab]     = useState<Tab>('orchestration')
  const [draft, setDraft] = useState('')
  const [msgs, setMsgs]   = useState<Msg[]>(GENERAL_MSGS)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const liveTickets   = (state?.tickets ?? []).filter(t =>
    t.status === 'open' || t.status === 'in_progress' || t.status === 'blocked'
  )
  const doneTickets   = (state?.tickets ?? []).filter(t =>
    t.status === 'complete' || t.status === 'reviewed'
  )
  const activeCount   = (state?.tickets ?? []).filter(t => t.status === 'in_progress').length
  const worktreeCount = (state?.worktrees ?? []).length

  const context = tab === 'orchestration'
    ? { label: 'session', value: state?.meta?.description?.slice(0, 32) || 'charm session' }
    : { label: 'model', value: 'claude-opus-4-8' }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      if (!draft.trim()) return
      const now = new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })
      setMsgs(prev => [...prev, { id: String(Date.now()), role: 'user', body: draft, time: now }])
      setDraft('')
    }
  }

  return (
    <aside className="agent-sidebar">
      <div className="sidebar-tabs">
        <div className={`sidebar-tab${tab === 'general' ? ' active' : ''}`} onClick={() => setTab('general')}>
          General
        </div>
        <div className={`sidebar-tab${tab === 'orchestration' ? ' active' : ''}`} onClick={() => setTab('orchestration')}>
          {activeCount > 0 && <span className="tab-dot" />}
          Orchestrate
        </div>
      </div>

      <div className="chat-area">
        <div className="chat-context">
          <div className="chat-context-label">{context.label}</div>
          <div className="chat-context-value">{context.value}</div>
        </div>

        {tab === 'orchestration' ? (
          <div className="coordination-panel">
            <div className="coord-stats">
              <div className="coord-stat">
                <span className="coord-stat-val" style={{ color: '#10b981' }}>{activeCount}</span>
                <span className="coord-stat-label">active</span>
              </div>
              <div className="coord-stat">
                <span className="coord-stat-val" style={{ color: '#a78bfa' }}>{worktreeCount}</span>
                <span className="coord-stat-label">worktrees</span>
              </div>
              <div className="coord-stat">
                <span className="coord-stat-val" style={{ color: '#3b82f6' }}>{state?.tickets?.length ?? 0}</span>
                <span className="coord-stat-label">total</span>
              </div>
              {!tauriAvailable && (
                <div className="coord-stat">
                  <span className="coord-stat-val" style={{ color: '#f59e0b' }}>mock</span>
                  <span className="coord-stat-label">mode</span>
                </div>
              )}
            </div>

            <div className="ticket-list">
              {loading && <div className="ticket-loading">loading…</div>}
              {liveTickets.length > 0 && (
                <>
                  <div className="ticket-section-label">live</div>
                  {liveTickets.map(t => <TicketRow key={t.id} ticket={t} />)}
                </>
              )}
              {doneTickets.length > 0 && (
                <>
                  <div className="ticket-section-label">complete</div>
                  {doneTickets.slice(-5).map(t => <TicketRow key={t.id} ticket={t} />)}
                </>
              )}
              {!loading && state?.tickets?.length === 0 && (
                <div className="ticket-empty">no tickets — session is clean</div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="chat-messages">
              {msgs.map(m => <Message key={m.id} msg={m} />)}
            </div>
            <div className="chat-composer">
              <div className="composer-input-wrap">
                <textarea
                  ref={taRef}
                  className="composer-input"
                  placeholder="Ask Claude anything…"
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={handleKey}
                  rows={3}
                />
                <div className="composer-footer">
                  <span className="composer-hint">cmd+enter send</span>
                  <button className="composer-send">Send</button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
