import './App.css'
import { useState, useMemo } from 'react'
import FileExplorer from './components/FileExplorer'
import OrchestrationCanvas from './components/OrchestrationCanvas'
import AgentSidebar from './components/AgentSidebar'
import MarkdownViewer from './components/MarkdownViewer'
import { useCharmData, useFileContent } from './hooks/useCharmData'
import { computeLayout } from './lib/layout'

type ActiveView = 'files' | 'charm' | 'search'

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
function IconSettings() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  )
}

export default function App() {
  const [activeView, setActiveView] = useState<ActiveView>('files')
  const [previewPath, setPreviewPath] = useState<string | null>(null)

  const { state, loading, error, tauriAvailable } = useCharmData()
  const { content: previewContent } = useFileContent(previewPath)

  const graph = useMemo(() => {
    if (!state) return computeLayout({ tickets: [], worktrees: [], meta: { description: '' }, coordination: '', charm_root: '' })
    return computeLayout(state)
  }, [state])

  const activeCount   = (state?.tickets ?? []).filter(t => t.status === 'in_progress').length
  const idleCount     = (state?.tickets ?? []).filter(t => t.status === 'open').length
  const worktreeCount = (state?.worktrees ?? []).length

  const showPreview = previewPath !== null && previewContent !== null

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
          <button className="activity-btn" title="Settings"><IconSettings /></button>
        </div>
      </nav>

      <FileExplorer onOpenFile={path => setPreviewPath(path)} />

      <main className="canvas-panel">
        <div className="canvas-titlebar">
          <span className="canvas-title">
            {showPreview ? previewPath!.split('/').pop() : 'orchestration — charm studio'}
          </span>
          <div className="canvas-badges">
            {showPreview ? (
              <button className="canvas-badge close-b" onClick={() => setPreviewPath(null)}>close</button>
            ) : (
              <>
                {activeCount > 0  && <span className="canvas-badge active-b">{activeCount} active</span>}
                {idleCount > 0    && <span className="canvas-badge">{idleCount} open</span>}
                {worktreeCount > 0 && <span className="canvas-badge worktree-b">{worktreeCount} worktrees</span>}
                {!tauriAvailable  && <span className="canvas-badge mock-b">mock</span>}
                {error            && <span className="canvas-badge err-b">error</span>}
              </>
            )}
          </div>
        </div>

        {showPreview ? (
          <MarkdownViewer path={previewPath!} content={previewContent} onClose={() => setPreviewPath(null)} />
        ) : (
          <OrchestrationCanvas graph={graph} />
        )}
      </main>

      <AgentSidebar state={state} loading={loading} tauriAvailable={tauriAvailable} />
    </div>
  )
}
