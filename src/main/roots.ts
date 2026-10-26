import { existsSync, readdirSync, realpathSync } from 'fs'
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

// Maps any folder inside a project to the id the app uses for it (root as spelled in
// settings + the top-level folder name), so symlinked spellings of home agree.
export function projectFor(dir: string, roots: string[]): { id: string; name: string } | null {
  const target = real(dir)
  for (const root of roots) {
    const r = real(root)
    if (!target.startsWith(r + sep)) continue
    const name = target.slice(r.length + 1).split(sep)[0]
    if (!name || name.startsWith('.')) continue
    return { id: join(root, name), name }
  }
  return null
}
