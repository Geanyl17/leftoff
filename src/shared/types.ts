// Shapes shared by the main process (which scans) and the renderer (which shows).
import type { LogEntry, Thread } from './threads'

export const ACTIVITY_DAYS = 28

export type Category = 'work' | 'side'
export type Status = 'active' | 'paused' | 'blocked' | 'shipped'

// Per-day counts keyed by local date, 'YYYY-MM-DD'.
export type DayCounts = Record<string, number>

export interface Commit {
  hash: string
  time: number
  author: string
  subject: string
  mine: boolean
}

export interface BranchRef {
  name: string
  time: number
  subject: string
}

export interface Remote {
  url: string
  host: string
  owner: string
  repo: string
  web: string
}

export interface RepoState {
  path: string
  rel: string // '' when the repo is the project folder itself
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  staged: number
  changed: number
  untracked: number
  conflicted: number
  dirtyFiles: string[]
  oldestDirty: number | null // mtime of the oldest uncommitted change
  newestDirty: number | null
  stashes: number
  operation: string | null // rebase / merge / cherry-pick left half-done
  commits: Commit[]
  branches: BranchRef[]
  remote: Remote | null
  myCommitDays: DayCounts
  error?: string
}

export interface ClaudeSession {
  id: string
  dir: string // the folder the session ran in
  file: string // its transcript (JSONL)
  title: string
  firstPrompt: string
  lastPrompt: string
  started: number
  updated: number
  prompts: number
  days: DayCounts
}

export interface PlanDoc {
  name: string
  path: string
  mtime: number
  open: number
  done: number
  isPlan: boolean
}

export interface TodoItem {
  text: string
  file: string
  path: string
  line: number
}

// A project with no folder: a name plus the Claude sessions linked to it. Lives in
// threads.json so `leftoff project "<name>"` (run from inside a session) can create one.
export interface CustomProject {
  id: string // 'custom:<slug>'
  name: string
  sessions: string[] // Claude session ids
  createdAt: number
  boundTo?: string // the folder project it became (leftoff bind); its sessions stay linked
}

// An SSH server Claude can reach without being told how: `leftoff ssh <name> '<command>'`.
export interface Connection {
  name: string
  user: string
  host: string
  port?: number
  key?: string // private key path; unset means ssh's own default (agent, ~/.ssh/config)
  project?: string // project id
  note?: string
}

// A password's name; the value itself is in the system keyring.
export interface SecretRef {
  name: string
  project?: string
  note?: string
  createdAt: number
}

export interface ProjectScan {
  id: string // absolute folder path (or 'custom:<slug>'), also the key for ProjectMeta
  name: string
  path: string // '' for a project without a folder
  custom?: boolean
  repos: RepoState[]
  sessions: ClaudeSession[]
  claudeDays: DayCounts
  docs: PlanDoc[]
  todos: TodoItem[]
  folderMtime: number
  lastTouched: number
  lastTouchedBy: 'commit' | 'edit' | 'claude' | 'folder'
}

// What you did and what's ongoing live in threads.json (see ./threads) so Claude can write them too.
export interface ProjectMeta {
  alias: string
  category: Category
  status: Status
  pinned: boolean
  hidden: boolean
}

export interface Settings {
  roots: string[]
  autostart: boolean
  startHidden: boolean
  autoRecord: boolean
  opacity: number // window background, 0.6–1
  chatModel: string
}

export interface Snapshot {
  projects: ProjectScan[]
  meta: Record<string, ProjectMeta>
  threads: Record<string, Thread[]>
  log: Record<string, LogEntry[]>
  unassigned: ClaudeSession[] // recent sessions outside every project folder, to link to a project
  connections: Record<string, Connection>
  secrets: Record<string, SecretRef>
  settings: Settings
  scannedAt: number
  scanning: boolean
  errors: string[]
}

export type OpenTarget = 'code' | 'terminal' | 'folder' | 'github' | 'claude'

export function defaultMeta(): ProjectMeta {
  return {
    alias: '',
    category: 'side',
    status: 'active',
    pinned: false,
    hidden: false
  }
}

export function dayKey(ms: number): string {
  const d = new Date(ms)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function addDay(counts: DayCounts, ms: number, n = 1): void {
  const k = dayKey(ms)
  counts[k] = (counts[k] ?? 0) + n
}

// ─── In-app assistant ───────────────────────────────────────────────────────

export interface ChatAction {
  text: string
  ok: boolean
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  actions: ChatAction[]
  at: number
  undoable?: boolean
}

export interface ChatState {
  messages: ChatMessage[]
  busy: boolean
  error: string | null
  model: string
}
