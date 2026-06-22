import type { Ticket, TicketStatus, TicketStage } from '../types/charm'

// Parse YAML frontmatter from a ticket markdown file.
// Handles:
//   - simple `key: value` pairs
//   - multi-line `title: >-\n  value\n  continuation`
//   - list values:  `key:\n  - item`  and  `key: []`
export function parseTicketFrontmatter(content: string): Ticket | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null
  const fm = match[1]

  const obj: Record<string, unknown> = {}
  const lines = fm.split('\n')
  let mode: 'top' | 'list' | 'multiline' = 'top'
  let currentKey = ''
  let listBuf: string[] = []
  let multilineBuf: string[] = []

  const flush = () => {
    if (mode === 'list')      obj[currentKey] = listBuf
    if (mode === 'multiline') obj[currentKey] = multilineBuf.join(' ')
    listBuf = []
    multilineBuf = []
    mode = 'top'
  }

  for (const line of lines) {
    // Continuation for multiline / list
    if (mode === 'multiline') {
      if (line.startsWith('  ') || line.startsWith('\t')) {
        multilineBuf.push(line.trim())
        continue
      }
      flush()
    }
    if (mode === 'list') {
      const t = line.trimStart()
      if (t.startsWith('- ')) { listBuf.push(t.slice(2).trim()); continue }
      flush()
    }

    const colonIdx = line.indexOf(': ')
    if (colonIdx !== -1) {
      const key   = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 2).trim()
      if (value === '[]') { obj[key] = [] }
      else if (value === '>-' || value === '>') { currentKey = key; mode = 'multiline'; multilineBuf = [] }
      else { obj[key] = value }
    } else {
      const t = line.trim()
      if (t.endsWith(':')) {
        const key = t.slice(0, -1)
        flush()
        currentKey = key
        mode = 'list'
        listBuf = []
      }
    }
  }
  flush()

  const id = obj['id'] as string
  if (!id) return null

  return {
    id,
    title:      (obj['title']      as string) || '',
    status:     (obj['status']     as TicketStatus) || 'open',
    stage:      (obj['stage']      as TicketStage)  || 'investigate',
    depends_on: (obj['depends_on'] as string[]) || [],
    touches:    (obj['touches']    as string[]) || [],
  }
}

// Derive which worktree (by name) a ticket belongs to based on its `touches` paths.
export function worktreeForTicket(ticket: Ticket, worktreeNames: string[]): string | null {
  for (const touch of ticket.touches) {
    for (const name of worktreeNames) {
      if (touch.includes(`worktrees/${name}/`) || touch.includes(`worktrees/${name}`)) {
        return name
      }
    }
  }
  return null
}
