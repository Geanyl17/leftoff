import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Check, Flag, Plus } from 'lucide-react'
import { timeAgo } from '@shared/time'
import {
  COLUMNS,
  KINDS,
  actionsToColumn,
  byUrgency,
  columnOf,
  dueLabel,
  todayYmd,
  type Column,
  type Kind,
  type Thread,
  type ThreadAction
} from '@shared/threads'
import type { ProjectView } from '../lib/view'

// Every project's tasks on one board, in four columns:
// To do, Doing, Waiting, Done. Priority is a flag on the card, not a column. Each column
// is sorted overdue first, then by due date, then flagged. Ideas stay out of the way.

const DONE_DAYS = 7 // older finished tasks drop off the board (still in each project's history)
const KIND_LABEL: Record<Kind, string> = { work: 'Work', waiting: 'Waiting on someone', check: 'Needs a check', idea: 'Idea' }

interface Card {
  t: Thread
  v: ProjectView
  key: string
}

async function runAll(projectId: string, actions: ThreadAction[]): Promise<string> {
  for (const a of actions) {
    const res = await window.api.thread(projectId, a)
    if (!res.ok) return res.error ?? 'Something went wrong'
  }
  return ''
}

function TaskCard({
  card,
  editing,
  setEditing,
  onMenu,
  onError,
  showProject
}: {
  card: Card
  editing: boolean
  setEditing: (on: boolean) => void
  onMenu: (x: number, y: number) => void
  onError: (e: string) => void
  showProject: boolean
}) {
  const { t, v } = card
  const [title, setTitle] = useState(t.title)
  const [note, setNote] = useState(t.note)
  const [due, setDue] = useState(t.due ?? '')
  const [kind, setKind] = useState<Kind>(t.kind ?? 'work')
  const [dragging, setDragging] = useState(false)
  const col = columnOf(t)
  const today = todayYmd()
  const late = Boolean(t.due && t.due < today && col !== 'done')

  if (editing) {
    const save = async (): Promise<void> => {
      const actions: ThreadAction[] = [{ type: 'update', id: t.id, title, note }]
      if ((due || undefined) !== t.due || kind !== (t.kind ?? 'work')) actions.push({ type: 'plan', id: t.id, due: due || null, kind })
      onError(await runAll(v.id, actions))
      setEditing(false)
    }
    return (
      <div className="ticket editing">
        <input className="input" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void save()} />
        <textarea className="input" rows={4} placeholder="Where it stands, what's next" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="ticket-fields">
          <label>
            Due
            <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
          <label>
            Kind
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row-actions">
          <button className="btn primary" onClick={() => void save()}>Save</button>
          <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
          <button
            className={`btn ${t.priority === 'high' ? 'flagged' : ''}`}
            onClick={async () => onError(await runAll(v.id, [{ type: 'update', id: t.id, priority: t.priority === 'high' ? 'low' : 'high' }]))}
          >
            <Flag size={13} /> {t.priority === 'high' ? 'Flagged' : 'Flag'}
          </button>
          <button className="btn danger" onClick={async () => onError(await runAll(v.id, [{ type: 'delete', id: t.id }]))}>
            Delete
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`ticket ${dragging ? 'dragging' : ''} ${late ? 'late' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', card.key)
        e.dataTransfer.effectAllowed = 'move'
        setDragging(true)
      }}
      onDragEnd={() => setDragging(false)}
      onClick={() => setEditing(true)}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
      title={t.note || undefined}
    >
      <div className="ticket-title">
        {t.priority === 'high' && col !== 'done' && <Flag size={12} className="ticket-flag" aria-label="Flagged" />}
        {t.title}
      </div>
      <div className="ticket-foot">
        {showProject && <span className="ticket-project">{v.name}</span>}
        {col === 'done' ? (
          <span>done {timeAgo(t.updatedAt)}</span>
        ) : t.due ? (
          <span className={`ticket-due ${late ? 'late' : ''}`}>{dueLabel(t.due, today)}</span>
        ) : col === 'waiting' ? (
          <span>waiting {timeAgo(t.updatedAt)}</span>
        ) : (
          <span>{timeAgo(t.updatedAt)}</span>
        )}
        {t.kind === 'check' && col !== 'done' && <span className="ticket-kind">needs a check</span>}
      </div>
    </div>
  )
}

function TicketMenu({
  card,
  x,
  y,
  onMove,
  onFlag,
  onEdit,
  onDelete,
  onClose
}: {
  card: Card
  x: number
  y: number
  onMove: (to: Column) => void
  onFlag: () => void
  onEdit: () => void
  onDelete: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // Keep the whole menu on screen, even for a ticket at the bottom edge.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({ left: Math.min(x, window.innerWidth - width - 8), top: Math.min(y, window.innerHeight - height - 8) })
  }, [x, y])

  useEffect(() => {
    const away = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const current = columnOf(card.t)
  return (
    <div className="menu context-menu" ref={ref} style={pos}>
      <div className="menu-label">Move to</div>
      {COLUMNS.map((c) => (
        <button key={c.id} className={`menu-move col-${c.id}`} disabled={c.id === current} onClick={() => onMove(c.id)}>
          <span className="board-dot" />
          {c.title}
          {c.id === current && <Check size={13} className="menu-check" />}
        </button>
      ))}
      <hr />
      <button onClick={onFlag}>{card.t.priority === 'high' ? 'Unflag' : 'Flag as important'}</button>
      <button onClick={onEdit}>Edit</button>
      <button className="menu-danger" onClick={onDelete}>
        Delete
      </button>
    </div>
  )
}

function AddCard({ column, views, onClose, onError }: { column: Column; views: ProjectView[]; onClose: () => void; onError: (e: string) => void }) {
  const projects = [...views].sort((a, b) => b.touched - a.touched)
  const [title, setTitle] = useState('')
  const [project, setProject] = useState(projects[0]?.id ?? '')

  const add = async (): Promise<void> => {
    if (!title.trim() || !project) return
    const res = await window.api.thread(project, { type: 'add', title, status: column === 'doing' ? 'active' : 'paused', alongside: true })
    if (!res.ok) return onError(res.error ?? '')
    if (column === 'waiting' && res.thread) await window.api.thread(project, { type: 'plan', id: res.thread.id, kind: 'waiting' })
    onClose()
  }

  return (
    <div className="ticket editing">
      <input
        className="input"
        autoFocus
        placeholder="New task"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void add()
          if (e.key === 'Escape') onClose()
        }}
      />
      <select className="input" value={project} onChange={(e) => setProject(e.target.value)}>
        {projects.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
      <div className="row-actions">
        <button className="btn primary" onClick={() => void add()}>Add</button>
        <button className="btn" onClick={onClose}>Cancel</button>
      </div>
    </div>
  )
}

export function Board({ views }: { views: ProjectView[] }) {
  const [over, setOver] = useState<Column | null>(null)
  const [adding, setAdding] = useState<Column | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null)
  const [project, setProject] = useState('')
  const [showIdeas, setShowIdeas] = useState(false)
  const [error, setError] = useState('')

  const all: Card[] = views.flatMap((v) => [...v.tasks, ...v.done].map((t) => ({ t, v, key: `${v.id}\n${t.id}` })))
  const ideas = all.filter((x) => x.t.kind === 'idea' && x.t.status !== 'done').length
  const cards = all.filter((x) => (!project || x.v.id === project) && (showIdeas || x.t.kind !== 'idea' || x.t.status === 'done'))
  const inColumn = (c: Column): Card[] => {
    const items = cards.filter((x) => columnOf(x.t) === c)
    if (c === 'done')
      return items.filter((x) => Date.now() - x.t.updatedAt < DONE_DAYS * 86_400_000).sort((a, b) => b.t.updatedAt - a.t.updatedAt)
    return items.sort((a, b) => byUrgency(a.t, b.t))
  }

  const move = async (card: Card, to: Column): Promise<void> => {
    if (columnOf(card.t) === to) return
    setError(await runAll(card.v.id, actionsToColumn(card.t, to)))
  }

  const drop = (to: Column) => async (e: DragEvent) => {
    e.preventDefault()
    setOver(null)
    const card = all.find((x) => x.key === e.dataTransfer.getData('text/plain'))
    if (card) await move(card, to)
  }

  const menuCard = menu ? all.find((x) => x.key === menu.key) : undefined
  const closeMenu = (): void => setMenu(null)
  const withTasks = views.filter((v) => v.tasks.length || v.done.length)

  return (
    <>
      <div className="board-bar">
        <select className="input board-project" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">All projects</option>
          {withTasks.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        {ideas > 0 && (
          <button className="link" onClick={() => setShowIdeas(!showIdeas)}>
            {showIdeas ? 'Hide ideas' : `${ideas} idea${ideas === 1 ? '' : 's'} hidden`}
          </button>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="board">
        {COLUMNS.map((col) => {
          const items = inColumn(col.id)
          return (
            <section
              key={col.id}
              className={`board-col col-${col.id} ${over === col.id ? 'over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setOver(col.id)
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null)
              }}
              onDrop={drop(col.id)}
            >
              <header className="board-head">
                <span className="board-dot" />
                <span className="board-title">{col.title}</span>
                <span className="count">{items.length}</span>
                {col.id !== 'done' && (
                  <button className="icon-btn small" title="Add a task" onClick={() => setAdding(col.id)}>
                    <Plus size={14} />
                  </button>
                )}
              </header>
              {adding === col.id && <AddCard column={col.id} views={views} onClose={() => setAdding(null)} onError={setError} />}
              {items.map((x) => (
                <TaskCard
                  key={x.key}
                  card={x}
                  showProject={!project}
                  editing={editing === x.key}
                  setEditing={(on) => setEditing(on ? x.key : null)}
                  onMenu={(mx, my) => setMenu({ key: x.key, x: mx, y: my })}
                  onError={setError}
                />
              ))}
              {!items.length && adding !== col.id && <div className="board-empty">Drop tasks here</div>}
            </section>
          )
        })}
      </div>
      {menu && menuCard && (
        <TicketMenu
          card={menuCard}
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          onMove={(to) => {
            closeMenu()
            void move(menuCard, to)
          }}
          onFlag={async () => {
            closeMenu()
            setError(await runAll(menuCard.v.id, [{ type: 'update', id: menuCard.t.id, priority: menuCard.t.priority === 'high' ? 'low' : 'high' }]))
          }}
          onEdit={() => {
            closeMenu()
            setEditing(menuCard.key)
          }}
          onDelete={async () => {
            closeMenu()
            setError(await runAll(menuCard.v.id, [{ type: 'delete', id: menuCard.t.id }]))
          }}
        />
      )}
    </>
  )
}
