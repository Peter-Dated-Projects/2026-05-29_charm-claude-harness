// Tauri IPC bridge. Falls back to mock data in browser (no Tauri runtime).
import type { CharmState, DirEntry } from '../types/charm'

function hasTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!hasTauri()) throw new Error('no-tauri')
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(cmd, args)
}

export async function getCharmState(charmRoot: string): Promise<CharmState> {
  return invoke<CharmState>('get_charm_state', { charmRoot })
}

export async function readFile(path: string): Promise<string> {
  return invoke<string>('read_file_content', { path })
}

export async function listDirectory(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>('list_directory', { path })
}

// Mock charm state for browser dev (no Tauri)
export const MOCK_CHARM_STATE: CharmState = {
  charm_root: '/charm/demo',
  meta: { description: 'charm studio demo workspace' },
  coordination: '| id | title | status | agent |\n|---|---|---|---|\n| T-001 | implement canvas live data | in_progress | worker-01 |\n| T-002 | markdown preview | in_progress | worker-02 |',
  tickets: [
    { id: 'T-001', title: 'implement canvas live data', status: 'in_progress', stage: 'build', depends_on: [], touches: [] },
    { id: 'T-002', title: 'markdown preview', status: 'in_progress', stage: 'build', depends_on: [], touches: ['.charm/worktrees/feat-preview/src/MarkdownViewer.tsx'] },
    { id: 'T-003', title: 'auto-layout algorithm', status: 'open', stage: 'plan', depends_on: [], touches: [] },
    { id: 'T-004', title: 'feat/auth middleware', status: 'in_progress', stage: 'build', depends_on: [], touches: ['.charm/worktrees/feat-auth/src/auth/jwt.ts'] },
    { id: 'T-005', title: 'write auth tests', status: 'open', stage: 'investigate', depends_on: ['T-004'], touches: ['.charm/worktrees/feat-auth/tests/auth.spec.ts'] },
  ],
  worktrees: [
    { name: 'feat-auth',    path: '.charm/worktrees/feat-auth',    branch: 'feat/auth' },
    { name: 'feat-preview', path: '.charm/worktrees/feat-preview', branch: 'feat/preview' },
  ],
}
