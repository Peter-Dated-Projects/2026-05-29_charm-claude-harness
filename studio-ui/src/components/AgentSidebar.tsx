import { useState, useRef } from 'react'

type Tab = 'general' | 'orchestration'

interface Msg {
  id: string
  role: 'user' | 'assistant' | 'system'
  body: string
  time: string
  tool?: { name: string; detail: string }
}

const GENERAL_MSGS: Msg[] = [
  {
    id: 'g1',
    role: 'system',
    body: 'Connected to Claude claude-opus-4-8. Ask anything.',
    time: '09:41',
  },
  {
    id: 'g2',
    role: 'user',
    body: 'What files changed in the last worktree commit?',
    time: '09:42',
  },
  {
    id: 'g3',
    role: 'assistant',
    body: 'The last commit on `feat/auth` touched:\n\n`src/auth/jwt.ts` — new token validation\n`src/auth/middleware.ts` — refresh logic\n`tests/auth.spec.ts` — 14 new cases\n\nNo changes to the daemon or MCP layer.',
    time: '09:42',
  },
]

const ORCH_MSGS: Msg[] = [
  {
    id: 'o1',
    role: 'system',
    body: 'Connected to orchestrator — session charm-3f9a. 3 active agents, 1 worktree.',
    time: '09:38',
  },
  {
    id: 'o2',
    role: 'user',
    body: 'Spin up two investigators to look into the auth refresh token edge cases.',
    time: '09:39',
  },
  {
    id: 'o3',
    role: 'assistant',
    body: 'Creating worktree `feat/auth-edge` and spawning 2 investigator agents.',
    time: '09:39',
    tool: {
      name: 'create_worktree',
      detail: 'branch: feat/auth-edge, base: main',
    },
  },
  {
    id: 'o4',
    role: 'assistant',
    body: 'Done. `ag-01` is investigating token expiry window; `ag-02` is checking concurrent refresh races. You\'ll see them appear on the canvas.',
    time: '09:39',
  },
  {
    id: 'o5',
    role: 'user',
    body: 'How are ag-01 and ag-02 doing?',
    time: '09:44',
  },
  {
    id: 'o6',
    role: 'assistant',
    body: '`ag-01` — In progress. Found a 2s grace window that allows double-use of expiring tokens.\n\n`ag-02` — Blocked on a race condition in `refreshMutex`. Waiting on approval to add a `skipCache` flag.',
    time: '09:44',
  },
]

function Message({ msg }: { msg: Msg }) {
  return (
    <div className="chat-message">
      <div className="msg-header">
        <span className={`msg-role ${msg.role}`}>{msg.role}</span>
        <span className="msg-time">{msg.time}</span>
      </div>
      <div className="msg-body"
        dangerouslySetInnerHTML={{
          __html: msg.body.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br/>')
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

export default function AgentSidebar() {
  const [tab, setTab]   = useState<Tab>('orchestration')
  const [draft, setDraft] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  const msgs = tab === 'general' ? GENERAL_MSGS : ORCH_MSGS

  const context = tab === 'orchestration'
    ? { label: 'session', value: 'charm-3f9a / main' }
    : { label: 'model', value: 'claude-opus-4-8' }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      setDraft('')
    }
  }

  return (
    <aside className="agent-sidebar">
      <div className="sidebar-tabs">
        <div
          className={`sidebar-tab${tab === 'general' ? ' active' : ''}`}
          onClick={() => setTab('general')}
        >
          General
        </div>
        <div
          className={`sidebar-tab${tab === 'orchestration' ? ' active' : ''}`}
          onClick={() => setTab('orchestration')}
        >
          <span className="tab-dot" />
          Orchestrate
        </div>
      </div>

      <div className="chat-area">
        <div className="chat-context">
          <div className="chat-context-label">{context.label}</div>
          <div className="chat-context-value">{context.value}</div>
        </div>

        <div className="chat-messages">
          {msgs.map((m) => <Message key={m.id} msg={m} />)}
        </div>

        <div className="chat-composer">
          <div className="composer-input-wrap">
            <textarea
              ref={taRef}
              className="composer-input"
              placeholder={
                tab === 'orchestration'
                  ? 'Tell the orchestrator what to do…'
                  : 'Ask Claude anything…'
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKey}
              rows={3}
            />
            <div className="composer-footer">
              <span className="composer-hint">⌘↵ send</span>
              <button className="composer-send">Send</button>
            </div>
          </div>
        </div>
      </div>
    </aside>
  )
}
