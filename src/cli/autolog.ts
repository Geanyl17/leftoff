import { spawn } from 'child_process'
import { appendFileSync, createReadStream, mkdirSync, statSync } from 'fs'
import { createInterface } from 'readline'
import { join } from 'path'
import { applyThreadAction, describeProject, recordSession, sortThreads, type ThreadCtx } from '@shared/threads'
import { DATA_DIR, readData, updateData } from '../main/threadStore'

// Records a Claude Code session after the fact: reads its transcript, has Claude pull out
// what got done plus anything left unfinished or suggested-but-not-done (the fix Claude
// proposed right before the user chased a different bug), and writes what's missing.
// The app runs this for sessions that went quiet without the leftoff skill recording them.

// About 6k tokens per run: enough to see what happened and what got left behind.
const MAX_CHARS = 24_000
const HEAD_CHARS = 4_000
const MODEL = 'claude-haiku-5-5'

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s)
const isNoise = (t: string): boolean => !t.trim() || t.startsWith('<') || t.startsWith('[Request interrupted')

// The conversation as plain lines: the user's prompts, Claude's replies, and a one-line
// trace of each tool call (files edited, commands run), dropping tool output. Streamed,
// because long-running sessions grow to hundreds of megabytes.
export async function condense(file: string): Promise<{ text: string; prompts: number; promptTimes: number[] }> {
  const items: string[] = []
  const promptTimes: number[] = []
  let prompts = 0
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue
    if (line.includes('"type":"tool_result"')) continue // tool output, often huge
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let o: any
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (o.isSidechain || o.isMeta) continue
    const content = o.message?.content
    if (o.type === 'user') {
      if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) continue
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.filter((b) => b?.type === 'text' && !isNoise(b.text)).map((b) => b.text).join('\n')
            : ''
      if (isNoise(text)) continue
      prompts++
      promptTimes.push(Date.parse(o.timestamp) || 0)
      items.push(`USER: ${clip(text.trim(), 600)}`)
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'text' && b.text?.trim()) items.push(`CLAUDE: ${clip(b.text.trim(), 500)}`)
        else if (b?.type === 'tool_use') {
          const input = b.input ?? {}
          const what = input.file_path ?? input.command ?? input.pattern ?? input.description ?? ''
          if (what) items.push(`  (${b.name}: ${clip(String(what).replace(/\s+/g, ' '), 90)})`)
        }
      }
    }
  }

  // Keep how the session started (what it set out to do) and as much of the end as fits.
  const head: string[] = []
  let size = 0
  for (const it of items) {
    if (size + it.length > HEAD_CHARS) break
    head.push(it)
    size += it.length + 1
  }
  const tail: string[] = []
  for (let i = items.length - 1; i >= head.length; i--) {
    if (size + items[i].length > MAX_CHARS) break
    tail.unshift(items[i])
    size += items[i].length + 1
  }
  const skipped = items.length - head.length - tail.length
  return { text: [...head, ...(skipped > 0 ? [`… (${skipped} lines skipped) …`] : []), ...tail].join('\n'), prompts, promptTimes }
}

interface Extracted {
  summary: string | null
  add: { title: string; note?: string }[]
  done: string[]
}

function promptFor(project: string, records: string, transcript: string): string {
  return `Below is a condensed Claude Code session from the project "${project}", followed by the project's current records in Left Off, an app that shows the user, for each project, what got done last session and the ongoing tasks.

Reply with only a JSON object, no prose:
{"summary": "...", "add": [{"title": "...", "note": "..."}], "done": ["<task id>"]}

- summary: what got done, in the past tense, at most three short sentences and under 60 words: the main features, fixes or decisions, and anything left half-done. Use null if nothing meaningful happened.
- add: unfinished work worth a reminder that isn't already an ongoing task. Look for:
  - work that was started but not finished, including anything the user switched away from mid-session (for example a bug they left to chase a different one);
  - fixes, features or follow-ups that Claude suggested, or the user said to do later, that were not done in this session.
  At most five, the ones the user would most regret forgetting. Titles are 3 to 8 words. The note is one short sentence on where it stands or what was proposed. Leave out trivia and anything that was finished.
- done: ids of existing ongoing tasks that are finished: ones this session finished, and ones the session shows were already finished (the user said so, or Claude found the PR merged, the fix deployed, the thing already done). Leave out anything you are not sure about.

Current records:
${records}

Session:
${transcript}`
}

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, LEFTOFF_AUTOLOG: '1' } // stops our own hooks reacting to this run
    delete env.ELECTRON_RUN_AS_NODE
    mkdirSync(DATA_DIR, { recursive: true }) // its working directory; spawn fails if missing
    const child = spawn(
      'claude',
      ['-p', '--model', MODEL, '--no-session-persistence', '--output-format', 'text',
        '--disallowedTools', 'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit'],
      { cwd: DATA_DIR, env, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill(), 240_000)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`claude exited ${code}: ${err.trim().split('\n')[0]}`))
    })
    child.stdin.end(prompt)
  })
}

function parse(out: string): Extracted {
  const start = out.indexOf('{')
  const end = out.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error(`No JSON in reply: ${out.slice(0, 200)}`)
  const raw = JSON.parse(out.slice(start, end + 1))
  return {
    summary: typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim() : null,
    add: Array.isArray(raw.add) ? raw.add.filter((t: { title?: unknown }) => typeof t?.title === 'string' && t.title.trim()) : [],
    done: Array.isArray(raw.done) ? raw.done.filter((d: unknown) => typeof d === 'string') : []
  }
}

export interface AutologInput {
  file: string
  sessionId: string
  project: { id: string; name: string }
  branch: string
  dryRun: boolean
}

export async function autolog({ file, sessionId, project, branch, dryRun }: AutologInput): Promise<string> {
  const { text, prompts, promptTimes } = await condense(file)
  if (prompts < 4) return 'Skipped: a short session.'
  const before = readData()
  const existing = (before.log[project.id] ?? []).find((e) => e.sessionId === sessionId)
  // Claude's own recording stands unless the conversation carried on well past it.
  if (existing && !existing.auto && promptTimes.filter((t) => t > existing.at).length < 5) {
    return 'Skipped: Claude recorded this session and little happened after.'
  }

  const records = describeProject(project.name, before.threads[project.id] ?? [], before.log[project.id] ?? [])
  const result = parse(await runClaude(promptFor(project.name, records, text)))
  if (dryRun) return JSON.stringify(result, null, 2)

  // Date the entry to when the session went quiet, not to when this ran.
  const endedAt = statSync(file).mtimeMs
  const ctx: ThreadCtx = { by: 'claude', now: endedAt, branch, sessionId }
  const applied: string[] = []
  updateData((d) => {
    const log = d.log[project.id] ?? []
    if (result.summary) {
      d.log[project.id] = recordSession(log, result.summary, { ...ctx, auto: true }).list
      applied.push('summary')
    }
    let tasks = d.threads[project.id] ?? []
    const open = (): string[] => sortThreads(tasks).filter((t) => t.status !== 'done').map((t) => t.title.toLowerCase())
    for (const t of result.add) {
      const title = t.title.trim()
      if (open().some((o) => o === title.toLowerCase() || o.includes(title.toLowerCase()) || title.toLowerCase().includes(o))) continue
      tasks = applyThreadAction(tasks, { type: 'add', title, note: t.note, status: 'paused' }, { ...ctx, now: Date.now() }).list
      applied.push(`task "${title}"`)
    }
    for (const id of result.done) {
      const task = tasks.find((x) => x.id === id && x.status !== 'done')
      if (!task) continue
      tasks = applyThreadAction(tasks, { type: 'done', id }, { ...ctx, now: Date.now() }).list
      applied.push(`done "${task.title}"`)
    }
    d.threads[project.id] = tasks
  })

  const line = `${new Date().toISOString()} ${project.name} ${sessionId}: ${applied.join(', ') || 'nothing new'}`
  try {
    appendFileSync(join(DATA_DIR, 'autolog.log'), line + '\n')
  } catch {
    // logging is best-effort
  }
  return applied.length ? `Recorded ${applied.join(', ')} in ${project.name}.` : `Nothing new to record in ${project.name}.`
}
