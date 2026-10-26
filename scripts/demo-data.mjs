// Builds a throwaway set of made-up projects, with sessions and tasks, for trying Left Off or
// taking screenshots without showing anyone your real work.
//
//   node scripts/demo-data.mjs /tmp/leftoff-demo
//   XDG_CONFIG_HOME=/tmp/leftoff-demo/config npm start
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'

const out = resolve(process.argv[2] ?? 'leftoff-demo')
const root = join(out, 'projects')
const config = join(out, 'config', 'leftoff')
const H = 3600_000
const D = 24 * H
const now = Date.now()

rmSync(out, { recursive: true, force: true })
mkdirSync(config, { recursive: true })

// name, category, hours since last commit, commit subjects (newest last)
const projects = [
  ['client-dashboard', 'work', 2, ['Add CSV export', 'Fix export timezone bug (#212)', 'Migrate permissions table for roles']],
  ['recipe-box', 'side', 5, ['Recipe list screen', 'Save recipes offline with SQLite', 'Fix duplicate save']],
  ['discord-study-bot', 'side', 26, ['Pomodoro command', 'Voice channel timers', 'Add /focus command']],
  ['api-gateway', 'work', 30, ['Rate limiting middleware', 'Rate-limit headers', 'Grafana panel for 429s']],
  ['portfolio-site', 'side', 50, ['Move to Astro', 'Dark mode', 'Projects page rewrite']],
  ['budget-tracker', 'side', 9 * 24, ['CSV import', 'Monthly category chart']],
  ['game-jam-2026', 'side', 24 * 24, ['Jam build', 'Final submission']],
  ['dotfiles', 'side', 40 * 24, ['nvim config', 'zsh prompt']]
]

const git = (cwd, args, when) =>
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Demo',
      GIT_AUTHOR_EMAIL: 'demo@example.com',
      GIT_COMMITTER_NAME: 'Demo',
      GIT_COMMITTER_EMAIL: 'demo@example.com',
      ...(when ? { GIT_AUTHOR_DATE: new Date(when).toISOString(), GIT_COMMITTER_DATE: new Date(when).toISOString() } : {})
    }
  })

for (const [name, , hours, commits] of projects) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  commits.forEach((subject, i) => {
    writeFileSync(join(dir, 'notes.txt'), `${subject}\n`)
    git(dir, ['add', '.'])
    git(dir, ['commit', '-q', '-m', subject], now - (hours + (commits.length - 1 - i) * 20) * H)
  })
}
writeFileSync(join(root, 'client-dashboard', 'roles.ts'), 'export const roles = []\n') // some uncommitted work

let n = 0
const id = () => (++n).toString(36).padStart(4, 'x')
const task = (title, { note = '', status = 'paused', priority, ago = 3 * H, by = 'claude' } = {}) => ({
  id: id(), title, status, ...(priority ? { priority } : {}), note, next: '', reason: '', branch: 'main', sessionId: '',
  by, createdAt: now - ago - H, updatedAt: now - ago, history: []
})
const entry = (text, ago, by = 'claude') => ({ id: id(), at: now - ago, by, text, sessionId: '', branch: 'main' })
const p = (name) => join(root, name)

const threads = {
  [p('client-dashboard')]: [
    task('Role-based access UI', { status: 'active', note: 'Permissions table is migrated; the settings page still shows every option to everyone.', ago: 2 * H }),
    task("Review Sam's PR #215", { priority: 'high', note: 'Touches the export code I just changed.', ago: 5 * H, by: 'you' }),
    task('Upgrade to Node 24', { note: 'Blocked on the PDF library; check its next release.', ago: 2 * D })
  ],
  [p('recipe-box')]: [
    task('Fix Android image upload crash', { priority: 'high', note: 'Crashes in ImagePicker on Android 15 with photos over 10 MB.', ago: 5 * H }),
    task('Offline sync conflict handling', { status: 'active', note: 'Suggested: last-write-wins per field instead of per recipe.', ago: 6 * H }),
    task('Ship a TestFlight build', { ago: 3 * D })
  ],
  [p('discord-study-bot')]: [
    task('Reminders fire twice after a restart', { priority: 'high', note: 'The scheduler re-registers jobs on boot without clearing the old ones.', ago: 26 * H }),
    task('Add /focus command', { status: 'done', ago: 27 * H })
  ],
  [p('api-gateway')]: [task('Load test the new rate limits', { note: 'Suggested: k6 against staging at 2x peak.', ago: 30 * H })],
  [p('portfolio-site')]: [task('Write the recipe-box case study', { ago: 50 * H, by: 'you' })],
  [p('budget-tracker')]: [
    task('Handle split transactions', { ago: 9 * D }),
    task('Auto-categorize by merchant', { note: 'Suggested, not started: map merchant names to categories after import.', ago: 9 * D })
  ]
}

const log = {
  [p('client-dashboard')]: [entry('Fixed the CSV export timezone bug (PR #212) and migrated the permissions table for roles. The role UI is not wired up yet.', 2 * H)],
  [p('recipe-box')]: [entry('Added offline caching for saved recipes with SQLite and fixed the duplicate-save bug. Image upload still crashes on Android.', 5 * H)],
  [p('discord-study-bot')]: [entry('Pomodoro timers work in voice channels and /focus is done. Found that reminders fire twice after a restart.', 26 * H)],
  [p('api-gateway')]: [entry('Added rate-limit headers and a Grafana panel for 429s. Limits are untested under real load.', 30 * H)],
  [p('portfolio-site')]: [entry('Rewrote the projects page in Astro and added dark mode. Lighthouse is at 98.', 50 * H, 'you')],
  [p('budget-tracker')]: [entry('Imported last year’s bank CSVs and built the monthly category chart.', 9 * D)]
}

const meta = Object.fromEntries(
  projects.map(([name, category]) => [p(name), { alias: '', category, status: 'active', pinned: name === 'client-dashboard', hidden: false }])
)

writeFileSync(join(config, 'threads.json'), JSON.stringify({ version: 2, projects: threads, log }, null, 2))
writeFileSync(
  join(config, 'config.json'),
  JSON.stringify({ settings: { roots: [root], autostart: false, startHidden: false, autoRecord: false, opacity: 1, chatModel: 'claude-opus-5-5' }, meta, autolog: {}, autologLastRun: Date.now() }, null, 2)
)
console.log(`Demo projects in ${root}\nRun: XDG_CONFIG_HOME=${join(out, 'config')} npm start`)
