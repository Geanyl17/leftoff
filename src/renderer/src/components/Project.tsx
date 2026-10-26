import { useEffect, useRef, useState } from 'react'
import { Bot, Check, ChevronDown, CodeXml, Ellipsis, KeyRound, Pin, Plus, SquareTerminal } from 'lucide-react'
import { timeAgo } from '@shared/time'
import type { Thread, ThreadAction } from '@shared/threads'
import type { ProjectView } from '../lib/view'

function TaskRow({ t, onAct }: { t: Thread; onAct: (a: ThreadAction) => void }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(t.title)
  const [note, setNote] = useState(t.note)
  const current = t.status === 'active'

  if (editing) {
    const save = (): void => {
      onAct({ type: 'update', id: t.id, title, note })
      setEditing(false)
    }
    return (
      <li className="task editing">
        <input className="input" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
        <textarea className="input" rows={2} placeholder="Where it stands, what's next" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="row-actions">
          <button className="btn primary" onClick={save}>Save</button>
          <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
          <button className="btn danger" onClick={() => onAct({ type: 'delete', id: t.id })}>Delete</button>
        </div>
      </li>
    )
  }

  return (
    <li className={`task ${current ? 'current' : ''}`}>
      <button className="check" title="Done" onClick={() => onAct({ type: 'done', id: t.id })}>
        <Check size={11} />
      </button>
      <div className="task-body" onClick={() => setEditing(true)} title="Edit">
        <span className="task-title">{t.title}</span>
        {current && <span className="now">ongoing</span>}
        {!current && t.priority === 'high' && <span className="now high">high</span>}
        {(t.note || t.next) && (
          <span className="task-note">
            {t.note}
            {t.next && `${t.note ? ' ' : ''}Next: ${t.next}`}
          </span>
        )}
      </div>
      {!current && (
        <button className="link task-focus" onClick={() => onAct({ type: 'resume', id: t.id })}>
          make current
        </button>
      )}
    </li>
  )
}

function Menu({ v, onClose, onLink, onVault }: { v: ProjectView; onClose: () => void; onLink?: (v: ProjectView) => void; onVault?: (v: ProjectView) => void }) {
  const api = window.api
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const away = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [onClose])
  const item = (label: string, fn: () => void) => (
    <button
      onClick={() => {
        fn()
        onClose()
      }}
    >
      {label}
    </button>
  )
  return (
    <div className="menu" ref={ref}>
      {item(v.m.pinned ? 'Unpin' : 'Pin to top', () => api.updateMeta(v.id, { pinned: !v.m.pinned }))}
      {item(v.m.category === 'work' ? 'Mark as side project' : 'Mark as work', () =>
        api.updateMeta(v.id, { category: v.m.category === 'work' ? 'side' : 'work' })
      )}
      {item(v.m.hidden ? 'Show in list' : 'Hide', () => api.updateMeta(v.id, { hidden: !v.m.hidden }))}
      {onVault && item('Servers & passwords…', () => onVault(v))}
      <hr />
      {v.p.custom ? (
        <>
          {onLink && item('Link Claude sessions…', () => onLink(v))}
          {item('Bind to a folder…', () => void api.customBind(v.id))}
          {item('Remove project', () => {
            if (confirm(`Remove "${v.name}" and its recorded sessions and tasks?`)) void api.customRemove(v.id)
          })}
        </>
      ) : (
        <>
          {item('Open folder', () => api.open(v.id, 'folder'))}
          {v.p.repos.some((r) => r.remote) && item('Open on GitHub', () => api.open(v.id, 'github'))}
        </>
      )}
    </div>
  )
}

export function Project({ v, highlight, flash, onLink, onVault }: { v: ProjectView; highlight: boolean; flash?: boolean; onLink?: (v: ProjectView) => void; onVault?: (v: ProjectView) => void }) {
  const api = window.api
  const [adding, setAdding] = useState(false)
  const [newTask, setNewTask] = useState('')
  const [writing, setWriting] = useState(false)
  const [note, setNote] = useState('')
  const [history, setHistory] = useState(false)
  const [menu, setMenu] = useState(false)
  const [fullText, setFullText] = useState(false)
  const [error, setError] = useState('')
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [highlight])

  const act = async (action: ThreadAction): Promise<void> => {
    const res = await api.thread(v.id, action)
    setError(res.ok ? '' : (res.error ?? ''))
  }

  const addTask = (): void => {
    if (!newTask.trim()) return
    void act({ type: 'add', title: newTask, status: 'paused' })
    setNewTask('')
  }

  const saveNote = async (): Promise<void> => {
    if (!note.trim()) return setWriting(false)
    const res = await api.log(v.id, note)
    if (!res.ok) return setError(res.error ?? '')
    setNote('')
    setWriting(false)
  }

  const last = v.log[0]
  const session = v.p.sessions[0]
  const status = v.p.custom
    ? `no folder · ${v.p.sessions.length} Claude session${v.p.sessions.length === 1 ? '' : 's'}`
    : [v.branch, v.dirty ? `${v.dirty} uncommitted` : '', v.ahead ? `${v.ahead} unpushed` : ''].filter(Boolean).join(' · ')

  return (
    <article ref={ref} className={`project ${highlight ? 'flash' : ''} ${flash ? 'changed' : ''}`}>
      <header className="project-head">
        <h2>{v.name}</h2>
        {v.m.pinned && <Pin size={12} className="pinned" />}
        {status && <span className="project-status">{status}</span>}
        <span className="project-time">{timeAgo(v.touched)}</span>
        <div className="menu-wrap">
          <button className="icon-btn" title="More" onClick={() => setMenu(!menu)}>
            <Ellipsis size={16} />
          </button>
          {menu && <Menu v={v} onClose={() => setMenu(false)} onLink={onLink} onVault={onVault} />}
        </div>
      </header>

      <div className="label">
        Last session
        {!writing && (
          <button className="link" onClick={() => setWriting(true)}>
            write
          </button>
        )}
      </div>
      {writing ? (
        <div className="write">
          <textarea
            className="input"
            rows={3}
            autoFocus
            placeholder="What got done, and what's half-done"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="row-actions">
            <button className="btn primary" onClick={saveNote}>Save</button>
            <button className="btn" onClick={() => setWriting(false)}>Cancel</button>
          </div>
        </div>
      ) : last ? (
        <p className={`session ${fullText ? '' : 'clamped'}`} onClick={() => setFullText(!fullText)} title={fullText ? '' : 'Show all'}>
          {last.text}
          <span className="by">
            {last.auto ? 'Recorded automatically' : last.by === 'claude' ? 'Claude' : 'You'}, {timeAgo(last.at)}
          </span>
        </p>
      ) : (
        <p className="session empty">
          Nothing recorded yet.
          {v.fallback && ` ${v.fallback.label}: “${v.fallback.text}”, ${timeAgo(v.fallback.at)}.`}
        </p>
      )}

      <div className="label">Ongoing</div>
      {v.tasks.length > 0 && (
        <ul className="tasks">
          {v.tasks.map((t) => (
            <TaskRow key={`${t.id}:${t.updatedAt}`} t={t} onAct={act} />
          ))}
        </ul>
      )}
      {adding ? (
        <input
          className="input task-input"
          autoFocus
          placeholder="New task, Enter to add"
          value={newTask}
          onChange={(e) => setNewTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addTask()
            if (e.key === 'Escape') setAdding(false)
          }}
          onBlur={() => !newTask.trim() && setAdding(false)}
        />
      ) : (
        <button className="link add" onClick={() => setAdding(true)}>
          <Plus size={13} /> {v.tasks.length ? 'Add task' : 'No ongoing tasks. Add one'}
        </button>
      )}

      {error && <div className="error">{error}</div>}

      <footer className="project-foot">
        {v.p.path && (
          <>
            <button className="link" onClick={() => api.open(v.id, 'code')}>
              <CodeXml size={13} /> VS Code
            </button>
            <button className="link" onClick={() => api.open(v.id, 'terminal')}>
              <SquareTerminal size={13} /> Terminal
            </button>
          </>
        )}
        {session && (
          <button className="link" onClick={() => api.open(v.id, 'claude', session.id)} title={session.title}>
            <Bot size={13} /> Resume Claude
          </button>
        )}
        {v.servers.map((c) => (
          <button key={c.name} className="link" onClick={() => api.serverOpen(c.name)} title={`${c.user}@${c.host}`}>
            <SquareTerminal size={13} /> SSH {c.name}
          </button>
        ))}
        {v.secrets.length > 0 && onVault && (
          <button className="link" onClick={() => onVault(v)}>
            <KeyRound size={13} /> Passwords ({v.secrets.length})
          </button>
        )}
        {(v.log.length > 1 || v.done.length > 0) && (
          <button className="link history-toggle" onClick={() => setHistory(!history)}>
            History <ChevronDown size={13} className={history ? 'flip' : ''} />
          </button>
        )}
      </footer>

      {history && (
        <div className="history">
          {v.log.slice(1, 11).map((e) => (
            <div key={e.id} className="history-row">
              <span className="when">{timeAgo(e.at)}</span>
              <span>{e.text}</span>
            </div>
          ))}
          {v.done.slice(0, 8).map((t) => (
            <div key={t.id} className="history-row done">
              <span className="when">{timeAgo(t.updatedAt)}</span>
              <span>
                <Check size={12} /> {t.title}
              </span>
            </div>
          ))}
        </div>
      )}
    </article>
  )
}
