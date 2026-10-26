import { spawnSync } from 'child_process'
import { homedir } from 'os'
import type { Connection } from '@shared/types'

// Passwords live in the system keyring (KWallet / GNOME Keyring, through the Secret Service
// and `secret-tool`), never in Left Off's own files; threads.json only keeps their names.
// Servers are plain SSH details: the private key stays wherever it is, only its path is kept.
// No Electron imports: the CLI uses this too.

const attrs = (name: string): string[] => ['service', 'leftoff', 'name', name]

export function storeSecret(name: string, value: string): void {
  const r = spawnSync('secret-tool', ['store', `--label=Left Off: ${name}`, ...attrs(name)], { input: value })
  if (r.error) throw new Error(`secret-tool isn't available (${r.error.message}). Install libsecret (it provides secret-tool).`)
  if (r.status !== 0) throw new Error(`Couldn't save to the keyring: ${r.stderr.toString().trim()}`)
}

export function lookupSecret(name: string): string | null {
  const r = spawnSync('secret-tool', ['lookup', ...attrs(name)])
  return r.status === 0 ? r.stdout.toString() : null
}

export function clearSecret(name: string): void {
  spawnSync('secret-tool', ['clear', ...attrs(name)])
}

const expand = (p: string): string => (p.startsWith('~/') ? homedir() + p.slice(1) : p)

export function sshArgs(c: Connection, command: string[] = []): string[] {
  return [...(c.key ? ['-i', expand(c.key)] : []), ...(c.port ? ['-p', String(c.port)] : []), `${c.user}@${c.host}`, ...command]
}

// "root@1.2.3.4" or "root@1.2.3.4:2222" → parts.
export function parseTarget(target: string): { user: string; host: string; port?: number } {
  const m = target.trim().match(/^([^@\s]+)@([^:\s]+)(?::(\d+))?$/)
  if (!m) throw new Error(`Give the server as user@host (or user@host:port), not "${target}"`)
  return { user: m[1], host: m[2], ...(m[3] ? { port: Number(m[3]) } : {}) }
}
