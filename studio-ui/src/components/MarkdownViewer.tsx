import { useMemo } from 'react'
import { marked } from 'marked'

interface Props {
  path: string
  content: string
  onClose: () => void
}

// Configure marked once
marked.setOptions({ gfm: true, breaks: false })

export default function MarkdownViewer({ path, content, onClose }: Props) {
  const html = useMemo(() => {
    try { return marked.parse(content) as string }
    catch { return `<pre>${content.replace(/</g, '&lt;')}</pre>` }
  }, [content])

  const filename = path.split('/').pop() ?? path

  return (
    <div className="md-viewer">
      <div className="md-titlebar">
        <span className="md-filename">{filename}</span>
        <span className="md-path">{path}</span>
        <button className="md-close" onClick={onClose} title="Close preview">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6"  y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div
        className="md-body"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
