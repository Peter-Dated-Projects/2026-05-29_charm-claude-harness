import { useState, useEffect, useRef } from 'react'
import type { CharmState, DirEntry } from '../types/charm'
import { getCharmState, readFile, listDirectory, MOCK_CHARM_STATE } from '../lib/charm-ipc'

const POLL_MS = 3000

// Detect the charm root: use VITE env var, else fall back to a known path for dev.
// In a packaged Tauri build, this would come from a Tauri store or CLI arg.
function detectCharmRoot(): string {
  return (import.meta.env.VITE_CHARM_ROOT as string | undefined) || ''
}

interface UseCharmData {
  state: CharmState | null
  loading: boolean
  error: string | null
  tauriAvailable: boolean
}

export function useCharmData(): UseCharmData {
  const [state, setState] = useState<CharmState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tauriAvailable, setTauriAvailable] = useState(false)
  const isMounted = useRef(true)

  useEffect(() => {
    isMounted.current = true

    async function fetch() {
      const hasTauri = '__TAURI_INTERNALS__' in window
      setTauriAvailable(hasTauri)

      if (!hasTauri) {
        // Dev browser mode — use mock data
        setState(MOCK_CHARM_STATE)
        setLoading(false)
        return
      }

      const charmRoot = detectCharmRoot()
      if (!charmRoot) {
        // Try to get charm state without a root (Rust will detect from cwd)
        try {
          const s = await getCharmState('')
          if (isMounted.current) { setState(s); setError(null) }
        } catch (e) {
          if (isMounted.current) setError(String(e))
        }
        if (isMounted.current) setLoading(false)
        return
      }

      try {
        const s = await getCharmState(charmRoot)
        if (isMounted.current) { setState(s); setError(null) }
      } catch (e) {
        if (isMounted.current) setError(String(e))
      } finally {
        if (isMounted.current) setLoading(false)
      }
    }

    fetch()
    const interval = setInterval(fetch, POLL_MS)
    return () => { isMounted.current = false; clearInterval(interval) }
  }, [])

  return { state, loading, error, tauriAvailable }
}

// Hook for reading a file's content (for markdown preview etc.)
export function useFileContent(path: string | null): { content: string | null; loading: boolean } {
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!path) { setContent(null); return }
    setLoading(true)
    readFile(path)
      .then(setContent)
      .catch(() => setContent(null))
      .finally(() => setLoading(false))
  }, [path])

  return { content, loading }
}

// Hook for listing a directory (for file explorer)
export function useDirectory(path: string | null): { entries: DirEntry[]; loading: boolean } {
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!path) { setEntries([]); return }
    setLoading(true)
    listDirectory(path)
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false))
  }, [path])

  return { entries, loading }
}
