import type { ProjectMeta, ProjectScan } from '@shared/types'
import { describeProject, type LogEntry, type Thread } from '@shared/threads'
import { timeAgo } from '@shared/time'

export interface ProjectFacts {
  project: ProjectScan
  meta: ProjectMeta
  threads: Thread[]
  log: LogEntry[]
}

// Everything known about one project as plain text, for the in-app assistant.
export function facts({ project, meta, threads, log }: ProjectFacts): string {
  const name = meta.alias || project.name
  const lines = [`Project: ${name} (${meta.category}, ${meta.status}) at ${project.path}`]
  lines.push(describeProject(name, threads, log).split('\n').slice(1).join('\n'))
  for (const e of log.slice(2, 6)) lines.push(`Earlier session (${timeAgo(e.at)}): ${e.text}`)

  for (const r of project.repos) {
    lines.push('')
    lines.push(`Repo ${r.rel || name}: branch ${r.branch}${r.upstream ? ` (tracking ${r.upstream}, ${r.ahead} ahead, ${r.behind} behind)` : ' (no upstream)'}`)
    if (r.operation) lines.push(`  A ${r.operation} is in progress.`)
    const dirty = r.staged + r.changed + r.untracked + r.conflicted
    if (dirty) {
      lines.push(`  ${dirty} uncommitted changes, oldest edited ${timeAgo(r.oldestDirty ?? 0)}:`)
      for (const f of r.dirtyFiles.slice(0, 25)) lines.push(`    ${f}`)
    }
    lines.push('  Recent commits:')
    for (const c of r.commits.slice(0, 8)) lines.push(`    ${timeAgo(c.time)}${c.mine ? '' : ` by ${c.author}`}: ${c.subject}`)
  }

  if (project.sessions.length) {
    lines.push('')
    lines.push('Claude Code sessions, newest first:')
    for (const s of project.sessions.slice(0, 5)) {
      lines.push(`  ${timeAgo(s.updated)} "${s.title || 'untitled'}" (${s.prompts} prompts)`)
      if (s.lastPrompt) lines.push(`    last prompt: ${s.lastPrompt.replace(/\s+/g, ' ').slice(0, 300)}`)
    }
  }

  if (project.todos.length) {
    lines.push('')
    lines.push('Open checklist items in planning docs:')
    for (const t of project.todos.slice(0, 15)) lines.push(`  [ ] ${t.text} (${t.file})`)
  }
  return lines.join('\n')
}
