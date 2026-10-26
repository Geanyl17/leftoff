import { useEffect, useState } from 'react'
import { Copy, SquareTerminal, X } from 'lucide-react'
import type { Snapshot } from '@shared/types'
import type { ProjectView } from '../lib/view'

// A project's servers (SSH details Claude can use: `leftoff ssh <name>`) and passwords (kept
// in the system keyring; only their names are stored here). Without a project: everything.
export function Vault({ snap, project, onClose }: { snap: Snapshot; project?: ProjectView; onClose: () => void }) {
  const api = window.api
  const servers = Object.values(snap.connections).filter((c) => !project || c.project === project.id)
  const secrets = Object.values(snap.secrets).filter((s) => !project || s.project === project.id)
  const projectName = (id?: string): string => (id ? (snap.projects.find((p) => p.id === id)?.name ?? '') : '')

  const [keys, setKeys] = useState<string[]>([])
  const [server, setServer] = useState({ name: project?.p.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-') ?? '', target: '', key: '', note: '' })
  const [secret, setSecret] = useState({ name: '', value: '', note: '' })
  const [message, setMessage] = useState('')

  useEffect(() => {
    void api.sshKeys().then(setKeys)
  }, [api])

  const saveServer = async (): Promise<void> => {
    const m = server.target.trim().match(/^([^@\s]+)@([^:\s]+)(?::(\d+))?$/)
    if (!m) return setMessage('Give the server as user@host, or user@host:port')
    const res = await api.serverSave({
      name: server.name.trim(),
      user: m[1],
      host: m[2],
      ...(m[3] ? { port: Number(m[3]) } : {}),
      ...(server.key ? { key: server.key } : {}),
      ...(project ? { project: project.id } : {}),
      ...(server.note.trim() ? { note: server.note.trim() } : {})
    })
    if (!res.ok) return setMessage(res.error ?? '')
    setServer({ name: '', target: '', key: '', note: '' })
    setMessage(`Saved. Claude can now reach it with: leftoff ssh ${server.name.trim()}`)
  }

  const saveSecret = async (): Promise<void> => {
    const res = await api.secretSave(secret.name, secret.value, project?.id, secret.note.trim())
    if (!res.ok) return setMessage(res.error ?? '')
    setSecret({ name: '', value: '', note: '' })
    setMessage('Saved to your system keyring.')
  }

  const copy = async (name: string): Promise<void> => {
    const res = await api.secretCopy(name)
    setMessage(res.ok ? `Copied ${name}. The clipboard clears in 30 seconds.` : (res.error ?? ''))
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{project ? `${project.name}: servers & passwords` : 'Servers & passwords'}</h2>
          <button className="icon-btn" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="modal-body">
          <h3>Servers</h3>
          <p className="hint">Every Claude session is told about these, so you can say "fix nginx on {servers[0]?.name ?? 'myserver'}" without pasting an IP or key.</p>
          {servers.length > 0 && (
            <ul className="vault-list">
              {servers.map((c) => (
                <li key={c.name}>
                  <div className="vault-main">
                    <span className="vault-name">{c.name}</span>
                    <span className="vault-meta">
                      {c.user}@{c.host}
                      {c.port ? `:${c.port}` : ''} · {c.key ?? 'default key'}
                      {!project && c.project ? ` · ${projectName(c.project)}` : ''}
                    </span>
                  </div>
                  <button className="link" onClick={() => api.serverOpen(c.name)} title="Open a terminal on this server">
                    <SquareTerminal size={13} /> SSH
                  </button>
                  <button className="icon-btn small" title="Remove" onClick={() => api.serverRemove(c.name)}>
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="vault-form">
            <input className="input" placeholder="Name, e.g. prod-box" value={server.name} onChange={(e) => setServer({ ...server, name: e.target.value })} />
            <input className="input" placeholder="user@host or user@host:port" value={server.target} onChange={(e) => setServer({ ...server, target: e.target.value })} />
            <select className="input" value={server.key} onChange={(e) => setServer({ ...server, key: e.target.value })}>
              <option value="">Default key (ssh-agent, ~/.ssh/config)</option>
              {keys.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <button className="btn" disabled={!server.name.trim() || !server.target.trim()} onClick={saveServer}>
              Add server
            </button>
          </div>

          <h3>Passwords</h3>
          <p className="hint">Stored in your system keyring (KWallet / GNOME Keyring), not in Left Off's files. Claude only sees the names, and can use one without seeing it.</p>
          {secrets.length > 0 && (
            <ul className="vault-list">
              {secrets.map((s) => (
                <li key={s.name}>
                  <div className="vault-main">
                    <span className="vault-name">{s.name}</span>
                    {(s.note || (!project && s.project)) && (
                      <span className="vault-meta">{[s.note, !project ? projectName(s.project) : ''].filter(Boolean).join(' · ')}</span>
                    )}
                  </div>
                  <button className="link" onClick={() => copy(s.name)}>
                    <Copy size={13} /> Copy
                  </button>
                  <button className="icon-btn small" title="Remove" onClick={() => api.secretRemove(s.name)}>
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="vault-form">
            <input className="input" placeholder="Name, e.g. prod-db" value={secret.name} onChange={(e) => setSecret({ ...secret, name: e.target.value })} />
            <input className="input" type="password" placeholder="Password" value={secret.value} onChange={(e) => setSecret({ ...secret, value: e.target.value })} />
            <input className="input" placeholder="Note (optional)" value={secret.note} onChange={(e) => setSecret({ ...secret, note: e.target.value })} />
            <button className="btn" disabled={!secret.name.trim() || !secret.value} onClick={saveSecret}>
              Add password
            </button>
          </div>
          {message && <p className="hint vault-message">{message}</p>}
        </div>
      </div>
    </div>
  )
}
