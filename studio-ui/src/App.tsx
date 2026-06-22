import './App.css'
import { useState, useMemo } from 'react'
import FileExplorer from './components/FileExplorer'
import OrchestrationCanvas from './components/OrchestrationCanvas'
import AgentSidebar from './components/AgentSidebar'
import MarkdownViewer from './components/MarkdownViewer'
import OrchestratorHub from './components/OrchestratorHub'
import TicketDetail from './components/TicketDetail'
import { useCharmData, useFileContent } from './hooks/useCharmData'
import { computeLayout } from './lib/layout'

type ActiveView = 'files' | 'charm' | 'search'
type CenterContent = 'canvas' | 'markdown' | 'ticket' | 'hub'

function IconFiles() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h6l2 2h8v14H4z"/>
    </svg>
  )
}
function IconAgents() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/><circle cx="12" cy="4" r="1.5"/>
      <circle cx="20" cy="16" r="1.5"/><circle cx="4" cy="16" r="1.5"/>
      <line x1="12" y1="7" x2="12" y2="9"/>
      <line x1="17.6" y1="14.1" x2="14.5" y2="13"/>
      <line x1="6.4" y1="14.1" x2="9.5" y2="13"/>
    </svg>
  )
}
function IconSearch() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  )
}
function IconHub() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="6" height="6" rx="1"/>
      <rect x="16" y="3" width="6" height="6" rx="1"/>
      <rect x="2" y="15" width="6" height="6" rx="1"/>
      <rect x="16" y="15" width="6" height="6" rx="1"/>
      <line x1="8" y1="6" x2="16" y2="6"/>
      <line x1="8" y1="18" x2="16" y2="18"/>
      <line x1="12" y1="6" x2="12" y2="18"/>
    </svg>
  )
}
function IconSettings() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  )
}

export default function App() {
  const [activeView,    setActiveView]    = useState<ActiveView>('files')
  const [previewPath,   setPreviewPath]   = useState<string | null>(null)
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null)
  const [centerContent, setCenterContent] = useState<CenterContent>('canvas')

  const { state, loading, error, tauriAvailable } = useCharmData()
  const { content: previewContent } = useFileContent(previewPath)

  const graph = useMemo(() => {
    if (!state) return computeLayout({ tickets: [], worktrees: [], meta: { description: '' }, coordination: '', charm_root: '' })
    return computeLayout(state)
  }, [state])

  const activeCount   = (state?.tickets ?? []).filter(t => t.status === 'in_progress').length
  const idleCount     = (state?.tickets ?? []).filter(t => t.status === 'open').length
  const worktreeCount = (state?.worktrees ?? []).length

  const selectedTicket = selectedTicketId
    ? state?.tickets.find(t => t.id === selectedTicketId) ?? null
    : null

  function openFile(path: string) {
    setPreviewPath(path)
    setCenterContent('markdown')
  }

  function openTicket(nodeId: string) {
    const ticket = state?.tickets.find(t => t.id === nodeId)
    if (ticket) {
      setSelectedTicketId(ticket.id)
      setCenterContent('ticket')
    }
  }

  function closeCenter() {
    setPreviewPath(null)
    setSelectedTicketId(null)
    setCenterContent('canvas')
  }

  function openHub() {
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      import('@tauri-apps/api/webviewWindow').then(({ WebviewWindow }) => {
        const existing = WebviewWindow.getByLabel('hub')
        if (existing) { existing.then(w => w?.setFocus()) }
        else {
          new WebviewWindow('hub', {
            url: '/?hub=1',
            title: 'Orchestrator Hub',
            width: 300,
            height: 650,
            resizable: false,
            alwaysOnTop: true,
          })
        }
      })
    } else {
      // Dev browser mode — show hub inline as center panel
      setCenterContent(centerContent === 'hub' ? 'canvas' : 'hub')
    }
  }

  // Hub-only window (when opened as a Tauri WebviewWindow at ?hub=1)
  const isHubWindow = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('hub') === '1'
  if (isHubWindow) {
    return (
      <div style={{ height: '100vh', background: '#090b10', fontFamily: 'var(--mono)' }}>
        <OrchestratorHub currentState={state} />
      </div>
    )
  }

  const titlebar: Record<CenterContent, string> = {
    canvas:   'orchestration — charm studio',
    markdown: previewPath?.split('/').pop() ?? '',
    ticket:   selectedTicket ? `${selectedTicket.id} — ${selectedTicket.title}` : '',
    hub:      'orchestrator hub',
  }

  return (
    <div className="app-shell">
      <nav className="activity-bar">
        <div className="activity-top">
          <button className={`activity-btn${activeView === 'files' ? ' active' : ''}`} title="Explorer" onClick={() => setActiveView('files')}>
            <IconFiles />
          </button>
          <button className={`activity-btn${activeView === 'charm' ? ' active' : ''}`} title="Charm Agents" onClick={() => setActiveView('charm')}>
            <IconAgents />
          </button>
          <button className={`activity-btn${activeView === 'search' ? ' active' : ''}`} title="Search" onClick={() => setActiveView('search')}>
            <IconSearch />
          </button>
        </div>
        <div className="activity-bottom">
          <button className={`activity-btn${centerContent === 'hub' ? ' active' : ''}`} title="Orchestrator Hub" onClick={openHub}>
            <IconHub />
          </button>
          <button className="activity-btn" title="Settings"><IconSettings /></button>
        </div>
      </nav>

      <FileExplorer onOpenFile={openFile} />

      <main className="canvas-panel">
        <div className="canvas-titlebar">
          <span className="canvas-title">{titlebar[centerContent]}</span>
          <div className="canvas-badges">
            {centerContent !== 'canvas' ? (
              <button className="canvas-badge close-b" onClick={closeCenter}>close</button>
            ) : (
              <>
                {activeCount > 0   && <span className="canvas-badge active-b">{activeCount} active</span>}
                {idleCount > 0     && <span className="canvas-badge">{idleCount} open</span>}
                {worktreeCount > 0 && <span className="canvas-badge worktree-b">{worktreeCount} worktrees</span>}
                {!tauriAvailable   && <span className="canvas-badge mock-b">mock</span>}
                {error             && <span className="canvas-badge err-b">error</span>}
              </>
            )}
          </div>
        </div>

        {centerContent === 'canvas' && (
          <OrchestrationCanvas graph={graph} onNodeClick={openTicket} />
        )}
        {centerContent === 'markdown' && previewContent !== null && (
          <MarkdownViewer path={previewPath!} content={previewContent} onClose={closeCenter} />
        )}
        {centerContent === 'ticket' && selectedTicket !== null && (
          <TicketDetail ticket={selectedTicket} onClose={closeCenter} />
        )}
        {centerContent === 'hub' && (
          <div className="hub-inline-wrap">
            <OrchestratorHub currentState={state} compact />
          </div>
        )}
      </main>

      <AgentSidebar state={state} loading={loading} tauriAvailable={tauriAvailable} />
    </div>
  )
}
