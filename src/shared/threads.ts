import { timeAgo } from './time'

// A thread is one piece of work in a project — a feature, a bug hunt, a side quest.
// One is active at a time; switching parks the active one with the reason, so getting
// sidetracked leaves a trail back. The app and the `leftoff` CLI (used by Claude) both
// change threads through applyThreadAction.

export type ThreadStatus = 'active' | 'paused' | 'done' // active = ongoing
export type Actor = 'you' | 'claude'
// Which coding agent wrote something, when one did. `by` stays what it always was (the app
// and anything syncing the data file read it); this says which of the user's agents it actually was, so a
// session started in one can tell what another left behind.
export type Agent = 'claude' | 'codex' | 'kimi'
export const AGENT_NAME: Record<Agent, string> = { claude: 'Claude', codex: 'Codex', kimi: 'Kimi' }
/** Who to name for an entry: the agent if one wrote it, else Claude or you. */
export const whoLabel = (e: { by: Actor; agent?: Agent }): string => (e.agent ? AGENT_NAME[e.agent] : e.by === 'claude' ? 'Claude' : 'you')
export type Priority = 'high' | 'low'
// What sort of task it is. Work is committed; waiting is blocked on someone else; check
// is done but needs a look; idea is a suggestion nobody committed to. Unset counts as work.
// A tool that syncs the data file elsewhere (a team board, say) can set it too.
export type Kind = 'work' | 'waiting' | 'check' | 'idea'
export const KINDS: Kind[] = ['work', 'waiting', 'check', 'idea']

export interface ThreadEvent {
  at: number
  by: Actor
  agent?: Agent
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
  sessionId: string // the agent session that last worked on it
  by: Actor
  agent?: Agent // the agent that last touched it; unset when you did
  dir?: string // the folder the work is in when that isn't the project's own (a worktree)
  createdAt: number
  updatedAt: number
  history: ThreadEvent[]
  // Planning. planAt is when it last changed, so a tool syncing it elsewhere can let the newer side win.
  due?: string // YYYY-MM-DD
  kind?: Kind
  goal?: string // the goal's title
  planAt?: number
}

export interface ThreadCtx {
  by: Actor
  now: number
  branch?: string
  sessionId?: string
  agent?: Agent
  dir?: string // '' = the project's own folder; unset = not known, leave what's recorded
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
  // Due date, label and goal. null clears a field; absent leaves it.
  | { type: 'plan'; id: string; due?: string | null; kind?: Kind; goal?: string | null }

const HISTORY_CAP = 30
const DONE_CAP = 20

function newId(list: Thread[]): string {
  let id: string
  do id = Math.random().toString(36).slice(2, 6)
  while (list.some((t) => t.id === id))
  return id
}

function log(t: Thread, ctx: ThreadCtx, text: string): void {
  t.history = [{ at: ctx.now, by: ctx.by, ...(ctx.agent ? { agent: ctx.agent } : {}), text }, ...t.history].slice(0, HISTORY_CAP)
}

function touch(t: Thread, ctx: ThreadCtx): void {
  t.updatedAt = ctx.now
  t.by = ctx.by
  if (ctx.agent) t.agent = ctx.agent
  else delete t.agent
  if (ctx.branch) t.branch = ctx.branch
  if (ctx.sessionId) t.sessionId = ctx.sessionId
  if (ctx.dir) t.dir = ctx.dir
  else if (ctx.dir === '') delete t.dir
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
    ...(ctx.agent ? { agent: ctx.agent } : {}),
    ...(ctx.dir ? { dir: ctx.dir } : {}),
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
    case 'plan': {
      const t = byId(action.id)!
      const said: string[] = []
      if (action.due !== undefined && (action.due || undefined) !== t.due) {
        if (action.due && !/^\d{4}-\d{2}-\d{2}$/.test(action.due)) throw new Error('A due date looks like 2026-11-20')
        said.push(action.due ? (t.due ? `Due date moved ${t.due} → ${action.due}` : `Due ${action.due}`) : 'Due date cleared')
        t.due = action.due || undefined
      }
      if (action.kind !== undefined && action.kind !== (t.kind ?? 'work')) {
        t.kind = action.kind
        said.push(`Marked ${action.kind === 'check' ? 'to check' : action.kind}`)
      }
      if (action.goal !== undefined && (action.goal || undefined) !== t.goal) {
        t.goal = action.goal?.trim() || undefined
        said.push(t.goal ? `Goal: ${t.goal}` : 'Goal cleared')
      }
      t.planAt = ctx.now
      if (said.length) {
        t.updatedAt = ctx.now
        log(t, ctx, said.join('; '))
      }
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

// ─── The board ──────────────────────────────────────────────────────────────

// Where a task is: four columns. Priority is a flag
// (priority === 'high'), not a column.
export type Column = 'todo' | 'doing' | 'waiting' | 'done'
export const COLUMNS: { id: Column; title: string }[] = [
  { id: 'todo', title: 'To do' },
  { id: 'doing', title: 'Doing' },
  { id: 'waiting', title: 'Waiting' },
  { id: 'done', title: 'Done' }
]

export function columnOf(t: Thread): Column {
  if (t.status === 'done') return 'done'
  if (t.kind === 'waiting') return 'waiting'
  return t.status === 'active' ? 'doing' : 'todo'
}

/** The actions that put a task in a column (a status move, and the label for Waiting). */
export function actionsToColumn(t: Thread, to: Column): ThreadAction[] {
  const out: ThreadAction[] = []
  if (to === 'waiting') {
    if (t.status !== 'paused') out.push({ type: 'move', id: t.id, status: 'paused' })
    out.push({ type: 'plan', id: t.id, kind: 'waiting' })
    return out
  }
  if (t.kind === 'waiting') out.push({ type: 'plan', id: t.id, kind: 'work' })
  const status: ThreadStatus = to === 'doing' ? 'active' : to === 'done' ? 'done' : 'paused'
  if (status !== t.status) out.push({ type: 'move', id: t.id, status })
  return out
}

/** Open and committed: not done, not an idea. */
export const isOpen = (t: Thread): boolean => t.status !== 'done' && t.kind !== 'idea'

/** Overdue first, then soonest due, then flagged, then most recently touched. */
export function byUrgency(a: Thread, b: Thread): number {
  return (
    (a.due ?? '9999').localeCompare(b.due ?? '9999') ||
    Number(b.priority === 'high') - Number(a.priority === 'high') ||
    b.updatedAt - a.updatedAt
  )
}

/** Today in the user's time zone, as YYYY-MM-DD. */
export function todayYmd(now = Date.now()): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function dueLabel(due: string, today = todayYmd()): string {
  const n = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
  if (n === 0) return 'due today'
  if (n === 1) return 'due tomorrow'
  if (n < 0) return `${-n} day${n === -1 ? '' : 's'} late`
  if (n < 7) return `due in ${n} days`
  return `due ${new Date(`${due}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`
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
  agent?: Agent // the agent whose session this was
  dir?: string // the folder it worked in when that isn't the project's own (a worktree)
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
    ...(ctx.agent ? { agent: ctx.agent } : {}),
    ...(ctx.dir ? { dir: ctx.dir } : {}),
    ...(ctx.auto ? { auto: true } : {})
  }
  if (i >= 0) list.splice(i, 1)
  list.push(entry)
  // Newest first by when the work happened (an automatic entry is dated to the session's end).
  list.sort((a, b) => b.at - a.at)
  return { list: list.slice(0, LOG_CAP), entry }
}

// Chats recorded within a few hours of the latest one were likely running side by side, so
// they all count as the last session (up to three).
const SIDE_BY_SIDE = 6 * 3600_000
export function latestChats(log: LogEntry[]): LogEntry[] {
  return log.filter((e) => log[0].at - e.at < SIDE_BY_SIDE).slice(0, 3)
}

const HOME_RE = /^(\/var)?\/home\/[^/]+/
/** A path the way people write it: ~/code/app. */
export const tidyPath = (p: string): string => p.replace(HOME_RE, '~')

/** Where a piece of work is: its branch and, when it isn't the project's own folder, the folder. */
export function whereLabel(e: { branch?: string; dir?: string }): string {
  return [e.branch && `branch ${e.branch}`, e.dir && `in ${tidyPath(e.dir)}`].filter(Boolean).join(' ')
}

export function describeProject(project: string, threads: Thread[], log: LogEntry[], now = Date.now()): string {
  const sorted = sortThreads(threads)
  const open = sorted.filter((t) => t.status !== 'done')
  const done = sorted.filter((t) => t.status === 'done').slice(0, 3)
  const lines = [`Left Off · ${project}`]
  const last = log[0]
  const from = (e: LogEntry): string => [timeAgo(e.at, now), whoLabel(e), whereLabel(e)].filter(Boolean).join(', ')
  lines.push(last ? `Last session (${from(last)}): ${last.text}` : 'Last session: nothing recorded yet')
  const latest = latestChats(log)
  for (const e of latest.slice(1)) lines.push(`Also recent (${from(e)}, another chat): ${e.text}`)
  if (latest.length < 2 && log[1]) lines.push(`Session before (${from(log[1])}): ${log[1].text}`)
  // The brief is read at the start of every session, so it carries what matters now
  // (doing, waiting, flagged, dated) in full and the rest of the backlog as a count.
  const today = todayYmd(now)
  const soon = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10)
  const line = (t: Thread, withNote: boolean): void => {
    const flags = [
      t.priority === 'high' && 'flagged',
      t.due && dueLabel(t.due, today),
      t.goal && `goal: ${t.goal}`,
      t.kind === 'check' && 'needs a check',
      t.reason && `paused: ${t.reason}`
    ].filter(Boolean)
    lines.push(`  [${t.id}] ${t.title}${flags.length ? `  (${flags.join('; ')})` : ''}`)
    if (withNote && t.note) lines.push(`    ${t.note.length > 300 ? `${t.note.slice(0, 300)}… (rest: \`leftoff show ${t.id}\`)` : t.note}`)
    if (withNote && t.next) lines.push(`    Next: ${t.next}`)
    // For work in progress: who has it and where, so a session started in another agent
    // (or another chat) knows whether it's theirs to continue and which folder to open.
    if (withNote && t.status === 'active') {
      const where = whereLabel(t)
      lines.push(`    Last touched ${timeAgo(t.updatedAt, now)} by ${whoLabel(t)}${where ? `, ${where}` : ''}`)
    }
  }
  const doing = open.filter((t) => t.status === 'active' && t.kind !== 'waiting').sort(byUrgency)
  const waiting = open.filter((t) => t.kind === 'waiting').sort(byUrgency)
  const todo = open.filter((t) => t.status !== 'active' && t.kind !== 'waiting' && t.kind !== 'idea').sort(byUrgency)
  const urgent = todo.filter((t) => t.priority === 'high' || (t.due && t.due <= soon) || t.kind === 'check')
  const rest = todo.filter((t) => !urgent.includes(t))
  const ideas = open.filter((t) => t.kind === 'idea')
  if (!open.length) lines.push('Open tasks: none')
  if (doing.length) {
    lines.push('Doing:')
    doing.forEach((t) => line(t, true))
  }
  if (urgent.length) {
    lines.push('Up next (flagged, due within a week, or needing a check):')
    urgent.forEach((t) => line(t, true))
  }
  if (waiting.length) {
    lines.push('Waiting on someone else:')
    waiting.forEach((t) => line(t, false))
  }
  if (rest.length) {
    lines.push('Also to do:')
    rest.slice(0, 12).forEach((t) => line(t, false))
    if (rest.length > 12) lines.push(`  …and ${rest.length - 12} more (\`leftoff status --all\` lists everything)`)
  }
  if (ideas.length) lines.push(`Ideas nobody committed to: ${ideas.length} (not work; \`leftoff status --all\` lists them)`)
  if (done.length) lines.push(`Recently done: ${done.map((t) => `${t.title} (${timeAgo(t.updatedAt, now)})`).join(', ')}`)
  return lines.join('\n')
}
