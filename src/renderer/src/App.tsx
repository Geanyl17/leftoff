import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, LayoutGrid, Plus, RefreshCw, Rows3, Search, Settings as SettingsIcon, Sparkles, SquareKanban, X } from 'lucide-react'
import type { ChatState, Snapshot } from '@shared/types'
import { timeAgo } from '@shared/time'
import { buildViews } from './lib/view'
import { Project } from './components/Project'
import { Settings } from './components/Settings'
import { Chat } from './components/Chat'
import { Logo } from './components/Logo'
import { Board } from './components/Board'
import { Today } from './components/Today'
import { NewProject } from './components/NewProject'
import { Vault } from './components/Vault'
import type { ProjectView } from './lib/view'

type Filter = 'all' | 'work' | 'side'
type View = 'list' | 'grid' | 'board'

// Per-viewer UI conveniences only; the app works the same if storage is unavailable.
function stored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}
function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore
  }
}

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [chat, setChat] = useState<ChatState | null>(null)
  const [chatOpen, setChatOpen] = useState(() => stored('chatOpen', false))
  const [chatFocus, setChatFocus] = useState(0)
  const [filter, setFilter] = useState<Filter>(() => stored('filter', 'all'))
  const [view, setView] = useState<View>(() => stored('view', 'list'))
  const [query, setQuery] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newProject, setNewProject] = useState<{ project?: ProjectView } | null>(null)
  const [vault, setVault] = useState<{ project?: ProjectView } | null>(null)
  const [showQuiet, setShowQuiet] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [focus, setFocus] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void window.api.snapshot().then(setSnap)
    void window.api.chatGet().then(setChat)
    const offSnap = window.api.onSnapshot(setSnap)
    const offChat = window.api.onChat(setChat)
    const offFocus = window.api.onFocusProject((id) => {
      setExpanded((s) => new Set(s).add(id))
      setFocus(id)
      setTimeout(() => setFocus(null), 2000)
    })
    const timer = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => {
      offSnap()
      offChat()
      offFocus()
      clearInterval(timer)
    }
  }, [])

  const toggleChat = (open = !chatOpen): void => {
    setChatOpen(open)
    store('chatOpen', open)
    if (open) setChatFocus((n) => n + 1)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
      if (e.key === 'k' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        toggleChat()
      } else if (e.key === '/' && !typing) {
        e.preventDefault()
        searchRef.current?.focus()
      } else if (e.key === 'Escape') {
        if (settingsOpen) setSettingsOpen(false)
        else if (query) setQuery('')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen, query, chatOpen])

  const views = useMemo(() => (snap ? buildViews(snap) : []), [snap])

  // Make updates visible: cards whose recorded state changed light up briefly, and a manual
  // refresh says what it found. Only recorded work and git counts, not an active session
  // ticking along, so cards don't flicker while Claude is mid-conversation.
  const [flash, setFlash] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const lastSig = useRef<Map<string, string> | null>(null)
  const manualRefresh = useRef(false)
  useEffect(() => {
    if (!snap || snap.scanning) return
    const sig = new Map(
      views.map((v) => [
        v.id,
        [v.log[0]?.at ?? 0, ...v.tasks.map((t) => `${t.id}:${t.updatedAt}:${t.status}`), v.done.length, v.dirty, v.ahead, v.p.repos[0]?.commits[0]?.hash ?? ''].join('|')
      ])
    )
    const prev = lastSig.current
    lastSig.current = sig
    if (!prev) return
    const changed = views.filter((v) => prev.get(v.id) !== sig.get(v.id))
    if (changed.length) {
      setFlash(new Set(changed.map((v) => v.id)))
      setTimeout(() => setFlash(new Set()), 2500)
    }
    if (manualRefresh.current) {
      manualRefresh.current = false
      const names = changed.map((v) => v.name)
      setToast(names.length ? `Updated: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}` : 'Already up to date')
      setTimeout(() => setToast(''), 3000)
    }
  }, [views, snap])

  const refresh = async (): Promise<void> => {
    const started = Date.now()
    manualRefresh.current = true
    setRefreshing(true)
    await window.api.scan()
    // Keep the spinner up long enough to be seen; a scan often takes half a second.
    setTimeout(() => setRefreshing(false), Math.max(0, 700 - (Date.now() - started)))
  }

  // How see-through the window background is (Settings → Window opacity).
  const opacity = snap?.settings.opacity ?? 1
  useEffect(() => {
    document.documentElement.style.setProperty('--alpha', String(opacity))
  }, [opacity])

  if (!snap) return <div className="loading">Loading…</div>

  // First run, and no usual project folder (~/code, ~/projects…) was found.
  if (!snap.settings.roots.length) {
    const pick = async (): Promise<void> => {
      const dir = await window.api.pickRoot()
      if (dir) await window.api.updateSettings({ roots: [dir] })
    }
    return (
      <div className="welcome">
        <Logo size={56} />
        <h1>Where do your projects live?</h1>
        <p>Pick the folder that holds your project folders, like ~/code. Each folder inside it shows up as a project. You can add more folders later in Settings.</p>
        <button className="btn primary" onClick={pick}>
          Choose folder…
        </button>
      </div>
    )
  }

  const q = query.trim().toLowerCase()
  const shown = views
    .filter((v) => filter === 'all' || v.m.category === filter)
    .filter((v) => !q || v.name.toLowerCase().includes(q) || v.p.name.toLowerCase().includes(q))
    .sort((a, b) => Number(b.m.pinned) - Number(a.m.pinned) || b.touched - a.touched)
  // Full blocks for projects with something recorded (or pinned, or opened from a row);
  // one line each for the rest, so unrecorded projects don't crowd the screen.
  const visible = shown.filter((v) => !v.m.hidden)
  const full = (v: (typeof views)[number]): boolean => !v.quiet && (v.recorded || v.m.pinned || expanded.has(v.id) || !!q)
  const main = visible.filter((v) => full(v) || (v.quiet && expanded.has(v.id)))
  const recent = visible.filter((v) => !v.quiet && !full(v))
  const quiet = visible.filter((v) => v.quiet && !expanded.has(v.id) && !q)
  const hidden = shown.filter((v) => v.m.hidden)
  const nothingRecorded = !views.some((v) => v.recorded)
  const row = (v: (typeof views)[number]) => (
    <button key={v.id} className="fold-row" onClick={() => setExpanded((s) => new Set(s).add(v.id))}>
      <span className="fold-name">{v.name}</span>
      <span className="fold-text">{v.log[0]?.text ?? (v.fallback ? `${v.fallback.label}: ${v.fallback.text}` : '')}</span>
      <span className="fold-when">{timeAgo(v.touched)}</span>
    </button>
  )

  const switchFilter = (f: Filter): void => {
    setFilter(f)
    store('filter', f)
  }
  const switchView = (v: View): void => {
    setView(v)
    store('view', v)
  }

  return (
    <div className="app">
      <header className="topbar">
        <Logo size={22} tile={false} />
        <span className="brand">Left Off</span>
        <div className="search">
          <Search size={14} />
          <input ref={searchRef} placeholder="Find a project" value={query} onChange={(e) => setQuery(e.target.value)} />
          {query && (
            <button className="icon-btn small" onClick={() => setQuery('')}>
              <X size={13} />
            </button>
          )}
        </div>
        <button className={`icon-btn ${chatOpen ? 'on' : ''}`} onClick={() => toggleChat()} title="Assistant (Ctrl+K)">
          <Sparkles size={16} />
          {chat?.busy && <span className="busy-dot" />}
        </button>
        <button className="refresh-btn" onClick={refresh} title="Refresh now">
          <RefreshCw size={14} className={refreshing || snap.scanning ? 'spin' : ''} />
          <span>{refreshing || snap.scanning ? 'Refreshing…' : `Updated ${timeAgo(snap.scannedAt)}`}</span>
        </button>
        <button className="icon-btn" onClick={() => setSettingsOpen(true)} title="Settings">
          <SettingsIcon size={16} />
        </button>
      </header>

      <div className="body">
        <main className="main">
          <div className={`column ${view !== 'list' ? 'wide' : ''}`}>
            <nav className="filters">
              {(['all', 'work', 'side'] as Filter[]).map((f) => (
                <button key={f} className={filter === f ? 'on' : ''} onClick={() => switchFilter(f)}>
                  {f === 'all' ? 'All' : f === 'work' ? 'Work' : 'Side'}
                </button>
              ))}
              <button className="new-project" onClick={() => setNewProject({})} title="A project without a folder, made from Claude sessions">
                <Plus size={14} /> Project
              </button>
              <span className="view-switch">
                <button className={view === 'list' ? 'on' : ''} onClick={() => switchView('list')} title="List">
                  <Rows3 size={15} />
                </button>
                <button className={view === 'grid' ? 'on' : ''} onClick={() => switchView('grid')} title="Grid: cards across the whole window">
                  <LayoutGrid size={15} />
                </button>
                <button className={view === 'board' ? 'on' : ''} onClick={() => switchView('board')} title="Board: every task, drag between columns">
                  <SquareKanban size={15} />
                </button>
              </span>
            </nav>

            <Today
              views={visible}
              onPick={(id) => {
                setExpanded((x) => new Set(x).add(id))
                setFocus(id)
                setTimeout(() => setFocus(null), 2000)
                if (view === 'board') switchView('list')
              }}
            />
            {view === 'board' ? (
              <Board views={visible} />
            ) : (
              <>

            {nothingRecorded && !q && (
              <p className="intro">
                Nothing recorded yet. Claude records what it did and what's still ongoing here at the end of a session (the{' '}
                <span className="mono">leftoff</span> skill), or type <span className="mono">/leftoff</span> in a session to record right away.
              </p>
            )}

            <div className={`cards ${view}`}>
              {main.map((v) => (
                <Project key={v.id} v={v} highlight={focus === v.id} flash={flash.has(v.id)} onLink={(p) => setNewProject({ project: p })} onVault={(p) => setVault({ project: p })} />
              ))}
            </div>
            {!main.length && !recent.length && !quiet.length && <p className="empty-note">No projects here.</p>}

            {recent.length > 0 && (
              <section className="fold">
                <div className="fold-head static">
                  Recent, nothing recorded <span className="count">{recent.length}</span>
                </div>
                {recent.map(row)}
              </section>
            )}

            {quiet.length > 0 && (
              <section className="fold">
                <button className="fold-head" onClick={() => setShowQuiet(!showQuiet)}>
                  Quiet <span className="count">{quiet.length}</span>
                  <ChevronDown size={14} className={showQuiet ? 'flip' : ''} />
                </button>
                {showQuiet && quiet.map(row)}
              </section>
            )}

            {hidden.length > 0 && (
              <section className="fold">
                <button className="fold-head" onClick={() => setShowHidden(!showHidden)}>
                  Hidden <span className="count">{hidden.length}</span>
                  <ChevronDown size={14} className={showHidden ? 'flip' : ''} />
                </button>
                {showHidden &&
                  hidden.map((v) => (
                    <div key={v.id} className="fold-row static">
                      <span className="fold-name">{v.name}</span>
                      <span className="fold-text" />
                      <button className="link" onClick={() => window.api.updateMeta(v.id, { hidden: false })}>
                        show
                      </button>
                    </div>
                  ))}
              </section>
            )}
              </>
            )}
          </div>
        </main>
        {chatOpen && chat && <Chat state={chat} focusKey={chatFocus} onClose={() => toggleChat(false)} />}
      </div>

      {toast && <div className="toast">{toast}</div>}
      {settingsOpen && (
        <Settings
          snap={snap}
          onClose={() => setSettingsOpen(false)}
          onOpenVault={() => {
            setSettingsOpen(false)
            setVault({})
          }}
        />
      )}
      {vault && <Vault snap={snap} project={vault.project ? views.find((x) => x.id === vault.project!.id) : undefined} onClose={() => setVault(null)} />}
      {newProject && <NewProject sessions={snap.unassigned} project={newProject.project} onClose={() => setNewProject(null)} />}
    </div>
  )
}
