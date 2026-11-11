import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs'
import { join, sep } from 'path'
import { homedir } from 'os'

// Where people usually keep their projects. On first run, the ones that exist and hold at
// least one git repo become the project folders; otherwise the app asks.
const CANDIDATES = ['code', 'Code', 'projects', 'Projects', 'dev', 'src', 'repos', 'git', 'workspace', 'Developer', 'codingprojects', 'work']

function holdsRepos(dir: string): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && existsSync(join(dir, e.name, '.git')))
  } catch {
    return false
  }
}

export function detectRoots(): string[] {
  return CANDIDATES.map((c) => join(homedir(), c)).filter(holdsRepos)
}

const real = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

// A git worktree's main checkout: its .git is a file pointing into that repo's
// .git/worktrees/. Null for an ordinary folder or repo.
export function worktreeMain(dir: string): string | null {
  try {
    const dotGit = join(dir, '.git')
    if (!statSync(dotGit).isFile()) return null
    return readFileSync(dotGit, 'utf8').match(/gitdir:\s*(.+?)\/\.git\/worktrees\//)?.[1] ?? null
  } catch {
    return null
  }
}

function topFolder(target: string, roots: string[]): { root: string; name: string } | null {
  for (const root of roots) {
    const r = real(root)
    if (!target.startsWith(r + sep)) continue
    const name = target.slice(r.length + 1).split(sep)[0]
    if (!name || name.startsWith('.')) continue
    return { root, name }
  }
  return null
}

// Maps any folder inside a project to the id the app uses for it (root as spelled in
// settings + the top-level folder name), so symlinked spellings of home agree. A worktree
// kept beside its repo (~/code/app-hotfix for ~/code/app) is that repo's project, not one
// of its own: the app lists it that way, and agents working there must record into it.
export function projectFor(dir: string, roots: string[]): { id: string; name: string } | null {
  const top = topFolder(real(dir), roots)
  if (!top) return null
  const main = worktreeMain(join(real(top.root), top.name))
  const owner = main ? topFolder(real(main) + sep, roots) : null
  const { root, name } = owner ?? top
  return { id: join(root, name), name }
}

/** The project's own folder plus every worktree of it kept beside it in the project folders. */
export function projectDirs(projectId: string, roots: string[]): string[] {
  const dirs = [projectId]
  for (const root of roots) {
    let names: string[] = []
    try {
      names = readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) {
      const dir = join(root, name)
      if (dir === projectId || name.startsWith('.')) continue
      const main = worktreeMain(dir)
      if (main && projectFor(main + sep, roots)?.id === projectId) dirs.push(dir)
    }
  }
  return dirs
}
