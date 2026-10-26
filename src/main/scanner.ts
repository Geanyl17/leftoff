import { execFile } from 'child_process'
import { promisify } from 'util'
import { readdir, readFile, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join, relative, resolve } from 'path'
import {
  ACTIVITY_DAYS,
  addDay,
  type BranchRef,
  type ClaudeSession,
  type Commit,
  type DayCounts,
  type PlanDoc,
  type ProjectScan,
  type Remote,
  type RepoState,
  type TodoItem
} from '@shared/types'
import { scanClaudeSessions } from './claude'
import { mapLimit } from './util'
import { readData } from './threadStore'

const run = promisify(execFile)

// Folders never worth descending into when looking for nested repos or docs.
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'venv', '__pycache__',
  'backups', 'backup', 'coverage', 'videos'
])

const PLAN_RE = /(todo|roadmap|plan|backlog|pending|handoff|progress|tasks|milestone)/i
const CONTEXT_RE = /^(claude|agents|notes|status|changelog)\.md$/i
const CHECKBOX_RE = /^\s*(?:[-*+]|\d+\.)\s+\[([ xX])\]\s+(.+)$/

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], {
    // Optional locks off so a background status never fights the user's own git for index.lock.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000
  })
  return stdout
}

const quiet = (p: Promise<string>): Promise<string> => p.catch(() => '')

// ─── Discovery ──────────────────────────────────────────────────────────────

async function findRepos(dir: string, depth: number): Promise<string[]> {
  if (existsSync(join(dir, '.git'))) return [dir]
  if (depth === 0) return []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const found: string[] = []
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
    found.push(...(await findRepos(join(dir, e.name), depth - 1)))
  }
  return found
}

async function listProjectDirs(roots: string[]): Promise<string[]> {
  const dirs: string[] = []
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) dirs.push(join(root, e.name))
    }
  }
  return dirs
}

// ─── Git ────────────────────────────────────────────────────────────────────

interface StatusSummary {
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  staged: number
  changed: number
  untracked: number
  conflicted: number
  files: string[]
}

// Parses `git status --porcelain=v2 --branch -z`.
function parseStatus(out: string): StatusSummary {
  const s: StatusSummary = {
    branch: '', upstream: null, ahead: 0, behind: 0,
    staged: 0, changed: 0, untracked: 0, conflicted: 0, files: []
  }
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p) continue
    if (p.startsWith('# branch.head ')) s.branch = p.slice(14)
    else if (p.startsWith('# branch.upstream ')) s.upstream = p.slice(18)
    else if (p.startsWith('# branch.ab ')) {
      const m = p.match(/\+(\d+) -(\d+)/)
      if (m) {
        s.ahead = Number(m[1])
        s.behind = Number(m[2])
      }
    } else if (p.startsWith('1 ') || p.startsWith('2 ')) {
      const renamed = p.startsWith('2 ')
      if (p[2] !== '.') s.staged++
      if (p[3] !== '.') s.changed++
      s.files.push(p.split(' ').slice(renamed ? 9 : 8).join(' '))
      if (renamed) i++ // the next entry is the rename's original path
    } else if (p.startsWith('u ')) {
      s.conflicted++
      s.files.push(p.split(' ').slice(10).join(' '))
    } else if (p.startsWith('? ')) {
      s.untracked++
      s.files.push(p.slice(2))
    }
  }
  return s
}

export function parseRemote(url: string): Remote | null {
  const m = url
    .trim()
    .match(/^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i)
  if (!m) return null
  const [, host, owner, repo] = m
  return { url: url.trim(), host, owner, repo, web: `https://${host}/${owner}/${repo}` }
}

async function gitDir(repo: string): Promise<string> {
  const dotGit = join(repo, '.git')
  const st = await stat(dotGit)
  if (st.isDirectory()) return dotGit
  const m = (await readFile(dotGit, 'utf8')).match(/gitdir:\s*(.+)/)
  return m ? resolve(repo, m[1].trim()) : dotGit
}

async function pendingOperation(repo: string): Promise<string | null> {
  try {
    const dir = await gitDir(repo)
    if (existsSync(join(dir, 'rebase-merge')) || existsSync(join(dir, 'rebase-apply'))) return 'rebase'
    if (existsSync(join(dir, 'MERGE_HEAD'))) return 'merge'
    if (existsSync(join(dir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
    if (existsSync(join(dir, 'REVERT_HEAD'))) return 'revert'
    if (existsSync(join(dir, 'BISECT_LOG'))) return 'bisect'
  } catch {
    // unreadable .git — treat as nothing in progress
  }
  return null
}

async function dirtyTimes(repo: string, files: string[]): Promise<[number | null, number | null]> {
  let oldest: number | null = null
  let newest: number | null = null
  await mapLimit(files.slice(0, 400), 16, async (f) => {
    const st = await stat(join(repo, f)).catch(() => null)
    if (!st) return
    if (oldest === null || st.mtimeMs < oldest) oldest = st.mtimeMs
    if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs
  })
  return [oldest, newest]
}

async function scanRepo(path: string, projectPath: string): Promise<RepoState> {
  const rel = relative(projectPath, path)
  const sep = '\x1f'
  try {
    const [statusOut, logOut, activityOut, stashOut, branchOut, remoteOut, ident, operation] = await Promise.all([
      git(path, ['status', '--porcelain=v2', '--branch', '-z']),
      quiet(git(path, ['log', '-n', '12', `--format=%H${sep}%ct${sep}%an${sep}%ae${sep}%s`])),
      quiet(git(path, ['log', '--all', `--since=${ACTIVITY_DAYS + 1} days ago`, `--format=%ct${sep}%an${sep}%ae`])),
      quiet(git(path, ['stash', 'list', '--format=%gd'])),
      quiet(git(path, ['for-each-ref', '--sort=-committerdate', '--count=6',
        `--format=%(refname:short)${sep}%(committerdate:unix)${sep}%(subject)`, 'refs/heads'])),
      quiet(git(path, ['config', '--get', 'remote.origin.url'])),
      quiet(git(path, ['var', 'GIT_AUTHOR_IDENT'])),
      pendingOperation(path)
    ])

    const status = parseStatus(statusOut)
    const identMatch = ident.match(/^(.*?) <([^>]*)>/)
    const myName = identMatch?.[1] ?? ''
    const myEmail = (identMatch?.[2] ?? '').toLowerCase()
    const isMine = (name: string, email: string): boolean =>
      (!!myEmail && email.toLowerCase() === myEmail) || (!!myName && name === myName)

    const commits: Commit[] = logOut.split('\n').filter(Boolean).map((line) => {
      const [hash, ct, author, email, subject] = line.split(sep)
      return { hash, time: Number(ct) * 1000, author, subject, mine: isMine(author, email) }
    })

    const myCommitDays = {}
    for (const line of activityOut.split('\n')) {
      if (!line) continue
      const [ct, author, email] = line.split(sep)
      if (isMine(author, email)) addDay(myCommitDays, Number(ct) * 1000)
    }

    const branches: BranchRef[] = branchOut.split('\n').filter(Boolean).map((line) => {
      const [name, ct, subject] = line.split(sep)
      return { name, time: Number(ct) * 1000, subject }
    })

    let branch = status.branch
    if (branch === '(detached)') {
      branch = `detached @ ${(await quiet(git(path, ['rev-parse', '--short', 'HEAD']))).trim()}`
    }

    const [oldestDirty, newestDirty] = await dirtyTimes(path, status.files)

    return {
      path, rel, branch,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      staged: status.staged,
      changed: status.changed,
      untracked: status.untracked,
      conflicted: status.conflicted,
      dirtyFiles: status.files.slice(0, 60),
      oldestDirty, newestDirty,
      stashes: stashOut.split('\n').filter(Boolean).length,
      operation,
      commits, branches,
      remote: remoteOut.trim() ? parseRemote(remoteOut) : null,
      myCommitDays
    }
  } catch (err) {
    return {
      path, rel, branch: '?', upstream: null, ahead: 0, behind: 0,
      staged: 0, changed: 0, untracked: 0, conflicted: 0, dirtyFiles: [],
      oldestDirty: null, newestDirty: null, stashes: 0, operation: null,
      commits: [], branches: [], remote: null, myCommitDays: {},
      error: err instanceof Error ? err.message.split('\n')[0] : String(err)
    }
  }
}

// ─── Docs ───────────────────────────────────────────────────────────────────

async function scanDocs(dirs: string[], projectPath: string): Promise<{ docs: PlanDoc[]; todos: TodoItem[] }> {
  const candidates = new Set<string>()
  for (const dir of dirs) {
    for (const sub of [dir, join(dir, 'docs')]) {
      const entries = await readdir(sub, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (!e.isFile() || !/\.md$/i.test(e.name)) continue
        if (PLAN_RE.test(e.name) || CONTEXT_RE.test(e.name)) candidates.add(join(sub, e.name))
      }
    }
  }

  const docs: PlanDoc[] = []
  const openItems: (TodoItem & { mtime: number })[] = []
  for (const path of candidates) {
    const st = await stat(path).catch(() => null)
    if (!st || st.size > 2 * 1024 * 1024) continue
    const text = await readFile(path, 'utf8').catch(() => '')
    const name = relative(projectPath, path)
    const isPlan = PLAN_RE.test(name.split('/').pop() ?? '')
    let open = 0
    let done = 0
    text.split('\n').forEach((line, i) => {
      const m = line.match(CHECKBOX_RE)
      if (!m) return
      if (m[1] === ' ') {
        open++
        if (isPlan) openItems.push({ text: m[2].trim(), file: name, path, line: i + 1, mtime: st.mtimeMs })
      } else done++
    })
    docs.push({ name, path, mtime: st.mtimeMs, open, done, isPlan })
  }

  docs.sort((a, b) => b.mtime - a.mtime)
  // Items from the most recently edited plan first — that's the one being worked from.
  openItems.sort((a, b) => b.mtime - a.mtime || a.line - b.line)
  return {
    docs: docs.slice(0, 16),
    todos: openItems.slice(0, 40).map(({ mtime: _mtime, ...t }) => t)
  }
}

// ─── Projects ───────────────────────────────────────────────────────────────

async function scanProject(path: string): Promise<Omit<ProjectScan, 'sessions' | 'claudeDays'>> {
  const repoPaths = await findRepos(path, 2)
  const repos = await mapLimit(repoPaths, 3, (p) => scanRepo(p, path))
  // The repo you're working in leads, not whichever folder sorts first.
  const touched = (r: RepoState): number => Math.max(r.commits[0]?.time ?? 0, r.newestDirty ?? 0)
  repos.sort((a, b) => touched(b) - touched(a))
  const dirs = [path, ...repoPaths.filter((p) => p !== path)]
  const [{ docs, todos }, folderStat] = await Promise.all([scanDocs(dirs, path), stat(path)])

  let lastTouched = 0
  let lastTouchedBy: ProjectScan['lastTouchedBy'] = 'folder'
  for (const r of repos) {
    const commit = r.commits[0]?.time ?? 0
    if (commit > lastTouched) {
      lastTouched = commit
      lastTouchedBy = 'commit'
    }
    if ((r.newestDirty ?? 0) > lastTouched) {
      lastTouched = r.newestDirty ?? 0
      lastTouchedBy = 'edit'
    }
  }
  if (!repos.length) {
    lastTouched = Math.max(folderStat.mtimeMs, ...docs.map((d) => d.mtime))
  }

  return {
    id: path,
    name: path.split('/').pop() ?? path,
    path,
    repos,
    docs,
    todos,
    folderMtime: folderStat.mtimeMs,
    lastTouched,
    lastTouchedBy
  }
}

export async function scanProjects(roots: string[]): Promise<{ projects: ProjectScan[]; unassigned: ClaudeSession[] }> {
  const dirs = await listProjectDirs(roots)
  const scanned = await mapLimit(dirs, 4, scanProject)
  const { byProject, byId, unassigned } = await scanClaudeSessions(scanned.map((p) => ({ id: p.id, paths: [p.path, ...p.repos.map((r) => r.path)] })))

  // Folderless projects: just their linked Claude sessions.
  const allCustom = Object.values(readData().custom)
  const linked = new Set(allCustom.flatMap((c) => c.sessions))
  const custom = allCustom.filter((c) => !c.boundTo)
  const virtual: ProjectScan[] = custom.map((c) => {
    const sessions = c.sessions.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])).sort((a, b) => b.updated - a.updated)
    const claudeDays: DayCounts = {}
    for (const s of sessions) for (const [k, n] of Object.entries(s.days)) claudeDays[k] = (claudeDays[k] ?? 0) + n
    return {
      id: c.id, name: c.name, path: '', custom: true, repos: [], sessions, claudeDays, docs: [], todos: [],
      folderMtime: c.createdAt, lastTouched: Math.max(c.createdAt, sessions[0]?.updated ?? 0), lastTouchedBy: 'claude'
    }
  })

  const projects = scanned.map((p) => {
    const s = byProject.get(p.id) ?? { sessions: [], days: {} }
    const project: ProjectScan = { ...p, sessions: s.sessions, claudeDays: s.days }
    const latest = s.sessions[0]?.updated ?? 0
    if (latest > project.lastTouched) {
      project.lastTouched = latest
      project.lastTouchedBy = 'claude'
    }
    return project
  })
  // Sessions of a folderless project that has since been bound to a folder belong to that folder.
  for (const c of allCustom.filter((x) => x.boundTo)) {
    const p = projects.find((x) => x.id === c.boundTo)
    if (!p) continue
    const extra = c.sessions.flatMap((id) => (byId.has(id) && !p.sessions.some((s) => s.id === id) ? [byId.get(id)!] : []))
    p.sessions = [...p.sessions, ...extra].sort((a, b) => b.updated - a.updated).slice(0, 10)
    for (const s of extra) for (const [k, n] of Object.entries(s.days)) p.claudeDays[k] = (p.claudeDays[k] ?? 0) + n
    if ((p.sessions[0]?.updated ?? 0) > p.lastTouched) {
      p.lastTouched = p.sessions[0].updated
      p.lastTouchedBy = 'claude'
    }
  }
  return { projects: [...projects, ...virtual], unassigned: unassigned.filter((s) => !linked.has(s.id)) }
}
