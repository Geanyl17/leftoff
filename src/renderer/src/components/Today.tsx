import { Flag } from 'lucide-react'
import { dueLabel, todayYmd } from '@shared/threads'
import type { ProjectView } from '../lib/view'

// The top of the window: what's late and what's due this week, across every project,
// so a deadline never hides inside a collapsed card. Shows nothing when nothing's dated.
export function Today({ views, onPick }: { views: ProjectView[]; onPick: (id: string) => void }) {
  const today = todayYmd()
  const week = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10)
  const items = views
    .flatMap((v) => v.tasks.filter((t) => t.due && t.due <= week && t.kind !== 'idea').map((t) => ({ t, v })))
    .sort((a, b) => a.t.due!.localeCompare(b.t.due!))
  if (!items.length) return null
  const late = items.filter((x) => x.t.due! < today).length

  return (
    <section className="today">
      <div className="today-head">
        <span>This week</span>
        {late > 0 && <span className="today-late">{late} late</span>}
      </div>
      <ul>
        {items.slice(0, 8).map(({ t, v }) => (
          <li key={`${v.id}:${t.id}`} onClick={() => onPick(v.id)} title={t.note || undefined}>
            <span className={`today-when ${t.due! < today ? 'late' : ''}`}>{dueLabel(t.due!, today)}</span>
            <span className="today-title">
              {t.priority === 'high' && <Flag size={11} className="task-flag" />}
              {t.title}
            </span>
            <span className="today-project">{v.name}</span>
          </li>
        ))}
      </ul>
      {items.length > 8 && <div className="today-more">and {items.length - 8} more</div>}
    </section>
  )
}
