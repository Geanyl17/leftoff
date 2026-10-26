import { contextBridge, ipcRenderer } from 'electron'
import type { ChatState, Connection, OpenTarget, ProjectMeta, Settings, Snapshot } from '@shared/types'
import type { ThreadAction } from '@shared/threads'

type Result = Promise<{ ok: boolean; error?: string }>

const api = {
  snapshot: (): Promise<Snapshot> => ipcRenderer.invoke('snapshot'),
  scan: (): Promise<Snapshot> => ipcRenderer.invoke('scan'),

  updateMeta: (id: string, patch: Partial<ProjectMeta>): Promise<ProjectMeta> =>
    ipcRenderer.invoke('meta:update', id, patch),
  updateSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:update', patch),
  pickRoot: (): Promise<string | null> => ipcRenderer.invoke('roots:pick'),
  claudeStatus: (): Promise<{ command: boolean; skill: boolean; hook: boolean }> => ipcRenderer.invoke('claude:status'),
  claudeSetup: (): Promise<{ ok: boolean; done: string[]; error?: string }> => ipcRenderer.invoke('claude:setup'),

  thread: (id: string, action: ThreadAction): Result => ipcRenderer.invoke('thread', id, action),
  customCreate: (name: string, sessions: string[]): Result => ipcRenderer.invoke('custom:create', name, sessions),
  customLink: (id: string, sessions: string[]): Result => ipcRenderer.invoke('custom:link', id, sessions),
  customRemove: (id: string): Result => ipcRenderer.invoke('custom:remove', id),
  customBind: (id: string): Result => ipcRenderer.invoke('custom:bind', id),
  serverSave: (c: Connection): Result => ipcRenderer.invoke('server:save', c),
  serverRemove: (name: string): Result => ipcRenderer.invoke('server:remove', name),
  serverOpen: (name: string): Promise<void> => ipcRenderer.invoke('server:open', name),
  secretSave: (name: string, value: string, project: string | undefined, note: string): Result =>
    ipcRenderer.invoke('secret:save', name, value, project, note),
  secretRemove: (name: string): Result => ipcRenderer.invoke('secret:remove', name),
  secretCopy: (name: string): Result => ipcRenderer.invoke('secret:copy', name),
  sshKeys: (): Promise<string[]> => ipcRenderer.invoke('ssh:keys'),
  log: (id: string, text: string): Result => ipcRenderer.invoke('log', id, text),
  open: (id: string, target: OpenTarget, arg?: string): Promise<void> => ipcRenderer.invoke('open', id, target, arg),

  chatGet: (): Promise<ChatState> => ipcRenderer.invoke('chat:get'),
  chatSend: (text: string): Promise<void> => ipcRenderer.invoke('chat:send', text),
  chatStop: (): Promise<void> => ipcRenderer.invoke('chat:stop'),
  chatUndo: (): Promise<void> => ipcRenderer.invoke('chat:undo'),
  chatReset: (): Promise<void> => ipcRenderer.invoke('chat:reset'),

  // Events from main → renderer; each returns an unsubscribe function.
  onSnapshot: (cb: (s: Snapshot) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, s: Snapshot): void => cb(s)
    ipcRenderer.on('snapshot', listener)
    return () => ipcRenderer.removeListener('snapshot', listener)
  },
  onChat: (cb: (s: ChatState) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, s: ChatState): void => cb(s)
    ipcRenderer.on('chat', listener)
    return () => ipcRenderer.removeListener('chat', listener)
  },
  onFocusProject: (cb: (id: string) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, id: string): void => cb(id)
    ipcRenderer.on('focus-project', listener)
    return () => ipcRenderer.removeListener('focus-project', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type API = typeof api
