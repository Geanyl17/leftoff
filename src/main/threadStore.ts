import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { LogEntry, Thread } from '@shared/threads'
import type { Connection, CustomProject, SecretRef } from '@shared/types'

// threads.json holds what Claude and you record: the session log ("what you did last
// session") and the tasks of each project. The app and the `leftoff` CLI (run by Claude
// inside sessions) both write it, so writers take a lock file and replace the file
// atomically. No Electron imports: the CLI uses this too.

export const DATA_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'leftoff')
export const THREADS_FILE = join(DATA_DIR, 'threads.json')
const LOCK_FILE = THREADS_FILE + '.lock'

export type ThreadDb = Record<string, Thread[]>
export type LogDb = Record<string, LogEntry[]>
export type CustomDb = Record<string, CustomProject>

export interface LeftOffData {
  threads: ThreadDb
  log: LogDb
  custom: CustomDb
  connections: Record<string, Connection>
  secrets: Record<string, SecretRef> // names only; values are in the system keyring
}

export function readData(): LeftOffData {
  try {
    const raw = JSON.parse(readFileSync(THREADS_FILE, 'utf8'))
    return { threads: raw.projects ?? {}, log: raw.log ?? {}, custom: raw.custom ?? {}, connections: raw.connections ?? {}, secrets: raw.secrets ?? {} }
  } catch {
    return { threads: {}, log: {}, custom: {}, connections: {}, secrets: {} }
  }
}

export const readThreads = (): ThreadDb => readData().threads
export const readLog = (): LogDb => readData().log

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function lock(): () => void {
  mkdirSync(DATA_DIR, { recursive: true })
  const deadline = Date.now() + 3000
  for (;;) {
    try {
      closeSync(openSync(LOCK_FILE, 'wx'))
      return () => {
        try {
          unlinkSync(LOCK_FILE)
        } catch {
          // already gone
        }
      }
    } catch {
      // A lock this old was left by a writer that died mid-write.
      try {
        if (Date.now() - statSync(LOCK_FILE).mtimeMs > 10_000) unlinkSync(LOCK_FILE)
      } catch {
        // raced with its owner releasing it
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${LOCK_FILE}`)
      sleep(25)
    }
  }
}

export function updateData<T>(fn: (data: LeftOffData) => T): T {
  const release = lock()
  try {
    const data = readData()
    const result = fn(data)
    const tmp = `${THREADS_FILE}.${process.pid}.tmp`
    writeFileSync(
      tmp,
      JSON.stringify({ version: 2, projects: data.threads, log: data.log, custom: data.custom, connections: data.connections, secrets: data.secrets }, null, 2)
    )
    renameSync(tmp, THREADS_FILE)
    return result
  } finally {
    release()
  }
}

export const updateThreads = <T>(fn: (db: ThreadDb) => T): T => updateData((d) => fn(d.threads))

export const slugify = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'

// Finds a folderless project by id, name or slug, or creates it; links any given sessions.
export function upsertCustom(d: LeftOffData, name: string, sessions: string[] = []): CustomProject {
  const q = name.trim().toLowerCase()
  if (!q) throw new Error('A project needs a name')
  let p = Object.values(d.custom).find((c) => c.id === name || c.name.toLowerCase() === q || c.id === `custom:${slugify(name)}`)
  if (!p) {
    let id = `custom:${slugify(name)}`
    for (let i = 2; d.custom[id]; i++) id = `custom:${slugify(name)}-${i}`
    p = { id, name: name.trim(), sessions: [], createdAt: Date.now() }
    d.custom[id] = p
  }
  for (const s of sessions) {
    // A session belongs to one folderless project at a time.
    for (const other of Object.values(d.custom)) other.sessions = other.sessions.filter((x) => x !== s)
    p.sessions.push(s)
  }
  return p
}

// Moves a project's tasks, session entries, servers and passwords onto another project.
function moveRecords(d: LeftOffData, fromId: string, toId: string): void {
  d.threads[toId] = [...(d.threads[toId] ?? []), ...(d.threads[fromId] ?? [])]
  d.log[toId] = [...(d.log[toId] ?? []), ...(d.log[fromId] ?? [])].sort((a, b) => b.at - a.at)
  delete d.threads[fromId]
  delete d.log[fromId]
  for (const s of Object.values(d.connections)) if (s.project === fromId) s.project = toId
  for (const s of Object.values(d.secrets)) if (s.project === fromId) s.project = toId
}

// A folderless project gets a real folder: everything recorded moves onto the folder's
// project, and the folderless one stays behind only to point its sessions there.
export function bindCustom(d: LeftOffData, customId: string, folderId: string): void {
  const c = d.custom[customId]
  if (!c) throw new Error('That project no longer exists')
  moveRecords(d, customId, folderId)
  c.boundTo = folderId
}

// Two folderless projects for the same thing: the first one's sessions and records join the
// second, and the first is removed.
export function mergeCustom(d: LeftOffData, fromId: string, intoId: string): void {
  const from = d.custom[fromId]
  const into = d.custom[intoId]
  if (!from || !into) throw new Error('Only projects without a folder can be merged')
  if (fromId === intoId) throw new Error("That's the same project")
  moveRecords(d, fromId, intoId)
  into.sessions = [...new Set([...into.sessions, ...from.sessions])]
  for (const c of Object.values(d.custom)) if (c.boundTo === fromId) c.boundTo = intoId
  delete d.custom[fromId]
}
