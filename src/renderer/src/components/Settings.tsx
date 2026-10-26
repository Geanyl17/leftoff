import { useEffect, useState } from 'react'
import { Check, FolderOpen, Plus, X } from 'lucide-react'
import type { Snapshot } from '@shared/types'
import { Toggle } from './ui'

const CHAT_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' }
]

export function Settings({ snap, onClose, onOpenVault }: { snap: Snapshot; onClose: () => void; onOpenVault: () => void }) {
  const api = window.api
  const s = snap.settings
  const [claude, setClaude] = useState<{ command: boolean; skill: boolean; hook: boolean } | null>(null)
  const [setupLog, setSetupLog] = useState<string[]>([])

  useEffect(() => {
    void api.claudeStatus().then(setClaude)
  }, [api])

  const connect = async (): Promise<void> => {
    const res = await api.claudeSetup()
    setSetupLog(res.ok ? (res.done.length ? res.done : ['Already set up.']) : [res.error ?? 'Setup failed'])
    setClaude(await api.claudeStatus())
  }
  const connected = !!claude && claude.command && claude.skill && claude.hook

  const addRoot = async (): Promise<void> => {
    const dir = await api.pickRoot()
    if (dir && !s.roots.includes(dir)) await api.updateSettings({ roots: [...s.roots, dir] })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div className="modal-body">
          <h3>Project folders</h3>
          <ul className="roots">
            {s.roots.map((r) => (
              <li key={r}>
                <FolderOpen size={14} />
                <span className="mono">{r}</span>
                <button
                  className="icon-btn small"
                  disabled={s.roots.length === 1}
                  onClick={() => api.updateSettings({ roots: s.roots.filter((x) => x !== r) })}
                >
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
          <button className="btn" onClick={addRoot}>
            <Plus size={14} /> Add folder
          </button>

          <h3>Startup</h3>
          <Toggle label="Open when I log in" checked={s.autostart} onChange={(v) => api.updateSettings({ autostart: v })} />
          <Toggle
            label="Start in the tray"
            hint="Stay in the system tray at login instead of opening the window"
            checked={s.startHidden}
            onChange={(v) => api.updateSettings({ startHidden: v })}
          />

          <h3>Window</h3>
          <label className="slider-row">
            <span>Background opacity</span>
            <input
              type="range"
              min={60}
              max={100}
              step={5}
              value={Math.round(s.opacity * 100)}
              onChange={(e) => api.updateSettings({ opacity: Number(e.target.value) / 100 })}
            />
            <span className="slider-value">{Math.round(s.opacity * 100)}%</span>
          </label>

          <h3>Assistant model</h3>
          <div className="segmented">
            {CHAT_MODELS.map((m) => (
              <button key={m.id} className={s.chatModel === m.id ? 'on' : ''} onClick={() => api.updateSettings({ chatModel: m.id })}>
                {m.label}
              </button>
            ))}
          </div>

          <h3>Servers & passwords</h3>
          <p className="hint">SSH servers Claude can reach by name, and passwords kept in your system keyring.</p>
          <button className="btn" onClick={onOpenVault}>
            Open servers & passwords
          </button>

          <h3>Claude Code</h3>
          <p className="hint">
            Claude records what got done and what's still ongoing through the <span className="mono">leftoff</span> skill. Type{' '}
            <span className="mono">/leftoff</span> in any session to record right away.
          </p>
          {claude && (
            <ul className="setup-status">
              {(
                [
                  ['command', 'leftoff command on your PATH'],
                  ['skill', 'leftoff skill'],
                  ['hook', 'Session-start hook']
                ] as const
              ).map(([k, label]) => (
                <li key={k} className={claude[k] ? 'ok' : ''}>
                  {claude[k] ? <Check size={13} /> : <X size={13} />} {label}
                </li>
              ))}
            </ul>
          )}
          {claude && !connected && (
            <button className="btn primary" onClick={connect}>
              Connect Claude Code
            </button>
          )}
          {setupLog.map((l, i) => (
            <p key={i} className="hint">
              {l}
            </p>
          ))}
          <Toggle
            label="Record missed sessions automatically"
            hint="Every 8 hours, sessions that ended without being recorded get read by Claude, which records what got done plus anything unfinished or suggested but not done. One small Haiku call (about 6k tokens) per session of 4+ prompts."
            checked={s.autoRecord}
            onChange={(v) => api.updateSettings({ autoRecord: v })}
          />
          {snap.errors.map((e, i) => (
            <div key={i} className="error">
              {e}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
