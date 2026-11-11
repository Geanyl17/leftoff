import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'
import { AGENT_NAME, tidyPath, type Agent, type LogEntry } from '@shared/threads'
import { timeAgo } from '@shared/time'

// The other agents' sessions in a project, read straight from their transcripts: Claude
// Code's and Kimi's (same format, separate folders) and Codex's rollouts. A session that
// was cut off (a usage limit, a closed terminal) never recorded anything, so the next
// agent's brief says so and `leftoff tail` shows how it ended. Nothing here calls a model.

export interface AgentSession {
  agent: Agent
  id: string
  file: string
  started: number
  updated: number
  size: number
}

const CLAUDE_DIRS: [Agent, string][] = [
  ['claude', join(homedir(), '.claude', 'projects')],
  ['kimi', join(homedir(), '.claude-kimi', 'projects')]
]
const CODEX_SESSIONS = join(homedir(), '.codex', 'sessions')
const DAY = 86_400_000
const LOOKBACK = 2 * DAY

const encodePath = (p: string): string => p.replace(/[^a-zA-Z0-9]/g, '-')

// /home is a symlink to /var/home on some systems, and sessions exist under both spellings.
function pathVariants(p: string): string[] {
  const out = new Set([p])
  try {
    out.add(realpathSync(p))
  } catch {
    // a folder that's gone: keep the spelling we were given
  }
  for (const v of [...out]) {
    if (v.startsWith('/var/home/')) out.add(v.slice(4))
    else if (v.startsWith('/home/')) out.add('/var' + v)
  }
  return [...out]
}

const ls = (dir: string): string[] => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Reads `length` bytes at `offset` (negative: from the end), as text. */
function readPart(file: string, offset: number, length: number): string {
  const fd = openSync(file, 'r')
  try {
    const size = statSync(file).size
    const start = offset < 0 ? Math.max(0, size + offset) : offset
    const buf = Buffer.alloc(Math.min(length, size - start))
    readSync(fd, buf, 0, buf.length, start)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** Sessions of any agent that ran in these folders and were active in the last two days, newest first. */
export function recentSessions(dirs: string[], now = Date.now()): AgentSession[] {
  const found: AgentSession[] = []
  const variants = dirs.flatMap(pathVariants)
  const keys = variants.map(encodePath)

  for (const [agent, root] of CLAUDE_DIRS) {
    for (const d of ls(root)) {
      // The folder itself or anything inside it (a session started in a subfolder).
      if (!keys.some((k) => d === k || d.startsWith(k + '-'))) continue
      for (const f of ls(join(root, d))) {
        if (!f.endsWith('.jsonl')) continue
        const file = join(root, d, f)
        try {
          const st = statSync(file)
          if (now - st.mtimeMs < LOOKBACK) found.push({ agent, id: basename(f, '.jsonl'), file, started: st.birthtimeMs || st.ctimeMs, updated: st.mtimeMs, size: st.size })
        } catch {
          // removed meanwhile
        }
      }
    }
  }

  // Codex files sessions by the day they started: sessions/YYYY/MM/DD/rollout-…-<id>.jsonl,
  // with the folder it ran in on the first line.
  for (let back = 0; back <= 3; back++) {
    const day = new Date(now - back * DAY)
    const dir = join(CODEX_SESSIONS, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
    for (const f of ls(dir)) {
      if (!f.endsWith('.jsonl')) continue
      const file = join(dir, f)
      try {
        const st = statSync(file)
        if (now - st.mtimeMs >= LOOKBACK) continue
        const head = readPart(file, 0, 256 * 1024)
        const meta = JSON.parse(head.slice(0, head.indexOf('\n') > 0 ? head.indexOf('\n') : undefined)).payload ?? {}
        const cwd = String(meta.cwd ?? '')
        if (!variants.some((v) => cwd === v || cwd.startsWith(v + '/'))) continue
        found.push({ agent: 'codex', id: String(meta.id ?? meta.session_id ?? basename(f, '.jsonl')), file, started: st.birthtimeMs || st.ctimeMs, updated: st.mtimeMs, size: st.size })
      } catch {
        // an unreadable or half-written rollout
      }
    }
  }
  return found.sort((a, b) => b.updated - a.updated)
}

// ─── How a session ended ────────────────────────────────────────────────────

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}
// Injected context and harness notices, not something the user typed.
const isNoise = (t: string): boolean => !t.trim() || t.startsWith('<') || t.startsWith('[Request interrupted') || t.startsWith('# AGENTS.md')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>

function claudeItems(o: Json, name: string): string[] {
  if (o.isSidechain || o.isMeta) return []
  const content = o.message?.content
  if (o.type === 'user') {
    if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) return []
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b?.type === 'text' && !isNoise(b.text)).map((b) => b.text).join('\n') : ''
    return isNoise(text) ? [] : [`USER: ${clip(text, 700)}`]
  }
  if (o.type !== 'assistant' || !Array.isArray(content)) return []
  const out: string[] = []
  for (const b of content) {
    if (b?.type === 'text' && b.text?.trim()) out.push(`${name}: ${clip(b.text, 700)}`)
    else if (b?.type === 'tool_use') {
      const input = b.input ?? {}
      const what = input.file_path ?? input.command ?? input.pattern ?? input.description ?? ''
      if (what) out.push(`  (${b.name}: ${clip(String(what), 110)})`)
    }
  }
  return out
}

function codexItems(o: Json, name: string): string[] {
  if (o.type !== 'response_item') return []
  const p = o.payload ?? {}
  if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant') && Array.isArray(p.content)) {
    const text = p.content.map((c: Json) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
    if (isNoise(text)) return []
    return [`${p.role === 'user' ? 'USER' : name}: ${clip(text, 700)}`]
  }
  if (p.type === 'custom_tool_call' || p.type === 'function_call' || p.type === 'local_shell_call') {
    const what = p.input ?? p.arguments ?? p.action?.command ?? ''
    if (what) return [`  (${p.name ?? 'run'}: ${clip(typeof what === 'string' ? what : JSON.stringify(what), 110)})`]
  }
  return []
}

/** The end of a session as plain lines: what the user asked, what the agent said, what it ran. Tool output is dropped. */
export function sessionTail(s: AgentSession, maxChars = 6000): { lines: string[]; said: number } {
  const name = AGENT_NAME[s.agent].toUpperCase()
  const parse = s.agent === 'codex' ? codexItems : claudeItems
  let items: string[] = []
  // Transcripts run to hundreds of megabytes; the end is enough. Tool output can be huge,
  // so widen once if the first slice held little conversation.
  for (const bytes of [600 * 1024, 4 * 1024 * 1024]) {
    const text = readPart(s.file, -bytes, bytes)
    const whole = bytes >= s.size
    items = []
    for (const line of text.split('\n').slice(whole ? 0 : 1)) {
      if (!line.startsWith('{')) continue
      try {
        items.push(...parse(JSON.parse(line), name))
      } catch {
        // a line cut by the slice, or still being written
      }
    }
    if (whole || items.join('\n').length >= maxChars) break
  }
  const lines: string[] = []
  let size = 0
  for (let i = items.length - 1; i >= 0; i--) {
    if (size + items[i].length > maxChars && lines.length) break
    lines.unshift(items[i])
    size += items[i].length + 1
  }
  return { lines, said: items.filter((l) => l.startsWith(`${name}: `)).length }
}

/** How to reopen a session in the agent that ran it. */
export const resumeCommand = (s: AgentSession): string => (s.agent === 'codex' ? `codex resume ${s.id}` : `${s.agent} --resume ${s.id}`)

// ─── What the brief says about them ─────────────────────────────────────────

const ACTIVE_MS = 5 * 60_000
const UNRECORDED_GAP = 15 * 60_000

/**
 * Lines for the brief: who else is working in the project right now, and the newest
 * session that stopped without recording (or carried on well past what it recorded).
 */
export function sessionNotes(dirs: string[], log: LogEntry[], self: { agent?: Agent; sessionId?: string }, now = Date.now()): string[] {
  let sessions: AgentSession[]
  try {
    sessions = recentSessions(dirs, now).filter((s) => s.id !== self.sessionId)
    // A session-start hook that wasn't told its own id: the transcript this agent opened
    // a moment ago is the session being briefed, not another chat.
    if (!self.sessionId) sessions = sessions.filter((s) => !(s.agent === self.agent && now - s.started < 90_000))
  } catch {
    return []
  }
  const out: string[] = []
  const active = sessions.filter((s) => now - s.updated < ACTIVE_MS).slice(0, 4)
  if (active.length) {
    out.push(
      `Also working here right now: ${active.map((s) => `${AGENT_NAME[s.agent]} (${timeAgo(s.updated, now)})`).join(', ')}. Their tasks in Doing are theirs; leave them unless the user hands one over.`
    )
  }
  for (const s of sessions.filter((x) => now - x.updated >= ACTIVE_MS).slice(0, 5)) {
    // By its id, or (entries written before agents other than Claude Code passed one) by
    // an id-less entry made while it was running.
    const recorded = log.find((e) => e.sessionId === s.id) ?? log.find((e) => !e.sessionId && e.at >= s.started && e.at <= s.updated + 60_000)
    if (recorded && s.updated - recorded.at < UNRECORDED_GAP) break // the newest stopped session is on record: nothing to chase
    // Older than what the brief already covers: the last recorded session is the better guide.
    if (!recorded && log[0] && log[0].at > s.updated + UNRECORDED_GAP) break
    let said = 0
    try {
      said = sessionTail(s, 2000).said
    } catch {
      // unreadable: skip it
    }
    if (said < 2) continue // opened and closed, or nothing to pick up
    out.push(
      `Not recorded: a ${AGENT_NAME[s.agent]} session stopped ${timeAgo(s.updated, now)} ${recorded ? 'and kept working after its last summary' : 'without recording what it did'}. Before continuing its work, read how it ended: \`leftoff tail\`.`
    )
    break
  }
  return out
}

export function describeSession(s: AgentSession, now = Date.now()): string {
  return `${AGENT_NAME[s.agent]} session ${s.id.slice(0, 8)}, last active ${timeAgo(s.updated, now)} (${tidyPath(s.file)})`
}
