import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Check, Plus } from 'lucide-react'
import { timeAgo } from '@shared/time'
import type { Thread, ThreadAction } from '@shared/threads'
import type { ProjectView } from '../lib/view'

// Every project's tasks as tickets on one board. Dragging a card between columns (or
// right-click → Move to) moves it: the priority columns hold open tasks, Ongoing is in
// progress, Done is finished.

type ColumnId = 'high' | 'low' | 'ongoing' | 'done'

const COLUMNS: { id: ColumnId; title: string }[] = [
  { id: 'high', title: 'High priority' },
  { id: 'low', title: 'Low priority' },
  { id: 'ongoing', title: 'Ongoing' },
  { id: 'done', title: 'Done' }
]

const DONE_DAYS = 7 // older finished tasks drop off the board (still in each project's history)

interface Card {
  t: Thread
  v: ProjectView
  key: string
}

const columnOf = (t: Thread): ColumnId =>
  t.status === 'done' ? 'done' : t.status === 'active' ? 'ongoing' : t.priority === 'high' ? 'high' : 'low'

function actionFor(id: string, to: ColumnId): ThreadAction {
  if (to === 'done') return { type: 'move', id, status: 'done' }
  if (to === 'ongoing') return { type: 'move', id, status: 'active' }
  return { type: 'move', id, status: 'paused', priority: to }
}

interface TicketProps {
  card: Card
  editing: boolean
  setEditing: (on: boolean) => void
  onMenu: (x: number, y: number) => void
  onError: (e: string) => void
}

function TaskCard({ card, editing, setEditing, onMenu, onError }: TicketProps) {
  const api = window.api
  const { t, v } = card
  const [title, setTitle] = useState(t.title)
  const [note, setNote] = useState(t.note)
  const [dragging, setDragging] = useState(false)

  const run = async (action: ThreadAction): Promise<void> => {
    const res = await api.thread(v.id, action)
    if (!res.ok) onError(res.error ?? '')
  }

  if (editing) {
    const save = (): void => {
      void run({ type: 'update', id: t.id, title, note })
      setEditing(false)
    }
    return (
      <div className="ticket editing">
        <input className="input" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
        <textarea className="input" rows={3} placeholder="Where it stands, what's next" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="row-actions">
          <button className="btn primary" onClick={save}>Save</button>
          <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
          <button className="btn danger" onClick={() => run({ type: 'delete', id: t.id })}>Delete</button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`ticket ${dragging ? 'dragging' : ''}`}
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
    >
      <div className="ticket-title">{t.title}</div>
      {t.note && <div className="ticket-note">{t.note}</div>}
      <div className="ticket-foot">{timeAgo(t.updatedAt)}</div>
    </div>
  )
}

interface MenuProps {
  card: Card
  x: number
  y: number
  onMove: (to: ColumnId) => void
  onEdit: () => void
  onDelete: () => void
  onClose: () => void
}

function TicketMenu({ card, x, y, onMove, onEdit, onDelete, onClose }: MenuProps) {
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
      <button onClick={onEdit}>Edit</button>
      <button className="menu-danger" onClick={onDelete}>
        Delete
      </button>
    </div>
  )
}

function AddCard({ column, views, onClose, onError }: { column: ColumnId; views: ProjectView[]; onClose: () => void; onError: (e: string) => void }) {
  const projects = [...views].sort((a, b) => b.touched - a.touched)
  const [title, setTitle] = useState('')
  const [project, setProject] = useState(projects[0]?.id ?? '')

  const add = async (): Promise<void> => {
    if (!title.trim() || !project) return
    const res = await window.api.thread(project, {
      type: 'add',
      title,
      status: column === 'ongoing' ? 'active' : 'paused',
      priority: column === 'high' ? 'high' : column === 'low' ? 'low' : undefined,
      alongside: true
    })
    if (!res.ok) return onError(res.error ?? '')
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
  const [over, setOver] = useState<ColumnId | null>(null)
  const [adding, setAdding] = useState<ColumnId | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null)
  const [error, setError] = useState('')

  const cards: Card[] = views.flatMap((v) => [...v.tasks, ...v.done].map((t) => ({ t, v, key: `${v.id}\n${t.id}` })))
  const inColumn = (c: ColumnId): Card[] =>
    cards
      .filter((x) => columnOf(x.t) === c)
      .filter((x) => c !== 'done' || Date.now() - x.t.updatedAt < DONE_DAYS * 86_400_000)
      .sort((a, b) => b.t.updatedAt - a.t.updatedAt)

  // A column's tickets under one heading per project; the project touched most recently
  // first, since the cards arrive newest first.
  const byProject = (items: Card[]): { v: ProjectView; items: Card[] }[] => {
    const groups = new Map<string, { v: ProjectView; items: Card[] }>()
    for (const x of items) {
      const g = groups.get(x.v.id) ?? { v: x.v, items: [] }
      g.items.push(x)
      groups.set(x.v.id, g)
    }
    return [...groups.values()]
  }

  const move = async (card: Card, to: ColumnId): Promise<void> => {
    if (columnOf(card.t) === to) return
    const res = await window.api.thread(card.v.id, actionFor(card.t.id, to))
    setError(res.ok ? '' : (res.error ?? ''))
  }

  const drop = (to: ColumnId) => async (e: DragEvent) => {
    e.preventDefault()
    setOver(null)
    const card = cards.find((x) => x.key === e.dataTransfer.getData('text/plain'))
    if (card) await move(card, to)
  }

  const menuCard = menu ? cards.find((x) => x.key === menu.key) : undefined
  const closeMenu = (): void => setMenu(null)

  return (
    <>
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
              {byProject(items).map((g) => (
                <div key={g.v.id} className="ticket-group">
                  <div className="group-head">
                    <span>{g.v.name}</span>
                    <span className="count">{g.items.length}</span>
                  </div>
                  {g.items.map((x) => (
                    <TaskCard
                      key={x.key}
                      card={x}
                      editing={editing === x.key}
                      setEditing={(on) => setEditing(on ? x.key : null)}
                      onMenu={(mx, my) => setMenu({ key: x.key, x: mx, y: my })}
                      onError={setError}
                    />
                  ))}
                </div>
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
          onEdit={() => {
            closeMenu()
            setEditing(menuCard.key)
          }}
          onDelete={async () => {
            closeMenu()
            const res = await window.api.thread(menuCard.v.id, { type: 'delete', id: menuCard.t.id })
            setError(res.ok ? '' : (res.error ?? ''))
          }}
        />
      )}
    </>
  )
}
