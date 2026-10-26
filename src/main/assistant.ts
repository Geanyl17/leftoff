import { z } from 'zod'
import type { Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  defaultMeta,
  type ChatAction,
  type ChatMessage,
  type ChatState,
  type OpenTarget,
  type ProjectMeta,
  type ProjectScan
} from '@shared/types'
import { findThread, sortThreads, type Actor, type ThreadAction } from '@shared/threads'
import { timeAgo } from '@shared/time'
import { facts } from './facts'
import type { LeftOffData, LogDb, ThreadDb } from './threadStore'

// The chat panel's assistant. It runs on the user's Claude Code login through the Agent
// SDK, with Claude Code's own tools switched off and only the Left Off tools below allowed,
// so it can rearrange the board and nothing else.

export interface AssistantDeps {
  projects(): ProjectScan[]
  meta(): Record<string, ProjectMeta>
  threads(): ThreadDb
  log(): LogDb
  updateMeta(id: string, patch: Partial<ProjectMeta>): ProjectMeta
  replaceMeta(meta: Record<string, ProjectMeta>): void
  threadAction(id: string, action: ThreadAction, by: Actor): { ok: boolean; error?: string }
  recordSession(id: string, text: string): void
  replaceData(data: Pick<LeftOffData, 'threads' | 'log'>): void
  open(id: string, target: OpenTarget, arg?: string): Promise<void>
  rescan(): Promise<void>
  model(): string
  cwd(): string
  onChange(state: ChatState): void
}

const SYSTEM = `You are the assistant inside Left Off, a desktop app where the user keeps track of their coding projects, often a mix of work and side projects. For each project the app shows what got done last session and the ongoing tasks. You read it and change it with your tools.

How it works:
- "Last session" entries are short summaries of what got done, usually recorded by Claude at the end of a coding session.
- Tasks are ongoing pieces of work. One can be marked current; the rest are open. Done tasks drop off the list.
- Category is work (day-job apps) or side. Pinned projects sit at the top; hidden ones leave the list. Status paused or shipped moves a project to the quiet list.

How to work:
- Each user message starts with a <board> snapshot taken at that moment. Use get_project when you need detail on one project.
- When asked to change something, do it with the tools, then say what changed in a sentence. Changes are reversible (the user has an Undo button), so make them without asking, except deleting a task, which needs a clear request.
- When asked what to work on or where things stand, answer from the board: last sessions, ongoing tasks, uncommitted or unpushed work. Be concrete, brief, and name projects.
- Don't announce what you're about to do; use the tools, then reply once with the outcome.
- Write plain text. Short bullet lists are fine; no headings or tables.`

const projectArg = z.string().describe('Project folder name or display name, e.g. "recipe-app"')

function text(t: string, isError = false): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  return { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) }
}

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = []
  private closed = false

  push(m: SDKUserMessage): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: m, done: false })
    else this.items.push(m)
  }

  close(): void {
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      }
    }
  }
}

const uid = (): string => Math.random().toString(36).slice(2, 10)

export class Assistant {
  private messages: ChatMessage[] = []
  private busy = false
  private error: string | null = null
  private query: Query | null = null
  private input: InputQueue | null = null
  private sessionModel = ''
  private current: ChatMessage | null = null
  private streamed = new Set<string>() // assistant message ids whose text arrived as deltas
  private needsGap = false
  private turnSnapshot: { meta: Record<string, ProjectMeta>; data: Pick<LeftOffData, 'threads' | 'log'> } | null = null
  private undoSnapshot: { messageId: string; meta: Record<string, ProjectMeta>; data: Pick<LeftOffData, 'threads' | 'log'> } | null = null
  private pushTimer: NodeJS.Timeout | null = null

  constructor(private deps: AssistantDeps) {}

  state(): ChatState {
    return { messages: this.messages, busy: this.busy, error: this.error, model: this.deps.model() }
  }

  private push(now = false): void {
    if (now) {
      if (this.pushTimer) clearTimeout(this.pushTimer)
      this.pushTimer = null
      this.deps.onChange(this.state())
      return
    }
    this.pushTimer ??= setTimeout(() => {
      this.pushTimer = null
      this.deps.onChange(this.state())
    }, 40)
  }

  // ─── Projects ─────────────────────────────────────────────────────────────

  private resolve(ref: string): ProjectScan {
    const q = ref.trim().toLowerCase()
    const meta = this.deps.meta()
    const all = this.deps.projects()
    const name = (p: ProjectScan): string => (meta[p.id]?.alias || p.name).toLowerCase()
    const exact = all.filter((p) => p.name.toLowerCase() === q || name(p) === q)
    if (exact.length === 1) return exact[0]
    const partial = all.filter((p) => p.name.toLowerCase().includes(q) || name(p).includes(q))
    if (partial.length === 1) return partial[0]
    if (!partial.length) throw new Error(`No project matches "${ref}". Projects: ${all.map((p) => p.name).join(', ')}`)
    throw new Error(`"${ref}" matches several projects: ${partial.map((p) => p.name).join(', ')}`)
  }

  private board(): string {
    const meta = this.deps.meta()
    const threads = this.deps.threads()
    const log = this.deps.log()
    const lines = [`Now: ${new Date().toLocaleString()}`]
    const projects = [...this.deps.projects()].sort((a, b) => b.lastTouched - a.lastTouched)
    for (const p of projects) {
      const m = { ...defaultMeta(), ...meta[p.id] }
      const open = sortThreads(threads[p.id] ?? []).filter((x) => x.status !== 'done')
      const last = log[p.id]?.[0]
      const tags = [m.category, m.status, m.pinned && 'pinned', m.hidden && 'hidden'].filter(Boolean).join(', ')
      const parts = [`${m.alias ? `${m.alias} (folder ${p.name})` : p.name} [${tags}]`, `touched ${timeAgo(p.lastTouched)}`]
      if (p.repos[0]) parts.push(`branch ${p.repos[0].branch}${p.repos.length > 1 ? ` +${p.repos.length - 1} repos` : ''}`)
      const dirty = p.repos.reduce((n, r) => n + r.staged + r.changed + r.untracked + r.conflicted, 0)
      if (dirty) parts.push(`${dirty} uncommitted`)
      const ahead = p.repos.reduce((n, r) => n + r.ahead, 0)
      if (ahead) parts.push(`${ahead} unpushed`)
      if (last) parts.push(`last session ${timeAgo(last.at)}: "${last.text}"`)
      else if (p.sessions[0]) parts.push(`last Claude session "${p.sessions[0].title}" ${timeAgo(p.sessions[0].updated)} (nothing recorded)`)
      if (open.length) parts.push(`ongoing: ${open.map((x) => `"${x.title}"${x.status === 'active' ? ' (current)' : ''}`).join(', ')}`)
      lines.push(`- ${parts.join(' · ')}`)
    }
    return lines.join('\n')
  }

  // ─── Tools ────────────────────────────────────────────────────────────────

  // Snapshot the board before the first change of a turn, so Undo can put it all back.
  private beforeChange(): void {
    this.turnSnapshot ??= {
      meta: structuredClone(this.deps.meta()),
      data: { threads: structuredClone(this.deps.threads()), log: structuredClone(this.deps.log()) }
    }
  }

  private record(action: ChatAction): void {
    this.current?.actions.push(action)
    this.push()
  }

  private guard<A>(fn: (args: A) => Promise<string> | string) {
    return async (args: A) => {
      try {
        return text(await fn(args))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.record({ text: message, ok: false })
        return text(message, true)
      }
    }
  }

  private async buildServer() {
    const { tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk')
    const d = this.deps

    const tools = [
      tool(
        'get_project',
        'Everything known about one project: recorded sessions, tasks, git state per repo, recent commits, uncommitted files, Claude Code sessions, open checklist items in its planning docs.',
        { project: projectArg },
        this.guard(({ project }: { project: string }) => {
          const p = this.resolve(project)
          return facts({
            project: p,
            meta: { ...defaultMeta(), ...d.meta()[p.id] },
            threads: d.threads()[p.id] ?? [],
            log: d.log()[p.id] ?? []
          })
        })
      ),

      tool(
        'set_project',
        'Change how a project sits on the board. Pass only the fields to change.',
        {
          project: projectArg,
          category: z.enum(['work', 'side']).optional(),
          status: z.enum(['active', 'blocked', 'paused', 'shipped']).optional().describe('paused and shipped move it to the quiet list'),
          pinned: z.boolean().optional(),
          hidden: z.boolean().optional().describe('hidden projects leave the list'),
          alias: z.string().optional().describe('display name; an empty string clears it')
        },
        this.guard((args: { project: string; category?: 'work' | 'side'; status?: ProjectMeta['status']; pinned?: boolean; hidden?: boolean; alias?: string }) => {
          const p = this.resolve(args.project)
          const { project: _project, ...patch } = args
          const changes = Object.entries(patch).filter(([, v]) => v !== undefined)
          if (!changes.length) return 'Nothing to change.'
          this.beforeChange()
          d.updateMeta(p.id, Object.fromEntries(changes) as Partial<ProjectMeta>)
          const summary = changes.map(([k, v]) => (typeof v === 'boolean' ? (v ? k : `not ${k}`) : `${k} ${v || '(cleared)'}`)).join(', ')
          this.record({ text: `${p.name}: ${summary}`, ok: true })
          return `${p.name} is now ${summary}.`
        })
      ),

      tool(
        'task',
        "Add, update, finish or delete a project's ongoing tasks, or change which one is current. add puts a task on the list; start adds one and makes it current; resume makes an existing task current.",
        {
          project: projectArg,
          action: z.enum(['add', 'start', 'update', 'resume', 'done', 'delete']),
          title: z.string().optional().describe('required for add and start; renames the task on update'),
          task: z.string().optional().describe('task id or part of its title; defaults to the current task for update and done; required for resume and delete'),
          note: z.string().optional().describe('where it stands'),
          next: z.string().optional().describe('the next concrete step'),
          priority: z.enum(['high', 'low']).optional().describe('board column for open tasks; unset counts as low')
        },
        this.guard((a: { project: string; action: 'add' | 'start' | 'update' | 'resume' | 'done' | 'delete'; title?: string; task?: string; note?: string; next?: string; priority?: 'high' | 'low' }) => {
          const p = this.resolve(a.project)
          const list = d.threads()[p.id] ?? []
          const id = a.task ? findThread(list, a.task).id : undefined
          let action: ThreadAction
          switch (a.action) {
            case 'add':
              if (!a.title) throw new Error('A task needs a title')
              action = { type: 'add', title: a.title, note: a.note, status: 'paused', priority: a.priority }
              break
            case 'start':
              if (!a.title) throw new Error('A task needs a title')
              action = { type: 'start', title: a.title, note: a.note, next: a.next }
              break
            case 'update':
              action = { type: 'update', id, title: a.title, note: a.note, next: a.next, priority: a.priority }
              break
            case 'resume':
              if (!id) throw new Error('Say which task to make current')
              action = { type: 'resume', id }
              break
            case 'done':
              action = { type: 'done', id, note: a.note }
              break
            case 'delete':
              if (!id) throw new Error('Say which task to delete')
              action = { type: 'delete', id }
              break
          }
          this.beforeChange()
          const res = d.threadAction(p.id, action, 'claude')
          if (!res.ok) throw new Error(res.error)
          const verb = { add: 'Added', start: 'Started', update: 'Updated', resume: 'Now on', done: 'Finished', delete: 'Deleted' }[a.action]
          const name = a.title ?? (id ? list.find((t) => t.id === id)?.title : list.find((t) => t.status === 'active')?.title) ?? 'task'
          this.record({ text: `${verb} “${name}” in ${p.name}`, ok: true })
          return `${verb} "${name}" in ${p.name}.`
        })
      ),

      tool(
        'record_session',
        "Record what got done in a project's latest session (shown as its \"last session\"). Use when the user tells you what they did.",
        { project: projectArg, summary: z.string().describe('one to three sentences, past tense, concrete') },
        this.guard((a: { project: string; summary: string }) => {
          const p = this.resolve(a.project)
          this.beforeChange()
          d.recordSession(p.id, a.summary)
          this.record({ text: `${p.name}: recorded session`, ok: true })
          return `Recorded in ${p.name}.`
        })
      ),

      tool(
        'open',
        "Open a project on the user's computer: VS Code, a terminal, the file manager, its GitHub page, or resume its latest (or a given) Claude Code session in a terminal.",
        {
          project: projectArg,
          target: z.enum(['code', 'terminal', 'folder', 'github', 'claude']),
          session: z.string().optional().describe('Claude session id, for target claude; defaults to the latest')
        },
        this.guard(async (a: { project: string; target: OpenTarget; session?: string }) => {
          const p = this.resolve(a.project)
          await d.open(p.id, a.target, a.target === 'claude' ? (a.session ?? p.sessions[0]?.id) : undefined)
          this.record({ text: `Opened ${p.name} (${a.target})`, ok: true })
          return `Opened ${p.name} in ${a.target}.`
        })
      ),

      tool(
        'rescan',
        'Rescan every project folder now (git, Claude sessions, docs) to refresh the board.',
        {},
        this.guard(async () => {
          await d.rescan()
          return 'Rescanned.'
        })
      )
    ]

    return { server: createSdkMcpServer({ name: 'leftoff', version: '1.0.0', tools }), names: tools.map((t) => `mcp__leftoff__${t.name}`) }
  }

  // ─── Session ──────────────────────────────────────────────────────────────

  private async ensureSession(): Promise<InputQueue> {
    if (this.query && this.input && this.sessionModel === this.deps.model()) return this.input
    this.close()
    const { query } = await import('@anthropic-ai/claude-agent-sdk')
    const { server, names } = await this.buildServer()
    const input = new InputQueue()
    this.input = input
    this.sessionModel = this.deps.model()
    this.query = query({
      prompt: input,
      options: {
        model: this.sessionModel,
        effort: 'medium',
        systemPrompt: SYSTEM,
        tools: [],
        mcpServers: { leftoff: server },
        allowedTools: names,
        permissionMode: 'dontAsk',
        settingSources: [],
        persistSession: false,
        includePartialMessages: true,
        cwd: this.deps.cwd(),
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'leftoff/0.1.0' }
      }
    })
    void this.consume(this.query)
    return input
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const m of q) this.handle(m)
      if (q === this.query && this.busy) this.fail('The assistant stopped unexpectedly.')
    } catch (err) {
      if (q === this.query) this.fail(err instanceof Error ? err.message : String(err))
    } finally {
      if (q === this.query) {
        this.query = null
        this.input = null
      }
    }
  }

  private appendText(t: string): void {
    if (!this.current || !t) return
    if (this.needsGap && this.current.text) this.current.text += '\n\n'
    this.needsGap = false
    this.current.text += t
    this.push()
  }

  private handle(m: SDKMessage): void {
    switch (m.type) {
      case 'stream_event': {
        const e = m.event
        if (e.type === 'message_start') this.streamed.add(e.message.id)
        else if (e.type === 'content_block_start' && e.content_block.type === 'text') this.needsGap = true
        else if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') this.appendText(e.delta.text)
        break
      }
      case 'assistant': {
        if (m.error) this.error = `Claude reported: ${m.error}`
        // Only if nothing streamed for this message (partial events are best-effort).
        if (!this.streamed.has(m.message.id)) {
          for (const block of m.message.content) {
            if (block.type === 'text') {
              this.needsGap = true
              this.appendText(block.text)
            }
          }
        }
        break
      }
      case 'result': {
        if (m.subtype !== 'success') {
          const detail = 'errors' in m && m.errors.length ? m.errors.join('; ') : m.subtype
          if (m.subtype !== 'error_during_execution' || !this.current?.text) this.error = detail
        }
        this.finishTurn()
        break
      }
      default:
        break
    }
  }

  private finishTurn(): void {
    if (this.current && this.turnSnapshot) {
      this.current.undoable = true
      this.undoSnapshot = { messageId: this.current.id, ...this.turnSnapshot }
      for (const msg of this.messages) if (msg !== this.current) msg.undoable = false
    }
    if (this.current && !this.current.text && !this.current.actions.length && !this.error) this.current.text = '(no reply)'
    this.turnSnapshot = null
    this.current = null
    this.busy = false
    this.push(true)
  }

  private fail(message: string): void {
    this.error = message
    this.finishTurn()
  }

  // ─── Public ───────────────────────────────────────────────────────────────

  async send(userText: string): Promise<void> {
    const t = userText.trim()
    if (!t || this.busy) return
    this.error = null
    this.messages.push({ id: uid(), role: 'user', text: t, actions: [], at: Date.now() })
    this.current = { id: uid(), role: 'assistant', text: '', actions: [], at: Date.now() }
    this.messages.push(this.current)
    this.busy = true
    this.turnSnapshot = null
    this.push(true)
    try {
      const input = await this.ensureSession()
      input.push({
        type: 'user',
        message: { role: 'user', content: `<board>\n${this.board()}\n</board>\n\n${t}` },
        parent_tool_use_id: null
      })
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err))
    }
  }

  async stop(): Promise<void> {
    if (!this.busy || !this.query) return
    try {
      await this.query.interrupt()
    } catch {
      this.close()
      this.finishTurn()
    }
  }

  undo(): void {
    const snap = this.undoSnapshot
    if (!snap || this.busy) return
    this.deps.replaceMeta(snap.meta)
    this.deps.replaceData(snap.data)
    const msg = this.messages.find((m) => m.id === snap.messageId)
    if (msg) {
      msg.undoable = false
      msg.actions.push({ text: 'Undone: the board is back to how it was before this reply', ok: true })
    }
    this.undoSnapshot = null
    this.push(true)
  }

  reset(): void {
    this.close()
    this.messages = []
    this.error = null
    this.busy = false
    this.current = null
    this.undoSnapshot = null
    this.push(true)
  }

  close(): void {
    this.input?.close()
    try {
      this.query?.close()
    } catch {
      // already gone
    }
    this.query = null
    this.input = null
  }
}
