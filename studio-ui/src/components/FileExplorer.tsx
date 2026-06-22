import { useState } from 'react'

type Tab = 'files' | 'charm'

const FILES_TREE = [
  { id: 'src',        label: 'src',                       type: 'dir',  depth: 0, expanded: true  },
  { id: 'components', label: 'components',                type: 'dir',  depth: 1, expanded: true  },
  { id: 'fe',         label: 'FileExplorer.tsx',          type: 'file', depth: 2, badge: 'm'      },
  { id: 'oc',         label: 'OrchestrationCanvas.tsx',   type: 'file', depth: 2, badge: 'm'      },
  { id: 'as',         label: 'AgentSidebar.tsx',          type: 'file', depth: 2, badge: 'm'      },
  { id: 'mv',         label: 'MarkdownViewer.tsx',        type: 'file', depth: 2, badge: 'u'      },
  { id: 'apptsx',     label: 'App.tsx',                   type: 'file', depth: 1, badge: 'm'      },
  { id: 'appcss',     label: 'App.css',                   type: 'file', depth: 1, badge: 'm'      },
  { id: 'hooks',      label: 'hooks',                     type: 'dir',  depth: 1, expanded: false },
  { id: 'lib',        label: 'lib',                       type: 'dir',  depth: 1, expanded: false },
  { id: 'types',      label: 'types',                     type: 'dir',  depth: 1, expanded: false },
  { id: 'srctauri',   label: 'src-tauri',                 type: 'dir',  depth: 0, expanded: false },
  { id: 'pkgjson',    label: 'package.json',              type: 'file', depth: 0                  },
]

const CHARM_TREE = [
  { id: 'charmdir',   label: '.charm',           type: 'dir',  depth: 0, expanded: true  },
  { id: 'tickets',    label: 'tickets',          type: 'dir',  depth: 1, expanded: true  },
  { id: 't001',       label: 'T-001.md',         type: 'file', depth: 2, badge: 't', mdPath: '.charm/tickets/T-001.md' },
  { id: 't002',       label: 'T-002.md',         type: 'file', depth: 2, badge: 't', mdPath: '.charm/tickets/T-002.md' },
  { id: 't003',       label: 'T-003.md',         type: 'file', depth: 2, badge: 't', mdPath: '.charm/tickets/T-003.md' },
  { id: 'kb',         label: 'kb',               type: 'dir',  depth: 1, expanded: false },
  { id: 'coord',      label: 'COORDINATION.md',  type: 'file', depth: 1, mdPath: '.charm/COORDINATION.md' },
  { id: 'meta',       label: 'meta.json',        type: 'file', depth: 1 },
  { id: 'worktrees',  label: 'worktrees',        type: 'dir',  depth: 1, expanded: false },
]

type TreeItem = {
  id: string; label: string; type: string; depth: number;
  badge?: string; expanded?: boolean; mdPath?: string
}

interface Props {
  onOpenFile?: (path: string) => void
}

function getExt(name: string) { return name.split('.').pop() ?? '' }

function fileColor(badge?: string): string {
  if (badge === 'm') return '#f59e0b'
  if (badge === 'u') return '#10b981'
  if (badge === 't') return '#3b82f6'
  return ''
}

export default function FileExplorer({ onOpenFile }: Props) {
  const [tab, setTab]       = useState<Tab>('files')
  const [selected, setSelected] = useState<string | null>(null)
  const tree: TreeItem[] = tab === 'files' ? FILES_TREE : CHARM_TREE

  function handleClick(item: TreeItem) {
    setSelected(item.id)
    if (item.type === 'file' && item.mdPath && getExt(item.label) === 'md' && onOpenFile) {
      onOpenFile(item.mdPath)
    }
  }

  return (
    <aside className="file-explorer">
      <div className="explorer-header">
        <span className="explorer-title">Explorer</span>
      </div>

      <div className="explorer-tabs">
        <div className={`explorer-tab${tab === 'files' ? ' active' : ''}`} onClick={() => setTab('files')}>
          Files
        </div>
        <div className={`explorer-tab${tab === 'charm' ? ' active' : ''}`} onClick={() => setTab('charm')}>
          Charm
        </div>
      </div>

      <div className="explorer-body">
        <div className="tree-section-label">
          <span>{'▾'}</span>
          <span>{tab === 'files' ? 'charm-studio' : '.charm workspace'}</span>
        </div>

        {tree.map(item => (
          <div
            key={item.id}
            className={`tree-item${selected === item.id ? ' selected' : ''}`}
            style={{ paddingLeft: `${12 + item.depth * 12}px` }}
            onClick={() => handleClick(item)}
          >
            {item.type === 'dir' ? (
              <span className="tree-chevron">{item.expanded ? '▾' : '▸'}</span>
            ) : (
              <span className="tree-chevron" />
            )}
            <span className="tree-icon">
              {item.type === 'dir' ? (item.expanded ? '▿' : '▹') : '·'}
            </span>
            <span className="tree-label">{item.label}</span>
            {item.badge && (
              <span className="tree-badge" style={{ color: fileColor(item.badge) }}>
                {item.badge === 'm' ? 'M' : item.badge === 'u' ? 'U' : '●'}
              </span>
            )}
          </div>
        ))}
      </div>
    </aside>
  )
}
