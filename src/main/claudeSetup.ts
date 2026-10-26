import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

// Connects Claude Code to Left Off: the `leftoff` command on PATH, the skill that tells
// Claude when to record, and the session-start hook that shows each session where things
// stand. Only ever adds; ~/.claude/settings.json is backed up before it's touched, and
// permissions are left alone. No Electron imports: `leftoff setup` uses this too.

export interface ClaudeSetupStatus {
  command: boolean
  skill: boolean
  hook: boolean
}

const BIN = join(homedir(), '.local', 'bin', 'leftoff')
const SKILL = join(homedir(), '.claude', 'skills', 'leftoff', 'SKILL.md')
const SETTINGS = join(homedir(), '.claude', 'settings.json')
const HOOK_MARK = 'leftoff hook session-start'

const pointsTo = (link: string, target: string): boolean => {
  try {
    return lstatSync(link).isSymbolicLink() && readlinkSync(link) === target
  } catch {
    return false
  }
}

function readSettings(): Record<string, unknown> {
  if (!existsSync(SETTINGS)) return {}
  // Never overwrite a settings file we can't parse.
  return JSON.parse(readFileSync(SETTINGS, 'utf8'))
}

function hasHook(settings: Record<string, unknown>): boolean {
  const groups = (settings.hooks as Record<string, { hooks?: { command?: string }[] }[]> | undefined)?.SessionStart ?? []
  return groups.some((g) => g.hooks?.some((h) => h.command?.includes(HOOK_MARK)))
}

export function claudeSetupStatus(appDir: string): ClaudeSetupStatus {
  let hook = false
  try {
    hook = hasHook(readSettings())
  } catch {
    // unreadable settings: report as not set up
  }
  return {
    command: existsSync(BIN) || pointsTo(BIN, join(appDir, 'bin', 'leftoff')),
    skill: existsSync(SKILL),
    hook
  }
}

function link(target: string, at: string, label: string, done: string[]): void {
  if (pointsTo(at, target)) return
  mkdirSync(dirname(at), { recursive: true })
  if (existsSync(at) || lstatSync(at, { throwIfNoEntry: false })) {
    if (!lstatSync(at).isSymbolicLink()) {
      done.push(`Left your own ${at} as it is (${label} not linked)`)
      return
    }
    unlinkSync(at) // a stale link from an older checkout
  }
  symlinkSync(target, at)
  done.push(`Linked ${label}: ${at}`)
}

export function setupClaude(appDir: string): string[] {
  const done: string[] = []
  link(join(appDir, 'bin', 'leftoff'), BIN, 'the leftoff command', done)
  link(join(appDir, 'claude-skill', 'SKILL.md'), SKILL, 'the leftoff skill', done)

  const settings = readSettings()
  if (!hasHook(settings)) {
    if (existsSync(SETTINGS)) {
      copyFileSync(SETTINGS, `${SETTINGS}.leftoff-backup`)
      done.push(`Backed up ${SETTINGS} to settings.json.leftoff-backup`)
    }
    const hooks = (settings.hooks ??= {}) as Record<string, unknown[]>
    ;(hooks.SessionStart ??= []).push({
      hooks: [{ type: 'command', command: `${join(appDir, 'bin', 'leftoff')} hook session-start`, timeout: 10 }]
    })
    mkdirSync(dirname(SETTINGS), { recursive: true })
    writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n')
    done.push(`Added the session-start hook to ${SETTINGS}`)
  }
  return done
}
