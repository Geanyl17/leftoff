import { defaultMeta, type Connection, type ProjectMeta, type ProjectScan, type SecretRef, type Snapshot } from '@shared/types'
import { daysSince } from '@shared/time'
import { latestChats, sortThreads, type LogEntry, type Thread } from '@shared/threads'

export interface ProjectView {
  id: string
  p: ProjectScan
  m: ProjectMeta
  name: string
  log: LogEntry[]
  latest: LogEntry[] // the last session, plus other chats recorded around the same time
  tasks: Thread[] // ongoing: the current one first
  done: Thread[]
  // Shown when nothing has been recorded yet.
  fallback: { label: string; text: string; at: number } | null
  touched: number
  branch: string
  dirty: number
  ahead: number
  servers: Connection[]
  secrets: SecretRef[]
  recorded: boolean // has ongoing tasks or a recent session entry: gets a full block
  quiet: boolean // nothing recorded and untouched for two weeks (or parked)
}

export function buildViews(s: Snapshot): ProjectView[] {
  return s.projects.map((p) => {
    const m = { ...defaultMeta(), ...s.meta[p.id] }
    const log = s.log[p.id] ?? []
    const all = sortThreads(s.threads[p.id] ?? [])
    // Ongoing first, then high priority, then the rest; newest first within each.
    const rank = (t: Thread): number => (t.status === 'active' ? 0 : t.priority === 'high' ? 1 : 2)
    const tasks = all.filter((t) => t.status !== 'done').sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
    const done = all.filter((t) => t.status === 'done')
    const session = p.sessions[0]
    const commit = p.repos.flatMap((r) => r.commits.slice(0, 1)).sort((a, b) => b.time - a.time)[0]
    const fallback = session?.title
      ? { label: 'Claude session', text: session.title, at: session.updated }
      : commit
        ? { label: 'Last commit', text: commit.subject, at: commit.time }
        : null
    const touched = Math.max(p.lastTouched, log[0]?.at ?? 0, ...all.map((t) => t.updatedAt))
    const recorded = !!tasks.length || daysSince(log[0]?.at ?? 0) < 30
    const parked = m.status === 'paused' || m.status === 'shipped'
    return {
      id: p.id,
      p,
      m,
      name: m.alias || p.name,
      log,
      latest: latestChats(log),
      tasks,
      done,
      fallback,
      touched,
      branch: p.repos[0]?.branch ?? '',
      dirty: p.repos.reduce((n, r) => n + r.staged + r.changed + r.untracked + r.conflicted, 0),
      ahead: p.repos.reduce((n, r) => n + r.ahead, 0),
      servers: Object.values(s.connections).filter((c) => c.project === p.id),
      secrets: Object.values(s.secrets).filter((x) => x.project === p.id),
      recorded,
      quiet: !m.pinned && (parked || (!recorded && daysSince(touched) >= 14))
    }
  })
}
