import { execFileSync } from 'child_process'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { timeAgo } from '@shared/time'
import {
  applyThreadAction,
  describeProject,
  findThread,
  recordSession,
  sortThreads,
  type Priority,
  type ThreadAction,
  type ThreadCtx
} from '@shared/threads'
import { DATA_DIR, bindCustom, mergeCustom, readData, updateData, upsertCustom } from '../main/threadStore'
import { autolog } from './autolog'
import { clearSecret, lookupSecret, parseTarget, sshArgs, storeSecret } from '../main/vault'
import { spawnSync } from 'child_process'
import { detectRoots, projectFor } from '../main/roots'
import { claudeSetupStatus, setupClaude } from '../main/claudeSetup'
import { resolve } from 'path'

const USAGE = `leftoff: record what got done and what's still ongoing (shown in the Left Off app)

  leftoff status                       last session + ongoing tasks for the project you're in
  leftoff did "<summary>"              what got done this session (re-running replaces it)
  leftoff task "<title>" [--note ..] [--priority high|low]   add an open task
  leftoff update <task> [--note ..] [--next ..] [--title ..] [--priority high|low]
  leftoff done <task>                  mark a task finished
  leftoff start "<title>"              add a task and make it the current one
  leftoff resume <task>                make an existing task the current one
  leftoff drop <task>                  delete a task
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

  <task> is an id or part of the title. --project <dir or name> works on another project.`

// ─── Arguments ──────────────────────────────────────────────────────────────

interface Args {
  positional: string[]
  flags: Record<string, string>
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1)
      else if (a === '--dry-run') flags['dry-run'] = ''
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

function currentBranch(dir: string): string {
  try {
    return execFileSync('git', ['-C', dir, 'branch', '--show-current'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
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

const INSTRUCTIONS = `Left Off tracks what got done and what's ongoing per project. Record with the leftoff skill when the user wraps up, switches away or changes direction.`

function sessionStartHook(): void {
  if (process.env.LEFTOFF_AUTOLOG) return // the automatic recorder's own Claude run
  let input: { cwd?: string } = {}
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  } catch {
    // run by hand without a payload
  }
  const project = findCustom(undefined, (input as { session_id?: string }).session_id) ?? resolveProject(input.cwd || process.cwd())
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
      additionalContext: `${INSTRUCTIONS}\n\n${describeProject(project.name, threads, log)}${
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
  const fromClaude = process.env.CLAUDECODE === '1'
  const sessionId = flags.session || (fromClaude ? process.env.CLAUDE_CODE_SESSION_ID : undefined) || undefined

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
  const show = (): string => {
    const d = readData()
    return describeProject(project.name, d.threads[project.id] ?? [], d.log[project.id] ?? [])
  }

  if (command === 'status' || command === 'ls') {
    console.log(show())
    return
  }

  // Claude Code sets CLAUDECODE and the session id in the shells it runs; the id makes
  // re-recording within one session replace its summary instead of piling up.
  const ctx: ThreadCtx = {
    by: fromClaude ? 'claude' : 'you',
    now: Date.now(),
    branch: currentBranch(dir),
    sessionId: (fromClaude && process.env.CLAUDE_CODE_SESSION_ID) || undefined
  }
  const ref = positional.join(' ').trim()
  const opt = (k: string): string | undefined => (k in flags ? flags[k] : undefined)
  const priority = (): Priority | undefined => {
    const p = opt('priority')
    if (p === undefined) return undefined
    if (p !== 'high' && p !== 'low') throw new Error('--priority is high or low')
    return p
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

  const message = updateData((d) => {
    const list = d.threads[project.id] ?? []
    const target = (required: boolean): string | undefined => {
      if (!ref) {
        if (required) throw new Error(`Say which task, e.g. \`leftoff ${command} <id>\`\n${show()}`)
        return undefined
      }
      return findThread(list, ref).id
    }
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
        action = { type: 'start', title: ref, note: opt('note'), next: opt('next'), reason: opt('reason') }
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
      case 'resume':
        action = { type: 'resume', id: target(true)!, reason: opt('reason') }
        verb = 'Now working on'
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
    const { list: next, thread } = applyThreadAction(list, action, ctx)
    d.threads[project.id] = next
    return `${verb}: [${thread.id}] ${thread.title} (${project.name})`
  })
  console.log(message)
}

main().catch((err) => {
  console.error(`leftoff: ${err instanceof Error ? err.message : String(err)}`)
  // Never fail a session start over bookkeeping.
  process.exit(process.argv[2] === 'hook' ? 0 : 1)
})
