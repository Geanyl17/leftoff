import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, CircleX, LoaderCircle, RotateCcw, Square, Undo2, X } from 'lucide-react'
import type { ChatState } from '@shared/types'
import { Brief } from './ui'

const SUGGESTIONS = [
  'What should I pick up today?',
  'What was I doing in my most recent project?',
  'Which tasks are marked high priority?',
  "Hide projects I haven't touched in two months"
]

const MODEL_LABEL: Record<string, string> = {
  'claude-opus-5-5': 'Opus 5.5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-haiku-5-5': 'Haiku 5.5'
}

interface Props {
  state: ChatState
  focusKey: number
  onClose: () => void
}

export function Chat({ state, focusKey, onClose }: Props) {
  const api = window.api
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [focusKey])

  // Keep the newest text in view while a reply streams in.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state])

  const send = (text = draft): void => {
    if (!text.trim() || state.busy) return
    void api.chatSend(text)
    setDraft('')
  }

  const last = state.messages[state.messages.length - 1]

  return (
    <aside className="chat">
      <header className="chat-head">
        <span className="chat-title">Assistant</span>
        <span className="chat-model">{MODEL_LABEL[state.model] ?? state.model}</span>
        <button className="icon-btn" title="New chat" onClick={() => api.chatReset()} disabled={!state.messages.length}>
          <RotateCcw size={15} />
        </button>
        <button className="icon-btn" title="Close (Ctrl+K)" onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      <div className="chat-list" ref={listRef}>
        {!state.messages.length && (
          <div className="chat-empty">
            <p>
              Ask about your projects, or tell me to add or finish tasks, write down what you did, or pin, tag and hide projects.
            </p>
            <div className="chat-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chat-suggestion" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {state.messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="msg msg-user">
              {m.text}
            </div>
          ) : (
            <div key={m.id} className="msg msg-assistant">
              {m.text ? (
                <Brief text={m.text} />
              ) : (
                state.busy &&
                m === last && (
                  <div className="msg-thinking">
                    <LoaderCircle size={14} className="spin" /> Thinking…
                  </div>
                )
              )}
              {m.actions.length > 0 && (
                <ul className="msg-actions">
                  {m.actions.map((a, i) => (
                    <li key={i} className={a.ok ? 'ok' : 'bad'}>
                      {a.ok ? <Check size={12} /> : <CircleX size={12} />}
                      <span>{a.text}</span>
                    </li>
                  ))}
                </ul>
              )}
              {m.undoable && !state.busy && (
                <button className="btn small msg-undo" onClick={() => api.chatUndo()}>
                  <Undo2 size={13} /> Undo these changes
                </button>
              )}
            </div>
          )
        )}

        {state.error && <div className="error-box">{state.error}</div>}
      </div>

      <footer className="chat-input">
        <textarea
          ref={inputRef}
          className="input"
          placeholder="Ask, or tell me what to change…"
          value={draft}
          rows={Math.min(6, Math.max(1, draft.split('\n').length))}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        {state.busy ? (
          <button className="chat-send stop" title="Stop" onClick={() => api.chatStop()}>
            <Square size={13} />
          </button>
        ) : (
          <button className="chat-send" title="Send (Enter)" onClick={() => send()} disabled={!draft.trim()}>
            <ArrowUp size={16} />
          </button>
        )}
      </footer>
      <div className="chat-foot">Uses your Claude Code login. Changes can be undone.</div>
    </aside>
  )
}
