// TicketDetail — shown in the canvas panel when you click an agent node.
import type { Ticket } from '../types/charm'

interface Props {
  ticket: Ticket
  onClose: () => void
}

const STAGE_ORDER = ['investigate', 'plan', 'build', 'test', 'review', 'done']

function StageProgress({ stage }: { stage: string }) {
  const current = STAGE_ORDER.indexOf(stage)
  return (
    <div className="ticket-stages">
      {STAGE_ORDER.slice(0, -1).map((s, i) => (
        <div key={s} className={`stage-step${i < current ? ' done' : i === current ? ' active' : ''}`}>
          <div className="stage-dot" />
          <span className="stage-label">{s}</span>
        </div>
      ))}
    </div>
  )
}

export default function TicketDetail({ ticket, onClose }: Props) {
  const statusColor: Record<string, string> = {
    open:        '#3b82f6',
    in_progress: '#10b981',
    blocked:     '#f59e0b',
    complete:    '#3d4a68',
    reviewed:    '#3d4a68',
    cancelled:   '#4a5a78',
  }

  return (
    <div className="ticket-detail">
      <div className="ticket-detail-header">
        <div className="ticket-detail-meta">
          <span className="ticket-detail-id">{ticket.id}</span>
          <span className="ticket-detail-status" style={{ color: statusColor[ticket.status] ?? '#8b9ab8' }}>
            {ticket.status.replace('_', ' ')}
          </span>
        </div>
        <button className="md-close" onClick={onClose} title="Close">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <div className="ticket-detail-title">{ticket.title}</div>

      <StageProgress stage={ticket.stage} />

      {ticket.touches.length > 0 && (
        <div className="ticket-detail-section">
          <div className="ticket-detail-section-label">touches</div>
          {ticket.touches.map((t, i) => (
            <div key={i} className="ticket-touch">{t}</div>
          ))}
        </div>
      )}

      {ticket.depends_on.length > 0 && (
        <div className="ticket-detail-section">
          <div className="ticket-detail-section-label">depends on</div>
          <div className="ticket-deps">
            {ticket.depends_on.map(d => (
              <span key={d} className="ticket-dep-badge">{d}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
