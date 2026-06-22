import { useState } from 'react'

type Tab = 'files' | 'charm'

const FILES_TREE = [
  { id: 'src', label: 'src', type: 'dir', depth: 0, expanded: true },
  { id: 'components', label: 'components', type: 'dir', depth: 1, expanded: true },
  { id: 'fe', label: 'FileExplorer.tsx', type: 'file', depth: 2, badge: 'u' },
  { id: 'oc', label: 'OrchestrationCanvas.tsx', type: 'file', depth: 2 },
  { id: 'as', label: 'AgentSidebar.tsx', type: 'file', depth: 2, badge: 'u' },
  { id: 'apptsx', label: 'App.tsx', type: 'file', depth: 1, badge: 'm' },
  { id: 'appcss', label: 'App.css', type: 'file', depth: 1, badge: 'm' },
  { id: 'idxcss', label: 'index.css', type: 'file', depth: 1 },
  { id: 'srctauri', label: 'src-tauri', type: 'dir', depth: 0, expanded: false },
  { id: 'pkgjson', label: 'package.json', type: 'file', depth: 0 },
]

const CHARM_TREE = [
  { id: 'charmdir', label: '.charm', type: 'dir', depth: 0, expanded: true },
  { id: 'tickets', label: 'tickets', type: 'dir', depth: 1, expanded: true },
  { id: 't001', label: 'TICK-001.md', type: 'file', depth: 2, badge: 't' },
  { id: 't002', label: 'TICK-002.md', type: 'file', depth: 2, badge: 't' },
  { id: 't003', label: 'TICK-003.md', type: 'file', depth: 2, badge: 't' },
  { id: 'kb', label: 'kb', type: 'dir', depth: 1, expanded: false },
  { id: 'coord', label: 'COORDINATION.md', type: 'file', depth: 1 },
]

const FILE_ICONS: Record<string, string> = {
  'dir':  '',
  'tsx':  '·',
  'ts':   '·',
  'css':  '·',
  'json': '·',
  'md':   '·',
}

function getExt(name: string) {
  return name.split('.').pop() ?? ''
}

function getIcon(item: { type: string; label: string }) {
  if (item.type === 'dir') return ''
  const ext = getExt(item.label)
  return FILE_ICONS[ext] ?? '·'
}

export default function FileExplorer() {
  const [tab, setTab] = useState<Tab>('files')
  const [selected, setSelected] = useState<string | null>(null)
  const tree = tab === 'files' ? FILES_TREE : CHARM_TREE

  return (
    <aside className="file-explorer">
      <div className="explorer-header">
        <span className="explorer-title">Explorer</span>
      </div>

      <div className="explorer-tabs">
        <div
          className={`explorer-tab${tab === 'files' ? ' active' : ''}`}
          onClick={() => setTab('files')}
        >
          Files
        </div>
        <div
          className={`explorer-tab${tab === 'charm' ? ' active' : ''}`}
          onClick={() => setTab('charm')}
        >
          Charm
        </div>
      </div>

      <div className="explorer-body">
        <div className="tree-section-label">
          <span>▾</span>
          <span>{tab === 'files' ? 'charm-studio' : '.charm workspace'}</span>
        </div>

        {tree.map((item) => (
          <div
            key={item.id}
            className={`tree-item${selected === item.id ? ' selected' : ''}`}
            style={{ paddingLeft: `${12 + item.depth * 12}px` }}
            onClick={() => setSelected(item.id)}
          >
            {item.type === 'dir' ? (
              <span className="tree-chevron">
                {item.expanded ? '▾' : '▸'}
              </span>
            ) : (
              <span className="tree-chevron"></span>
            )}
            <span className="tree-icon">
              {item.type === 'dir'
                ? (item.expanded ? '▿' : '▹')
                : getIcon(item)}
            </span>
            <span className="tree-label">{item.label}</span>
            {item.badge && (
              <span className={`tree-badge ${item.badge}`}>
                {item.badge === 'm' ? 'M' : item.badge === 'u' ? 'U' : '●'}
              </span>
            )}
          </div>
        ))}
      </div>
    </aside>
  )
}
