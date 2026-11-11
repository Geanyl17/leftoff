import { readFileSync, readlinkSync } from 'fs'
import { basename } from 'path'
import type { Agent } from '@shared/threads'

// Which coding agent is running this command, and its session id. The user works with
// several (Claude Code, Codex, and `kimi`: Claude Code on the Kimi API with its own config
// folder), often one launched from another's shell, so the environment alone can't say:
// a Kimi worker started by Codex inherits Codex's variables. The nearest agent process
// above us can. No Electron imports: the CLI uses this.

export interface Who {
  agent?: Agent
  sessionId?: string
}

const isAgent = (v: unknown): v is Agent => v === 'claude' || v === 'codex' || v === 'kimi'
const isKimiEnv = (env: Record<string, string | undefined>): boolean =>
  /\.claude-kimi\/?$/.test(env.CLAUDE_CONFIG_DIR ?? '') || /kimi/i.test(env.ANTHROPIC_BASE_URL ?? '')

function procInfo(pid: number): { ppid: number; comm: string; exe: string } | null {
  try {
    // "pid (comm) state ppid …": comm may itself contain spaces or parentheses.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    const comm = stat.slice(stat.indexOf('(') + 1, close)
    const ppid = Number(stat.slice(close + 2).split(' ')[1])
    let exe = ''
    try {
      exe = readlinkSync(`/proc/${pid}/exe`)
    } catch {
      // another user's process, or it just exited
    }
    return { ppid, comm, exe }
  } catch {
    return null
  }
}

function procEnv(pid: number): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(`/proc/${pid}/environ`, 'utf8')
        .split('\0')
        .filter((kv) => kv.includes('='))
        .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)])
    )
  } catch {
    return {}
  }
}

/** The nearest agent above this process, on systems with /proc. */
function fromAncestors(): Agent | undefined {
  let pid = process.ppid
  for (let i = 0; i < 16 && pid > 1; i++) {
    const p = procInfo(pid)
    if (!p) return undefined
    const exe = basename(p.exe)
    if (p.comm.startsWith('codex') || exe.startsWith('codex')) return 'codex'
    if (p.comm === 'claude' || p.exe.includes('/claude/versions/')) return isKimiEnv(procEnv(pid)) ? 'kimi' : 'claude'
    pid = p.ppid
  }
  return undefined
}

export function detectAgent(env: Record<string, string | undefined> = process.env): Who {
  // Set by hand (or by a launcher) when the guess would be wrong.
  if (isAgent(env.LEFTOFF_AGENT)) return { agent: env.LEFTOFF_AGENT, sessionId: env.LEFTOFF_SESSION || undefined }
  const inClaude = env.CLAUDECODE === '1'
  const inCodex = !!env.CODEX_THREAD_ID
  const agent: Agent | undefined =
    fromAncestors() ?? (inClaude ? (isKimiEnv(env) ? 'kimi' : 'claude') : inCodex ? 'codex' : undefined)
  if (!agent) return {}
  // Each agent gives the shells it runs its own session id; an id inherited from an outer
  // agent is that agent's, so only the matching variable counts.
  const sessionId = agent === 'codex' ? env.CODEX_THREAD_ID : inClaude ? env.CLAUDE_CODE_SESSION_ID : undefined
  return { agent, sessionId: sessionId || undefined }
}
