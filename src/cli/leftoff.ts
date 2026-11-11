import { execFileSync } from 'child_process'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { timeAgo } from '@shared/time'
import {
  AGENT_NAME,
  COLUMNS,
  KINDS,
  actionsToColumn,
  applyThreadAction,
  columnOf,
  describeProject,
  dueLabel,
  findThread,
  recordSession,
  sortThreads,
  tidyPath,
  whereLabel,
  whoLabel,
  type Agent,
  type Column,
  type Kind,
  type Priority,
  type ThreadAction,
  type ThreadCtx
} from '@shared/threads'
import { DATA_DIR, bindCustom, mergeCustom, readData, updateData, upsertCustom } from '../main/threadStore'
import { autolog } from './autolog'
import { clearSecret, lookupSecret, parseTarget, sshArgs, storeSecret } from '../main/vault'
import { spawnSync } from 'child_process'
import { detectRoots, projectDirs, projectFor } from '../main/roots'
import { detectAgent, type Who } from '../main/agent'
import { describeSession, recentSessions, resumeCommand, sessionNotes, sessionTail } from './sessions'
import { claudeSetupStatus, setupClaude } from '../main/claudeSetup'
import { resolve, sep } from 'path'
import { realpathSync } from 'fs'

const USAGE = `leftoff: record what got done and what's still ongoing (shown in the Left Off app)

  leftoff status [--all]               last session + what's open in the project you're in
  leftoff show <task>                  everything about one task: full note, next step, where the work is, history
  leftoff tail [--agent claude|codex|kimi] [--session <id>] [--list]
                                       how the last session of another agent or chat ended, from its transcript
  leftoff did "<summary>"              what got done this session (re-running replaces it)
  leftoff task "<title>" [--note ..] [--priority high|low]   add an open task
  leftoff update <task> [--note ..] [--next ..] [--title ..] [--priority high|low]
  leftoff done <task>                  mark a task finished
  leftoff start "<title>"              add a task straight into Doing
  leftoff resume <task>                put an existing task back in Doing
  leftoff drop <task>                  delete a task
  leftoff move <task> todo|doing|waiting|done   put a task in a board column
  leftoff flag <task> | unflag <task>  mark a task important (or not)
  leftoff due <task> <YYYY-MM-DD|none> set or clear a due date
  leftoff label <task> work|waiting|check|idea  what sort of task it is
  leftoff goal <task> "<goal title>"|none        file a task under a goal
  leftoff setup [--check]              connect Claude Code (command, skill, session-start hook)
  leftoff project "<name>"             track a session that isn't in a project folder
  leftoff bind <folder>                give that project its folder (e.g. after cloning its repo)
  leftoff merge <project> <into>       fold one folderless project into another
  leftoff roots                        print the project folders

  leftoff ssh <server> ['<command>']   connect to a saved server (no IP or key needed)
  leftoff server add <name> <user@host[:port]> [--key <path>] [--note ..]
  leftoff server rm <name> | leftoff servers
  leftoff secret set <name> [--note ..] save a password to the system keyring (asks for it)
  leftoff secret run VAR=<name> [..] -- <command>   use passwords without printing them
  leftoff secret get <name> | leftoff secret rm <name> | leftoff secrets

  <task> is an id or part of the title. --project <dir or name> works on another project.
  Run from a git worktree of a project, it records into that project.`

// ─── Arguments ──────────────────────────────────────────────────────────────

interface Args {
  positional: string[]
  flags: Record<string, string>
}

const SWITCHES = new Set(['all', 'dry-run', 'list', 'check'])

function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1)
      else if (SWITCHES.has(a.slice(2))) flags[a.slice(2)] = '' // takes no value, so it never swallows the next flag
      else flags[a.slice(2)] = argv[++i] ?? ''
    } else positional.push(a)
  }
  return { positional, flags }
}

// ─── Project ────────────────────────────────────────────────────────────────

function roots(): string[] {
  try {
    const config = JSON.parse(readFileSync(join(DATA_DIR, 'config.json'), 'utf8'))
    if (Array.isArray(config.settings?.roots) && config.settings.roots.length) return config.settings.roots
  } catch {
    // app hasn't written settings yet
  }
  const found = detectRoots()
  return found.length ? found : [join(homedir(), 'code')]
}

function resolveProject(dir: string): { id: string; name: string } | null {
  return projectFor(dir, roots())
}

// A project folder by its name, e.g. "portfolio" (any case).
function findFolder(name: string): { id: string; name: string } | null {
  const q = name.trim().toLowerCase()
  for (const root of roots()) {
    try {
      const hit = readdirSync(root).find((e) => e.toLowerCase() === q)
      if (hit) return projectFor(join(root, hit), roots())
    } catch {
      // a root that's gone
    }
  }
  return null
}

// A folderless project, by its name or id, or by a Claude session linked to it.
function findCustom(name?: string, sessionId?: string, raw = false): { id: string; name: string } | null {
  const custom = Object.values(readData().custom)
  const q = name?.trim().toLowerCase()
  const c =
    (q && custom.find((x) => x.id === name || x.name.toLowerCase() === q || x.id === `custom:${q}`)) ||
    (sessionId && custom.find((x) => x.sessions.includes(sessionId))) ||
    undefined
  if (!c) return null
  // Bound to a folder since: that folder's project is the one to record into.
  if (c.boundTo && !raw) return { id: c.boundTo, name: c.boundTo.split('/').pop() ?? c.name }
  return { id: c.id, name: c.name }
}

function git(dir: string, ...args: string[]): string {
  try {
    return execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim()
  } catch {
    return ''
  }
}

const currentBranch = (dir: string): string => git(dir, 'branch', '--show-current')

const real = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

// Where the work is when a command runs inside the project: the branch, and the checkout
// if it isn't the project's own folder (a worktree beside it, or a repo inside it).
// Run from somewhere else with --project, the folder says nothing about the work.
function workPlace(project: { id: string }, explicitDir?: string): { branch: string; dir?: string } {
  const cwd = process.cwd()
  if (project.id.startsWith('custom:') || resolveProject(cwd)?.id !== project.id) {
    return { branch: explicitDir ? currentBranch(explicitDir) : '' }
  }
  const top = git(cwd, 'rev-parse', '--show-toplevel')
  return { branch: currentBranch(cwd), dir: top && real(top) !== real(project.id) ? top : '' }
}

/** Every folder a project's sessions may have run in: its own and its worktrees. */
const sessionDirs = (project: { id: string }): string[] => (project.id.startsWith('custom:') ? [] : projectDirs(project.id, roots()))

/** The brief: the project's records, plus what other agents' sessions are doing or left unrecorded. */
function brief(project: { id: string; name: string }, self: Who): string {
  const d = readData()
  const log = d.log[project.id] ?? []
  const lines = describeProject(project.name, d.threads[project.id] ?? [], log).split('\n')
  // Straight after the session lines, where a reader looks for "what happened last".
  const at = lines.findIndex((l, i) => i > 0 && !/^(Last session|Also recent|Session before)/.test(l))
  lines.splice(at < 0 ? lines.length : at, 0, ...sessionNotes(sessionDirs(project), log, self))
  return lines.join('\n')
}

// ─── Servers & passwords ────────────────────────────────────────────────────

// What every session is told, so the user never has to paste an IP, a key path or a
// password into a prompt. Names and hosts only: password values stay in the keyring.
function accessNote(d: ReturnType<typeof readData>): string {
  const name = (id?: string): string => (id ? (d.custom[id]?.name ?? id.split('/').pop() ?? id) : '')
  const servers = Object.values(d.connections)
  const secrets = Object.values(d.secrets)
  const lines: string[] = []
  if (servers.length) {
    lines.push("Servers the user has saved in Left Off. Connect with `leftoff ssh <name> '<command>'` (keys are handled), not by typing ssh details:")
    for (const s of servers) lines.push(`  ${s.name}: ${s.user}@${s.host}${s.port ? `:${s.port}` : ''}${s.project ? ` (project ${name(s.project)})` : ''}${s.note ? `, ${s.note}` : ''}`)
  }
  if (secrets.length) {
    lines.push(`Passwords in the user's keyring (names only): ${secrets.map((s) => s.name).join(', ')}. Use one without it entering the conversation: \`leftoff secret run VAR=<name> -- <command>\`. \`leftoff secret get <name>\` prints it; only when the value itself is needed.`)
  }
  if (servers.length || secrets.length) {
    lines.push('When the user gives a new server or password, save it: `leftoff server add <name> <user@host>` / `leftoff secret set <name>` (the user types the value).')
  }
  return lines.join('\n')
}

function findServer(name: string): import('@shared/types').Connection {
  const all = Object.values(readData().connections)
  const q = name.trim().toLowerCase()
  const s = all.find((c) => c.name.toLowerCase() === q) ?? all.find((c) => c.host === name)
  if (!s) throw new Error(`No server named "${name}". Saved: ${all.map((c) => c.name).join(', ') || 'none'}. Add one: leftoff server add <name> <user@host>`)
  return s
}

// Reads a line from the terminal without echoing it.
function promptHidden(question: string): string {
  process.stdout.write(question)
  spawnSync('stty', ['-echo'], { stdio: 'inherit' })
  try {
    const r = spawnSync('sh', ['-c', 'read -r line && printf %s "$line"'], { stdio: ['inherit', 'pipe', 'inherit'] })
    return r.stdout.toString()
  } finally {
    spawnSync('stty', ['echo'], { stdio: 'inherit' })
    process.stdout.write('\n')
  }
}

// ─── Session-start hook ─────────────────────────────────────────────────────

// A session opened in a worktree is told so: its records belong to the main project.
function worktreeNote(project: { id: string; name: string }, cwd: string): string {
  if (project.id.startsWith('custom:')) return ''
  const top = git(cwd, 'rev-parse', '--show-toplevel')
  if (!top || real(top) === real(project.id) || real(top).startsWith(real(project.id) + sep)) return ''
  const branch = currentBranch(cwd)
  return `\nYou are in ${tidyPath(top)}${branch ? ` (branch ${branch})` : ''}, a worktree of ${project.name}: leftoff commands run here record into ${project.name}.`
}

// The same brief goes to every agent the user runs, so whichever one opens a project picks
// up where the last one stopped. Each loads the skill its own way.
function instructions(agent?: Agent): string {
  const load =
    agent === 'codex'
      ? 'read ~/.codex/skills/leftoff/SKILL.md'
      : agent
        ? 'invoke it with the Skill tool'
        : 'invoke it with the Skill tool, or in Codex read ~/.codex/skills/leftoff/SKILL.md'
  // The user's own rules (what's shown to other people, where requests go) live beside the data.
  const local = join(DATA_DIR, 'local.md')
  const own = existsSync(local) ? ` Then read ${tidyPath(local)}: the user's own rules, which win over the skill's.` : ''
  return `Left Off tracks this project and is how the user's agents (Claude, Codex, Kimi) hand work to each other. Before your first reply, load the leftoff skill: ${load}.${own} The brief below is where the last session left off, whichever agent ran it: continue from it instead of re-exploring. Close a task the moment it's finished (\`leftoff done <id>\`), move it as its state changes, and keep its note and next step current, so the next agent can pick up from you the same way.`
}

function sessionStartHook(): void {
  if (process.env.LEFTOFF_AUTOLOG) return // the automatic recorder's own Claude run
  let input: { cwd?: string; session_id?: string } = {}
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {
    // run by hand without a payload
  }
  const cwd = input.cwd || process.cwd()
  const who = detectAgent()
  const self: Who = { agent: who.agent, sessionId: input.session_id || who.sessionId }
  const project = findCustom(undefined, self.sessionId) ?? resolveProject(cwd)
  const data = readData()
  const access = accessNote(data)
  if (!project) {
    if (access) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: access } }))
    return
  }
  const threads = data.threads[project.id] ?? []
  const log = data.log[project.id] ?? []
  const open = sortThreads(threads).filter((t) => t.status !== 'done')

  const out: Record<string, unknown> = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `${instructions(who.agent)}\n\n${brief(project, self)}${worktreeNote(project, cwd)}${
        project.id.startsWith('custom:')
          ? `\nThis project has no folder yet. If the user asks you to clone or create its repo, put it in ${roots()[0]} and then run \`leftoff bind <that folder>\`.`
          : ''
      }${access ? `\n\n${access}` : ''}`
    }
  }
  if (log[0] || open.length) {
    const parts: string[] = []
    if (log[0]) parts.push(`last session (${timeAgo(log[0].at)}): ${log[0].text.length > 110 ? `${log[0].text.slice(0, 110)}…` : log[0].text}`)
    if (open.length) parts.push(`ongoing: ${open.slice(0, 3).map((t) => t.title).join(', ')}${open.length > 3 ? ` +${open.length - 3}` : ''}`)
    out.systemMessage = `Left Off · ${project.name}: ${parts.join(' · ')}`
  }
  process.stdout.write(JSON.stringify(out))
}

// ─── Commands ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'hook') {
    if (rest[0] === 'session-start') sessionStartHook()
    return
  }
  if (command === 'setup') {
    // out/main/cli.js → the app's folder
    const appDir = resolve(__dirname, '..', '..')
    if (rest.includes('--check')) {
      const s = claudeSetupStatus(appDir)
      console.log(`leftoff command on PATH: ${s.command ? 'yes' : 'no'}\nskill:                  ${s.skill ? 'yes' : 'no'}\nsession-start hook:     ${s.hook ? 'yes' : 'no'}`)
      return
    }
    const done = setupClaude(appDir)
    console.log(done.length ? done.join('\n') : 'Already set up: nothing to change.')
    console.log('\nTip: so sessions can record without asking, add "Bash(leftoff *)" to permissions.allow in ~/.claude/settings.json, or answer "don\'t ask again" the first time.')
    return
  }
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE)
    return
  }

  if (command === 'ssh') {
    if (!rest[0]) throw new Error("Which server? leftoff ssh <name> ['<command>']")
    const r = spawnSync('ssh', sshArgs(findServer(rest[0]), rest.slice(1)), { stdio: 'inherit' })
    process.exit(r.status ?? 1)
  }
  if (command === 'secret' && rest[0] === 'run') {
    const sep = rest.indexOf('--')
    if (sep < 0 || sep === rest.length - 1) throw new Error('Usage: leftoff secret run VAR=<name> [VAR=<name>…] -- <command>')
    const env = { ...process.env }
    for (const pair of rest.slice(1, sep)) {
      const [k, name] = pair.split('=')
      if (!k || !name) throw new Error(`Expected VAR=<name>, got "${pair}"`)
      const value = lookupSecret(name)
      if (value === null) throw new Error(`No password named "${name}" in the keyring`)
      env[k] = value
    }
    const [cmd, ...args] = rest.slice(sep + 1)
    const r = spawnSync(cmd, args, { stdio: 'inherit', env })
    process.exit(r.status ?? 1)
  }

  const { positional, flags } = parseArgs(rest)
  const who = detectAgent()
  const sessionId = flags.session || who.sessionId

  // A project without a folder: created (or reused) by name, with this session linked to it.
  if (command === 'project') {
    const name = positional.join(' ').trim()
    if (!name) throw new Error('Name the project: leftoff project "<name>"')
    const p = updateData((d) => upsertCustom(d, name, sessionId ? [sessionId] : []))
    console.log(`${sessionId ? 'Linked this session to' : 'Created'} the project "${p.name}". Record with leftoff did / leftoff task as usual.`)
    return
  }

  if (command === 'roots') {
    console.log(roots().join('\n'))
    return
  }

  if (command === 'merge') {
    const [fromName, intoName] = positional
    if (!fromName || !intoName) throw new Error('Usage: leftoff merge <project> <into>   (both without a folder)')
    const from = findCustom(fromName, undefined, true)
    const into = findCustom(intoName, undefined, true)
    if (!from || !into) throw new Error(`No project without a folder called "${!from ? fromName : intoName}".`)
    updateData((d) => mergeCustom(d, from.id, into.id))
    console.log(`Merged "${from.name}" into "${into.name}".`)
    return
  }

  // The folderless project linked to this session gets a real folder (e.g. Claude just cloned its repo).
  if (command === 'bind') {
    const target = positional[0]
    if (!target) throw new Error('Usage: leftoff bind <folder>   (the folder the project now lives in)')
    const folder = projectFor(resolve(target), roots())
    if (!folder) throw new Error(`${target} isn't inside your project folders (${roots().join(', ')}). Clone it into one of them, then run leftoff bind again.`)
    const custom = (flags.project ? findCustom(flags.project, undefined, true) : null) ?? findCustom(undefined, sessionId, true)
    if (!custom || custom.id.startsWith('/')) throw new Error('This session isn\'t linked to a project without a folder (leftoff project "<name>" links one).')
    updateData((d) => bindCustom(d, custom.id, folder.id))
    console.log(`Bound "${custom.name}" to ${folder.id}. Its sessions, tasks, servers and passwords now belong to ${folder.name}.`)
    return
  }

  // --project is a folder, or the name of a project without one.
  const isDir = !!flags.project && existsSync(flags.project)
  const dir = isDir ? flags.project : process.cwd()
  // An explicit --project wins over the session's link; a name that matches nothing is an error, not the current folder.
  const named = flags.project && !isDir ? (findCustom(flags.project) ?? findFolder(flags.project)) : null
  if (flags.project && !isDir && !named) throw new Error(`No project called "${flags.project}". Give its folder, or the name of a folder in ${roots().join(', ')}.`)
  const project = named ?? (isDir ? resolveProject(dir) : (findCustom(undefined, sessionId) ?? resolveProject(dir)))

  // Servers and passwords belong to the current project when there is one, else to no project.
  if (command === 'servers' || (command === 'server' && positional[0] !== 'add' && positional[0] !== 'rm')) {
    const all = Object.values(readData().connections)
    console.log(all.length ? all.map((s) => `${s.name}\t${s.user}@${s.host}${s.port ? `:${s.port}` : ''}${s.key ? `\tkey ${s.key}` : ''}`).join('\n') : 'No servers saved. Add one: leftoff server add <name> <user@host>')
    return
  }
  if (command === 'server') {
    const [sub, name, target] = positional
    if (sub === 'rm') {
      const s = findServer(name ?? '')
      updateData((d) => void delete d.connections[s.name])
      console.log(`Removed server ${s.name}.`)
      return
    }
    if (!name || !target) throw new Error('Usage: leftoff server add <name> <user@host[:port]> [--key <path>] [--note ..]')
    const conn = { name, ...parseTarget(target), ...(flags.key ? { key: flags.key } : {}), ...(project ? { project: project.id } : {}), ...(flags.note ? { note: flags.note } : {}) }
    updateData((d) => void (d.connections[name] = conn))
    console.log(`Saved server ${name}: ${conn.user}@${conn.host}${project ? ` (project ${project.name})` : ''}. Connect with: leftoff ssh ${name}`)
    return
  }
  if (command === 'secrets' || command === 'secret') {
    const [sub, name] = command === 'secrets' ? ['list'] : positional
    if (sub === 'list' || !sub) {
      const all = Object.values(readData().secrets)
      console.log(all.length ? all.map((s) => `${s.name}${s.note ? `\t${s.note}` : ''}`).join('\n') : 'No passwords saved. Add one: leftoff secret set <name>')
      return
    }
    if (!name) throw new Error(`Usage: leftoff secret ${sub} <name>`)
    if (sub === 'get') {
      const value = lookupSecret(name)
      if (value === null) throw new Error(`No password named "${name}" in the keyring`)
      process.stdout.write(value + '\n')
      return
    }
    if (sub === 'rm') {
      clearSecret(name)
      updateData((d) => void delete d.secrets[name])
      console.log(`Removed ${name} from the keyring.`)
      return
    }
    if (sub === 'set') {
      // The value comes from stdin (piped) or a hidden prompt, never from the command line.
      const value = process.stdin.isTTY ? promptHidden(`Password for ${name}: `) : readFileSync(0, 'utf8').replace(/\n$/, '')
      if (!value) throw new Error('No value given')
      storeSecret(name, value)
      updateData((d) => void (d.secrets[name] = { name, ...(project ? { project: project.id } : {}), ...(flags.note ? { note: flags.note } : {}), createdAt: Date.now() }))
      console.log(`Saved ${name} to the keyring${project ? ` (project ${project.name})` : ''}.`)
      return
    }
    throw new Error(`Unknown: leftoff secret ${sub}`)
  }

  if (!project) {
    throw new Error(`${flags.project && !isDir ? `No project named "${flags.project}"` : `${dir} isn't inside a Left Off project folder (${roots().join(', ')})`}. To track this anyway: leftoff project "<name>"`)
  }
  const show = (): string => brief(project, who)

  if (command === 'status' || command === 'ls') {
    if ('all' in flags) {
      // Everything open, one line each, for when the brief's counts aren't enough.
      const d = readData()
      const open = sortThreads(d.threads[project.id] ?? []).filter((t) => t.status !== 'done')
      console.log(`Left Off · ${project.name} · ${open.length} open`)
      for (const t of open) {
        const tags = [
          t.status === 'active' && 'doing',
          t.kind && t.kind !== 'work' && t.kind,
          t.priority === 'high' && 'flagged',
          t.due && dueLabel(t.due)
        ].filter(Boolean)
        console.log(`  [${t.id}] ${t.title}${tags.length ? `  (${tags.join('; ')})` : ''}`)
      }
      return
    }
    console.log(show())
    return
  }

  // Claude Code sets CLAUDECODE and the session id in the shells it runs; the id makes
  // re-recording within one session replace its summary instead of piling up.
  // `by` keeps its old meaning (Claude Code, which Kimi also is, or you); `agent` names
  // which of the user's agents it was, and every agent's session id makes re-recording
  // within one session replace its summary.
  const ctx: ThreadCtx = {
    by: who.agent === 'claude' || who.agent === 'kimi' ? 'claude' : 'you',
    agent: who.agent,
    now: Date.now(),
    sessionId: who.sessionId,
    ...workPlace(project, isDir ? flags.project : undefined)
  }
  const ref = positional.join(' ').trim()
  const opt = (k: string): string | undefined => (k in flags ? flags[k] : undefined)
  const priority = (): Priority | undefined => {
    const p = opt('priority')
    if (p === undefined) return undefined
    if (p !== 'high' && p !== 'low') throw new Error('--priority is high or low')
    return p
  }

  // One task in full: what a session needs before it continues someone else's work.
  if (command === 'show') {
    if (!ref) throw new Error('Say which task: leftoff show <task>')
    const t = findThread(readData().threads[project.id] ?? [], ref)
    const tags = [
      COLUMNS.find((c) => c.id === columnOf(t))?.title,
      t.priority === 'high' && 'flagged',
      t.due && dueLabel(t.due),
      t.kind && t.kind !== 'work' && t.kind !== 'waiting' && `label ${t.kind}`,
      t.goal && `goal: ${t.goal}`
    ].filter(Boolean)
    const where = whereLabel(t)
    const out = [`[${t.id}] ${t.title}  (${project.name})`, tags.join(' · ')]
    out.push(`Last touched ${timeAgo(t.updatedAt)} by ${whoLabel(t)}${where ? `, ${where}` : ''}`)
    if (t.sessionId && t.agent) out.push(`Its session: ${t.agent === 'codex' ? `codex resume ${t.sessionId}` : `${t.agent} --resume ${t.sessionId}`}`)
    out.push('', 'Note:', t.note || '(none)')
    if (t.next) out.push('', `Next: ${t.next}`)
    if (t.reason) out.push(`Paused: ${t.reason}`)
    if (t.history.length) {
      out.push('', 'History (newest first):')
      for (const h of t.history.slice(0, 12)) {
        out.push(`  ${new Date(h.at).toLocaleString('en-CA', { hour12: false }).slice(5, 17).replace(',', '')}  ${whoLabel(h)}: ${h.text.length > 160 ? `${h.text.slice(0, 160)}…` : h.text}`)
      }
    }
    console.log(out.join('\n'))
    return
  }

  // How another agent's (or another chat's) session ended, from its own transcript: for
  // picking up work that was cut off before it recorded anything.
  if (command === 'tail') {
    const all = recentSessions(sessionDirs(project)).filter((s) => s.id !== who.sessionId)
    const log = readData().log[project.id] ?? []
    if ('list' in flags) {
      if (!all.length) console.log(`No other sessions in ${project.name} in the last two days.`)
      for (const s of all.slice(0, 15)) console.log(`${describeSession(s)}${log.some((e) => e.sessionId === s.id) ? '' : '  [not recorded]'}`)
      return
    }
    const wanted = all.filter((s) => (!flags.agent || s.agent === flags.agent) && (!flags.session || s.id.startsWith(flags.session)))
    // Without a choice: the newest one that actually said something.
    const picked = wanted.map((s) => ({ s, tail: sessionTail(s, Number(flags.chars) || 6000) })).find((x) => flags.session || x.tail.said > 0)
    if (!picked) {
      console.log(`No ${flags.agent && flags.agent in AGENT_NAME ? `${AGENT_NAME[flags.agent as Agent]} ` : 'other '}session with anything to pick up in ${project.name} in the last two days.`)
      return
    }
    const recorded = log.find((e) => e.sessionId === picked.s.id)
    console.log(
      [
        describeSession(picked.s),
        recorded ? `It recorded ${timeAgo(recorded.at)}: ${recorded.text}` : 'It recorded nothing in Left Off.',
        `How it ended (tool output left out):`,
        '',
        ...picked.tail.lines,
        '',
        `To reopen it instead of continuing here: ${resumeCommand(picked.s)}`
      ].join('\n')
    )
    return
  }

  if (command === 'autolog') {
    // Used by the app for sessions that went quiet unrecorded; also runnable by hand.
    if (!flags.transcript || !flags.session) throw new Error('Usage: leftoff autolog --transcript <file.jsonl> --session <id> [--project <dir>] [--dry-run]')
    console.log(await autolog({ file: flags.transcript, sessionId: flags.session, project, branch: currentBranch(dir), dryRun: 'dry-run' in flags }))
    return
  }

  if (command === 'did' || command === 'log') {
    updateData((d) => {
      d.log[project.id] = recordSession(d.log[project.id] ?? [], ref, ctx).list
    })
    console.log(`Recorded this session in ${project.name}.`)
    return
  }

  // Board columns, the flag, due dates, labels and goals.
  if (['move', 'flag', 'unflag', 'due', 'label', 'goal', 'wait', 'resume'].includes(command)) {
    const [taskRef, ...rest] = positional
    const value = rest.join(' ').trim()
    if (!taskRef) throw new Error(`Say which task: leftoff ${command} <task>${command === 'flag' || command === 'unflag' || command === 'wait' ? '' : ' <value>'}`)
    const message = updateData((d) => {
      let list = d.threads[project.id] ?? []
      const t = findThread(list, taskRef)
      let actions: ThreadAction[]
      let said: string
      if (command === 'move' || command === 'wait' || command === 'resume') {
        const to = (command === 'wait' ? 'waiting' : command === 'resume' ? 'doing' : value) as Column
        if (!['todo', 'doing', 'waiting', 'done'].includes(to)) throw new Error('Move to todo, doing, waiting or done')
        actions = actionsToColumn(t, to)
        said = `Moved to ${to === 'todo' ? 'To do' : to[0].toUpperCase() + to.slice(1)}`
      } else if (command === 'flag' || command === 'unflag') {
        actions = [{ type: 'update', id: t.id, priority: command === 'flag' ? 'high' : 'low' }]
        said = command === 'flag' ? 'Flagged' : 'Unflagged'
      } else if (command === 'due') {
        if (!value) throw new Error('Give a date (YYYY-MM-DD) or none')
        actions = [{ type: 'plan', id: t.id, due: value === 'none' ? null : value }]
        said = value === 'none' ? 'Due date cleared' : `Due ${value}`
      } else if (command === 'label') {
        if (!(KINDS as string[]).includes(value)) throw new Error('Label as work, waiting, check or idea')
        actions = [{ type: 'plan', id: t.id, kind: value as Kind }]
        said = `Labelled ${value}`
      } else {
        if (!value) throw new Error('Give the goal\'s title, or none')
        actions = [{ type: 'plan', id: t.id, goal: value === 'none' ? null : value }]
        said = value === 'none' ? 'Goal cleared' : `Goal: ${value}`
      }
      for (const a of actions) list = applyThreadAction(list, a, ctx).list
      d.threads[project.id] = list
      return `${said}: [${t.id}] ${t.title} (${project.name})`
    })
    console.log(message)
    return
  }

  const message = updateData((d) => {
    const list = d.threads[project.id] ?? []
    const target = (required: boolean): string | undefined => {
      if (!ref) {
        if (required) throw new Error(`Say which task, e.g. \`leftoff ${command} <id>\`\n${show()}`)
        // With several chats and agents on one project, "the current task" may be someone else's.
        const doing = list.filter((t) => t.status === 'active')
        if (doing.length > 1) throw new Error(`Several tasks are in Doing. Say which: ${doing.map((t) => `[${t.id}] ${t.title}`).join(', ')}`)
        return undefined
      }
      return findThread(list, ref).id
    }
    let next: string | undefined
    let action: ThreadAction
    let verb: string
    switch (command) {
      case 'task':
      case 'add':
        if (!ref) throw new Error('Give the task a title: leftoff task "<title>"')
        // Adding puts it on the list; only start/resume mark a task as the current one.
        action = { type: 'add', title: ref, note: opt('note'), status: 'paused', priority: priority() }
        verb = 'Added task'
        break
      case 'start':
      case 'new':
        if (!ref) throw new Error('Give the task a title: leftoff start "<title>"')
        // Into Doing beside whatever is already there: another chat's task stays where it is.
        action = { type: 'add', title: ref, note: opt('note'), status: 'active', alongside: true }
        next = opt('next')
        verb = 'Started'
        break
      case 'update':
      case 'note':
        action = { type: 'update', id: target(false), title: opt('title'), note: opt('note'), next: opt('next'), priority: priority() }
        verb = 'Updated'
        break
      case 'park':
      case 'pause':
        action = { type: 'park', id: target(false), reason: opt('reason'), note: opt('note'), next: opt('next') }
        verb = 'Paused'
        break
      case 'done':
      case 'finish':
        action = { type: 'done', id: target(false), note: opt('note') }
        verb = 'Done'
        break
      case 'drop':
      case 'delete':
        action = { type: 'delete', id: target(true)! }
        verb = 'Dropped'
        break
      default:
        throw new Error(`Unknown command "${command}"\n\n${USAGE}`)
    }
    let { list: after, thread } = applyThreadAction(list, action, ctx)
    if (next) ({ list: after, thread } = applyThreadAction(after, { type: 'update', id: thread.id, next }, ctx))
    d.threads[project.id] = after
    return `${verb}: [${thread.id}] ${thread.title} (${project.name})`
  })
  console.log(message)
}

main().catch((err) => {
  console.error(`leftoff: ${err instanceof Error ? err.message : String(err)}`)
  // Never fail a session start over bookkeeping.
  process.exit(process.argv[2] === 'hook' ? 0 : 1)
})
