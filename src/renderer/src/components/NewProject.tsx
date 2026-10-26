import { useState } from 'react'
import { X } from 'lucide-react'
import type { ClaudeSession } from '@shared/types'
import { timeAgo } from '@shared/time'
import type { ProjectView } from '../lib/view'

const shortDir = (dir: string): string => (dir.startsWith('/') ? dir.replace(/^\/(var\/)?home\/[^/]+/, '~') : 'unknown folder')

// Create a project that has no folder (or link more sessions to one): a name plus the
// Claude sessions that belong to it, picked from recent sessions outside every project folder.
export function NewProject({ sessions, project, onClose }: { sessions: ClaudeSession[]; project?: ProjectView; onClose: () => void }) {
  const api = window.api
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')

  const toggle = (id: string): void => {
    const next = new Set(picked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPicked(next)
  }

  const save = async (): Promise<void> => {
    const ids = [...picked]
    const res = project ? await api.customLink(project.id, ids) : await api.customCreate(name, ids)
    if (!res.ok) return setError(res.error ?? 'Something went wrong')
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>{project ? `Link sessions to ${project.name}` : 'New project'}</h2>
          <button className="icon-btn" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="modal-body">
          {!project && (
            <>
              <p className="hint">For work that has no folder of its own, like a Claude session you started in your home folder. Folders inside your project folders show up by themselves.</p>
              <input className="input" autoFocus placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
            </>
          )}
          <h3>Claude sessions</h3>
          {sessions.length ? (
            <ul className="session-pick">
              {sessions.map((s) => (
                <li key={s.id}>
                  <label>
                    <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} />
                    <span className="session-pick-title">{s.title}</span>
                    <span className="session-pick-meta">
                      {shortDir(s.dir)} · {timeAgo(s.updated)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">No recent Claude sessions outside your project folders.</p>
          )}
          <p className="hint">
            Or, from inside that session, ask Claude to run <span className="mono">leftoff project "{project?.name ?? 'name'}"</span>, which links the session for you.
          </p>
          {error && <div className="error">{error}</div>}
          <div className="row-actions">
            <button className="btn primary" disabled={!project && !name.trim()} onClick={save}>
              {project ? 'Link' : 'Create project'}
            </button>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
