import { timeAgo } from './time'

// A thread is one piece of work in a project — a feature, a bug hunt, a side quest.
// One is active at a time; switching parks the active one with the reason, so getting
// sidetracked leaves a trail back. The app and the `leftoff` CLI (used by Claude) both
// change threads through applyThreadAction.

export type ThreadStatus = 'active' | 'paused' | 'done' // active = ongoing
export type Actor = 'you' | 'claude'
export type Priority = 'high' | 'low'

export interface ThreadEvent {
  at: number
  by: Actor
  text: string
}

export interface Thread {
  id: string
  title: string
  status: ThreadStatus
  priority?: Priority // unset counts as low
  note: string // where it stands
  next: string
  reason: string // why it was paused
  branch: string
  sessionId: string // Claude session that last worked on it
  by: Actor
  createdAt: number
  updatedAt: number
  history: ThreadEvent[]
}

export interface ThreadCtx {
  by: Actor
  now: number
  branch?: string
  sessionId?: string
}

export type ThreadAction =
  | { type: 'start'; title: string; note?: string; next?: string; reason?: string }
  | { type: 'add'; title: string; note?: string; status: 'active' | 'paused'; priority?: Priority; alongside?: boolean; branch?: string; sessionId?: string }
  | { type: 'update'; id?: string; title?: string; note?: string; next?: string; priority?: Priority }
  // The board: put a task in a column. Unlike start/resume it leaves other ongoing tasks be.
  | { type: 'move'; id: string; status: ThreadStatus; priority?: Priority }
  | { type: 'park'; id?: string; reason?: string; note?: string; next?: string }
  | { type: 'resume'; id: string; reason?: string }
  | { type: 'done'; id?: string; note?: string }
  | { type: 'delete'; id: string }

const HISTORY_CAP = 30
const DONE_CAP = 20

function newId(list: Thread[]): string {
  let id: string
  do id = Math.random().toString(36).slice(2, 6)
  while (list.some((t) => t.id === id))
  return id
}

function log(t: Thread, ctx: ThreadCtx, text: string): void {
  t.history = [{ at: ctx.now, by: ctx.by, text }, ...t.history].slice(0, HISTORY_CAP)
}

function touch(t: Thread, ctx: ThreadCtx): void {
  t.updatedAt = ctx.now
  t.by = ctx.by
  if (ctx.branch) t.branch = ctx.branch
  if (ctx.sessionId) t.sessionId = ctx.sessionId
}

function parkActive(list: Thread[], ctx: ThreadCtx, reason: string): void {
  const a = list.find((t) => t.status === 'active')
  if (!a) return
  a.status = 'paused'
  a.reason = reason
  a.updatedAt = ctx.now
  log(a, ctx, `Paused: ${reason}`)
}

function create(list: Thread[], ctx: ThreadCtx, title: string, status: ThreadStatus, note = '', next = ''): Thread {
  return {
    id: newId(list), title, status, note, next, reason: '',
    branch: ctx.branch ?? '', sessionId: ctx.sessionId ?? '', by: ctx.by,
    createdAt: ctx.now, updatedAt: ctx.now, history: []
  }
}

export function applyThreadAction(input: Thread[], action: ThreadAction, ctx: ThreadCtx): { list: Thread[]; thread: Thread } {
  const list: Thread[] = structuredClone(input)
  const active = (): Thread | undefined => list.find((t) => t.status === 'active')
  const byId = (id?: string): Thread | undefined => {
    if (!id) return undefined
    const t = list.find((x) => x.id === id)
    if (!t) throw new Error(`No thread with id ${id}`)
    return t
  }
  let thread: Thread

  switch (action.type) {
    case 'start':
    case 'add': {
      const title = action.title.trim()
      if (!title) throw new Error('A thread needs a title')
      const status = action.type === 'start' ? 'active' : action.status
      const alongside = action.type === 'add' && action.alongside
      if (status === 'active' && !alongside) parkActive(list, ctx, (action.type === 'start' && action.reason?.trim()) || `switched to "${title}"`)
      const actx = action.type === 'add' ? { ...ctx, branch: action.branch ?? ctx.branch, sessionId: action.sessionId ?? ctx.sessionId } : ctx
      thread = create(list, actx, title, status, action.note?.trim(), action.type === 'start' ? action.next?.trim() : '')
      if (action.type === 'add' && action.priority) thread.priority = action.priority
      log(thread, actx, thread.note ? `Started: ${thread.note}` : 'Started')
      list.unshift(thread)
      break
    }
    case 'update': {
      const t = byId(action.id) ?? active()
      if (!t) throw new Error('No active thread to update. Start one with `leftoff start "<title>"`')
      if (action.title?.trim()) t.title = action.title.trim()
      if (action.note !== undefined && action.note.trim() !== t.note) {
        t.note = action.note.trim()
        if (t.note) log(t, ctx, t.note)
      }
      if (action.next !== undefined) t.next = action.next.trim()
      if (action.priority) t.priority = action.priority
      touch(t, ctx)
      thread = t
      break
    }
    case 'move': {
      const t = byId(action.id)!
      t.status = action.status
      if (action.priority) t.priority = action.priority
      t.reason = ''
      touch(t, ctx)
      const where = action.status === 'done' ? 'Done' : action.status === 'active' ? 'Ongoing' : `${t.priority === 'high' ? 'High' : 'Low'} priority`
      log(t, ctx, `Moved to ${where}`)
      thread = t
      break
    }
    case 'park': {
      const t = byId(action.id) ?? active()
      if (!t) throw new Error('No active thread to park')
      if (action.note !== undefined) t.note = action.note.trim()
      if (action.next !== undefined) t.next = action.next.trim()
      t.status = 'paused'
      t.reason = action.reason?.trim() ?? ''
      touch(t, ctx)
      log(t, ctx, t.reason ? `Paused: ${t.reason}` : 'Paused')
      thread = t
      break
    }
    case 'resume': {
      const t = byId(action.id)!
      if (t.status !== 'active') {
        parkActive(list, ctx, action.reason?.trim() || `went back to "${t.title}"`)
        t.status = 'active'
        t.reason = ''
        touch(t, ctx)
        log(t, ctx, 'Picked back up')
      }
      thread = t
      break
    }
    case 'done': {
      const t = byId(action.id) ?? active()
      if (!t) throw new Error('No active thread to finish')
      if (action.note?.trim()) t.note = action.note.trim()
      t.status = 'done'
      t.reason = ''
      touch(t, ctx)
      log(t, ctx, action.note?.trim() ? `Done: ${action.note.trim()}` : 'Done')
      thread = t
      break
    }
    case 'delete': {
      const i = list.findIndex((t) => t.id === action.id)
      if (i < 0) throw new Error(`No thread with id ${action.id}`)
      thread = list.splice(i, 1)[0]
      break
    }
  }

  const done = list.filter((t) => t.status === 'done').sort((a, b) => b.updatedAt - a.updatedAt)
  const dropped = new Set(done.slice(DONE_CAP).map((t) => t.id))
  return { list: list.filter((t) => !dropped.has(t.id)), thread }
}

const RANK: Record<ThreadStatus, number> = { active: 0, paused: 1, done: 2 }

export function sortThreads(list: Thread[]): Thread[] {
  return [...list].sort((a, b) => RANK[a.status] - RANK[b.status] || b.updatedAt - a.updatedAt)
}

// Resolves what someone typed — an id, an id prefix, or part of a title.
export function findThread(list: Thread[], ref: string): Thread {
  const q = ref.trim().toLowerCase()
  const exact = list.find((t) => t.id === q)
  if (exact) return exact
  const byPrefix = list.filter((t) => t.id.startsWith(q))
  if (byPrefix.length === 1) return byPrefix[0]
  const byTitle = sortThreads(list).filter((t) => t.title.toLowerCase().includes(q))
  const open = byTitle.filter((t) => t.status !== 'done')
  const pool = open.length ? open : byTitle
  if (pool.length === 1) return pool[0]
  if (!pool.length) throw new Error(`No thread matches "${ref}"`)
  throw new Error(`"${ref}" matches several threads: ${pool.map((t) => `[${t.id}] ${t.title}`).join(', ')}`)
}

// ─── Session log ────────────────────────────────────────────────────────────

// "What you did last session": one entry per Claude session (re-recording in the same
// session replaces it), or one per manual note.
export interface LogEntry {
  id: string
  at: number
  by: Actor
  text: string
  sessionId: string
  branch: string
  auto?: boolean // written by the automatic recorder after the session, not by Claude in it
}

const LOG_CAP = 100

export function recordSession(input: LogEntry[], text: string, ctx: ThreadCtx & { auto?: boolean }): { list: LogEntry[]; entry: LogEntry } {
  const t = text.trim()
  if (!t) throw new Error('Say what got done: leftoff did "<summary>"')
  const list = [...input]
  const i = ctx.sessionId ? list.findIndex((e) => e.sessionId === ctx.sessionId) : -1
  const entry: LogEntry = {
    id: i >= 0 ? list[i].id : Math.random().toString(36).slice(2, 8),
    at: ctx.now,
    by: ctx.by,
    text: t,
    sessionId: ctx.sessionId ?? '',
    branch: ctx.branch ?? '',
    ...(ctx.auto ? { auto: true } : {})
  }
  if (i >= 0) list.splice(i, 1)
  list.push(entry)
  // Newest first by when the work happened (an automatic entry is dated to the session's end).
  list.sort((a, b) => b.at - a.at)
  return { list: list.slice(0, LOG_CAP), entry }
}

export function describeProject(project: string, threads: Thread[], log: LogEntry[], now = Date.now()): string {
  const sorted = sortThreads(threads)
  const open = sorted.filter((t) => t.status !== 'done')
  const done = sorted.filter((t) => t.status === 'done').slice(0, 3)
  const lines = [`Left Off · ${project}`]
  const last = log[0]
  lines.push(last ? `Last session (${timeAgo(last.at, now)}, ${last.by === 'claude' ? 'Claude' : 'you'}): ${last.text}` : 'Last session: nothing recorded yet')
  if (log[1]) lines.push(`Session before (${timeAgo(log[1].at, now)}): ${log[1].text}`)
  if (open.length) {
    lines.push('Ongoing tasks:')
    for (const t of open) {
      const flags = [t.status === 'active' && 'ongoing', t.priority === 'high' && 'high priority', t.reason && `paused: ${t.reason}`].filter(Boolean).join('; ')
      lines.push(`  [${t.id}] ${t.title}${flags ? `  (${flags})` : ''}`)
      if (t.note) lines.push(`    ${t.note}`)
      if (t.next) lines.push(`    Next: ${t.next}`)
    }
  } else lines.push('Ongoing tasks: none')
  if (done.length) lines.push(`Recently done: ${done.map((t) => `${t.title} (${timeAgo(t.updatedAt, now)})`).join(', ')}`)
  return lines.join('\n')
}
