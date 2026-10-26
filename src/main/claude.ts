import { open, readdir, readFile, stat, writeFile } from 'fs/promises'
import { realpathSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'
import { ACTIVITY_DAYS, addDay, type ClaudeSession, type DayCounts } from '@shared/types'
import { mapLimit } from './util'

// Claude Code keeps one JSONL transcript per session under ~/.claude/projects/<encoded cwd>/.
// They add up to gigabytes, so each file is parsed once and then only from where we stopped,
// with the parsed state cached on disk between launches.

const CLAUDE_DIR = join(homedir(), '.claude', 'projects')
const RECENT_MS = (ACTIVITY_DAYS + 2) * 86_400_000
const TAIL_BYTES = 2 * 1024 * 1024
const CHUNK = 1 << 20

interface CacheEntry {
  size: number
  offset: number // byte offset of the first line not yet parsed
  s: ClaudeSession
  customTitle?: boolean
}

let cache: Record<string, CacheEntry> = {}
let cacheFile = ''
let cacheDirty = false

// Bump whenever parseLine changes what it extracts, so cached sessions get re-read.
const CACHE_VERSION = 4

export async function initClaudeCache(file: string): Promise<void> {
  cacheFile = file
  try {
    const data = JSON.parse(await readFile(file, 'utf8'))
    cache = data.version === CACHE_VERSION ? data.entries : {}
  } catch {
    cache = {}
  }
}

async function saveCache(): Promise<void> {
  if (!cacheFile || !cacheDirty) return
  cacheDirty = false
  await writeFile(cacheFile, JSON.stringify({ version: CACHE_VERSION, entries: cache })).catch(() => {})
}

export const encodePath = (p: string): string => p.replace(/[^a-zA-Z0-9]/g, '-')

// On some systems (Fedora Atomic, Silverblue) /home is a symlink to /var/home, and sessions
// exist under both spellings.
function pathVariants(p: string): string[] {
  const out = new Set([p])
  try {
    out.add(realpathSync(p))
  } catch {
    // missing path — keep the spelling we were given
  }
  for (const v of [...out]) {
    if (v.startsWith('/var/home/')) out.add(v.slice(4))
    else if (v.startsWith('/home/')) out.add('/var' + v)
  }
  return [...out]
}

const isNoise = (t: string): boolean => t.startsWith('<') || t.startsWith('[Request interrupted')

function promptText(content: unknown): string {
  if (typeof content === 'string') return isNoise(content) ? '' : content.trim()
  if (!Array.isArray(content)) return ''
  if (content.some((c) => c?.type === 'tool_result')) return ''
  for (const c of content) {
    if (c?.type === 'text' && typeof c.text === 'string' && !isNoise(c.text)) return c.text.trim()
  }
  return ''
}

// "continue", "yes", "push it" say nothing about where the work is; keep the last real ask.
const meaningful = (t: unknown): t is string => typeof t === 'string' && t.replace(/\s+/g, ' ').trim().length >= 25

function parseLine(line: string, entry: CacheEntry): void {
  // Cheap substring checks first: most lines are large assistant/tool payloads we don't need.
  const isUser = line.includes('"type":"user"')
  if (!isUser && !line.includes('"type":"ai-title"') && !line.includes('"type":"custom-title"') && !line.includes('"type":"last-prompt"')) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let o: Record<string, any>
  try {
    o = JSON.parse(line)
  } catch {
    return
  }
  const s = entry.s
  if (o.type === 'custom-title' && (o.customTitle || o.title)) {
    s.title = o.customTitle || o.title
    entry.customTitle = true
  } else if (o.type === 'ai-title' && o.aiTitle && !entry.customTitle) {
    s.title = o.aiTitle
  } else if (o.type === 'last-prompt' && meaningful(o.lastPrompt)) {
    s.lastPrompt = o.lastPrompt
  } else if (o.type === 'user' && !o.isMeta && !o.isSidechain) {
    const text = promptText(o.message?.content)
    const t = Date.parse(o.timestamp)
    if (!text || !t) return
    if (!s.started) s.started = t
    if (!s.firstPrompt) s.firstPrompt = text.slice(0, 400)
    if (meaningful(text)) s.lastPrompt = text.slice(0, 400)
    s.prompts++
    addDay(s.days, t)
    if (o.cwd) s.dir = o.cwd
  }
}

async function readSession(file: string, dirName: string): Promise<ClaudeSession | null> {
  const st = await stat(file).catch(() => null)
  if (!st) return null
  const prev = cache[file]
  if (prev && prev.size === st.size) return prev.s

  let entry: CacheEntry
  let skipPartial = false
  if (prev && st.size > prev.size) {
    entry = prev // appended to: carry on from the last full line
  } else {
    // Old sessions only need their title and last prompt, both of which repeat near the end.
    const recent = Date.now() - st.mtimeMs < RECENT_MS
    const offset = recent ? 0 : Math.max(0, st.size - TAIL_BYTES)
    skipPartial = offset > 0
    entry = {
      size: 0,
      offset,
      s: {
        id: basename(file, '.jsonl'), dir: dirName, file, title: '', firstPrompt: '', lastPrompt: '',
        started: 0, updated: 0, prompts: 0, days: {}
      }
    }
  }

  const fh = await open(file, 'r')
  const buf = Buffer.alloc(CHUNK)
  let carry = Buffer.alloc(0)
  let pos = entry.offset
  try {
    while (pos < st.size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, st.size - pos), pos)
      if (!bytesRead) break
      pos += bytesRead
      let data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead)
      if (skipPartial) {
        const nl = data.indexOf(0x0a)
        if (nl === -1) {
          carry = Buffer.alloc(0)
          continue
        }
        data = data.subarray(nl + 1)
        skipPartial = false
      }
      const last = data.lastIndexOf(0x0a)
      if (last === -1) {
        carry = Buffer.from(data)
        continue
      }
      for (const line of data.toString('utf8', 0, last).split('\n')) parseLine(line, entry)
      carry = Buffer.from(data.subarray(last + 1))
    }
  } finally {
    await fh.close()
  }

  entry.offset = pos - carry.length
  entry.size = st.size
  entry.s.updated = st.mtimeMs
  cache[file] = entry
  cacheDirty = true
  return entry.s
}

export interface ProjectSessions {
  sessions: ClaudeSession[]
  days: DayCounts
}

export interface SessionScan {
  byProject: Map<string, ProjectSessions>
  byId: Map<string, ClaudeSession> // every session read, for linking to folderless projects
  unassigned: ClaudeSession[] // recent sessions outside every project folder
}

const UNASSIGNED_DAYS = 30

export async function scanClaudeSessions(projects: { id: string; paths: string[] }[]): Promise<SessionScan> {
  // A session folder belongs to the project whose path is its longest prefix,
  // so ~/code/app-docs never lands on ~/code/app.
  const keys = projects
    .flatMap((p) => p.paths.flatMap(pathVariants).map((v) => ({ key: encodePath(v), id: p.id })))
    .sort((a, b) => b.key.length - a.key.length)

  const result = new Map<string, ProjectSessions>()
  const byId = new Map<string, ClaudeSession>()
  const unassigned: ClaudeSession[] = []
  const dirs = await readdir(CLAUDE_DIR).catch(() => null)
  if (!dirs) return { byProject: result, byId, unassigned }

  const seen = new Set<string>()
  for (const d of dirs) {
    if (d.startsWith('-tmp-')) continue // scratch sessions of tools and agents
    const match = keys.find((k) => d === k.key || d.startsWith(k.key + '-'))
    const files = (await readdir(join(CLAUDE_DIR, d)).catch(() => [] as string[])).filter((f) => f.endsWith('.jsonl'))
    const sessions = await mapLimit(files, 4, async (f) => {
      const path = join(CLAUDE_DIR, d, f)
      seen.add(path)
      return readSession(path, d).catch(() => null)
    })
    for (const s of sessions) if (s) byId.set(s.id, s)
    if (!match) {
      // Outside every project folder (home, the projects root itself…): offered for linking.
      for (const s of sessions) {
        if (s && s.title && s.prompts && Date.now() - s.updated < UNASSIGNED_DAYS * 86_400_000) unassigned.push(s)
      }
      continue
    }
    const bucket = result.get(match.id) ?? { sessions: [], days: {} }
    for (const s of sessions) {
      if (!s || (!s.prompts && !s.title && !s.lastPrompt)) continue
      bucket.sessions.push(s)
      for (const [k, n] of Object.entries(s.days)) bucket.days[k] = (bucket.days[k] ?? 0) + n
    }
    result.set(match.id, bucket)
  }

  for (const bucket of result.values()) {
    bucket.sessions.sort((a, b) => b.updated - a.updated)
    bucket.sessions = bucket.sessions.slice(0, 10)
  }
  unassigned.sort((a, b) => b.updated - a.updated)

  for (const file of Object.keys(cache)) {
    if (!seen.has(file) && file.startsWith(CLAUDE_DIR)) {
      delete cache[file]
      cacheDirty = true
    }
  }
  await saveCache()
  return { byProject: result, byId, unassigned: unassigned.slice(0, 30) }
}
