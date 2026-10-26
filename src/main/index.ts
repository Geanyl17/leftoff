import { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import { join } from 'path'
import { spawn } from 'child_process'
import { mkdirSync, readdirSync, watch } from 'fs'
import { writeFile } from 'fs/promises'
import Store from 'electron-store'
import { applyThreadAction, recordSession, type Actor, type ThreadAction } from '@shared/threads'
import { defaultMeta, type ClaudeSession, type Connection, type OpenTarget, type ProjectMeta, type ProjectScan, type Settings, type Snapshot } from '@shared/types'
import { timeAgo } from '@shared/time'
import { scanProjects } from './scanner'
import { initClaudeCache } from './claude'
import { DEFAULT_SETTINGS } from './seed'
import { detectRoots, projectFor } from './roots'
import { claudeSetupStatus, setupClaude } from './claudeSetup'
import { ensureLauncher, loadShellPath, openEditor, openTerminal, setAutostart } from './system'
import { DATA_DIR, bindCustom, readData, readLog, readThreads, updateData, updateThreads, upsertCustom } from './threadStore'
import { Assistant } from './assistant'
import { clearSecret, lookupSecret, sshArgs, storeSecret } from './vault'

const DUMP = process.env.LEFTOFF_DUMP ?? ''
const SHOT = process.env.LEFTOFF_SCREENSHOT ?? ''
const SCAN_EVERY = 90_000
const RESOURCES = join(app.getAppPath(), 'resources')

interface StoreShape {
  settings: Settings
  meta: Record<string, ProjectMeta>
  autolog: Record<string, { prompts: number; at: number }> // sessions already auto-recorded
  autologLastRun: number
}

const store = new Store<StoreShape>({ defaults: { settings: DEFAULT_SETTINGS, meta: {}, autolog: {}, autologLastRun: 0 } })

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

let projects: ProjectScan[] = []
let unassigned: ClaudeSession[] = []
let scannedAt = 0
let scanning: Promise<void> | null = null
let errors: string[] = []

const settings = (): Settings => ({ ...DEFAULT_SETTINGS, ...store.get('settings') })
const allMeta = (): Record<string, ProjectMeta> => store.get('meta')
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function snapshot(): Snapshot {
  const data = readData()
  return {
    projects,
    meta: allMeta(),
    threads: data.threads,
    log: data.log,
    unassigned,
    connections: data.connections,
    secrets: data.secrets,
    settings: settings(),
    scannedAt,
    scanning: scanning !== null,
    errors
  }
}

function push(): void {
  mainWindow?.webContents.send('snapshot', snapshot())
  refreshTray()
}

// ─── Sessions & tasks ───────────────────────────────────────────────────────

// Claude records sessions and tasks through the `leftoff` CLI from inside its sessions;
// show them as they land rather than on the next scan.
function watchData(): void {
  mkdirSync(DATA_DIR, { recursive: true })
  let timer: NodeJS.Timeout | null = null
  watch(DATA_DIR, (_event, file) => {
    if (file !== 'threads.json') return
    if (timer) clearTimeout(timer)
    timer = setTimeout(push, 120)
  })
}

function threadAction(id: string, action: ThreadAction, by: Actor = 'you'): { ok: boolean; error?: string } {
  const project = projects.find((p) => p.id === id)
  try {
    updateThreads((db) => {
      db[id] = applyThreadAction(db[id] ?? [], action, { by, now: Date.now(), branch: project?.repos[0]?.branch }).list
    })
    push()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: message(err) }
  }
}

function logSession(id: string, text: string, by: Actor = 'you'): { ok: boolean; error?: string } {
  const project = projects.find((p) => p.id === id)
  try {
    updateData((d) => {
      d.log[id] = recordSession(d.log[id] ?? [], text, { by, now: Date.now(), branch: project?.repos[0]?.branch }).list
    })
    push()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: message(err) }
  }
}

// ─── Automatic recording ────────────────────────────────────────────────────

// Every 8 hours, Claude sessions that ended without the leftoff skill recording them get read
// after the fact (src/cli/autolog.ts): what got done, plus anything left unfinished or
// suggested but not done. Kept cheap: one small Haiku call per session of 4+ prompts, one at
// a time, and a session again only after 10 more prompts.
const AUTO_EVERY = 8 * 3600_000
const AUTO_IDLE = 20 * 60_000 // a session counts as ended after this long without activity
const AUTO_WINDOW = 24 * 3600_000 // how far back the first pass looks
interface AutologJob {
  file: string
  session: string
  prompts: number
  dir: string
}
let autologQueue: AutologJob[] = []
let autologRunning = false

function autoRecord(): void {
  if (!settings().autoRecord || autologRunning) return
  const last = store.get('autologLastRun')
  if (Date.now() - last < AUTO_EVERY) return
  // Overlap the previous pass by the idle time, so a session still going then is caught now.
  const since = last ? Math.max(last - AUTO_IDLE, Date.now() - AUTO_WINDOW) : Date.now() - AUTO_WINDOW
  const marks = store.get('autolog')
  autologQueue = projects.flatMap((p) =>
    p.sessions
      .filter((s) => s.file && s.prompts >= 4 && s.updated > since && Date.now() - s.updated >= AUTO_IDLE)
      .filter((s) => !marks[s.id] || s.prompts - marks[s.id].prompts >= 10)
      .map((s) => ({ file: s.file, session: s.id, prompts: s.prompts, dir: s.dir.startsWith('/') ? s.dir : p.path }))
  )
  store.set('autologLastRun', Date.now())
  runNextAutolog()
}

function runNextAutolog(): void {
  const job = autologQueue.shift()
  if (!job) {
    autologRunning = false
    push()
    return
  }
  autologRunning = true
  const marks = store.get('autolog')
  marks[job.session] = { prompts: job.prompts, at: Date.now() }
  for (const [id, m] of Object.entries(marks)) if (Date.now() - m.at > 7 * 86_400_000) delete marks[id]
  store.set('autolog', marks)
  const child = spawn(
    process.execPath,
    [join(__dirname, 'cli.js'), 'autolog', '--transcript', job.file, '--session', job.session, '--project', job.dir],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' }
  )
  child.on('exit', () => {
    push()
    runNextAutolog()
  })
  child.on('error', runNextAutolog)
}

// ─── Scanning ───────────────────────────────────────────────────────────────

function seedMeta(list: ProjectScan[]): void {
  const meta = allMeta()
  let changed = false
  for (const c of Object.values(readData().custom)) {
    if (!c.boundTo || !meta[c.id]) continue
    meta[c.boundTo] = { ...meta[c.id] }
    delete meta[c.id]
    changed = true
  }
  for (const p of list) {
    if (meta[p.id]) continue
    meta[p.id] = defaultMeta()
    changed = true
  }
  if (changed) store.set('meta', meta)
}

function scan(): Promise<void> {
  if (scanning) return scanning
  scanning = (async () => {
    const errs: string[] = []
    try {
      ;({ projects, unassigned } = await scanProjects(settings().roots))
      seedMeta(projects)
      scannedAt = Date.now()
    } catch (err) {
      errs.push(`Scan failed: ${message(err)}`)
    }
    errors = errs
  })().finally(() => {
    scanning = null
    push()
    if (!DUMP && !SHOT) autoRecord()
  })
  push()
  return scanning
}

// ─── Actions ────────────────────────────────────────────────────────────────

async function openTarget(id: string, target: OpenTarget, arg?: string): Promise<void> {
  const p = projects.find((x) => x.id === id)
  if (!p) return
  if (!p.path && target !== 'claude') return // a project without a folder
  switch (target) {
    case 'code':
      return openEditor(arg ?? p.path)
    case 'terminal':
      return openTerminal(arg ?? p.path)
    case 'folder':
      await shell.openPath(arg ?? p.path)
      return
    case 'github': {
      const repo = p.repos.find((r) => r.path === arg) ?? p.repos.find((r) => r.remote)
      if (repo?.remote) await shell.openExternal(repo.remote.web)
      return
    }
    case 'claude': {
      // `claude --resume` looks the session up by the directory it ran in.
      const s = p.sessions.find((x) => x.id === arg)
      const cwd = s?.dir.startsWith('/') ? s.dir : p.path || app.getPath('home')
      return openTerminal(cwd, s ? ['claude', '--resume', s.id] : ['claude', '--continue'])
    }
  }
}

function updateMeta(id: string, patch: Partial<ProjectMeta>): ProjectMeta {
  const meta = allMeta()
  meta[id] = { ...defaultMeta(), ...meta[id], ...patch }
  store.set('meta', meta)
  return meta[id]
}

// ─── Assistant ──────────────────────────────────────────────────────────────

const assistant = new Assistant({
  projects: () => projects,
  meta: allMeta,
  threads: readThreads,
  log: readLog,
  updateMeta: (id, patch) => {
    const next = updateMeta(id, patch)
    push()
    return next
  },
  replaceMeta: (meta) => {
    store.set('meta', meta)
    push()
  },
  threadAction,
  recordSession: (id, text) => {
    const res = logSession(id, text, 'claude')
    if (!res.ok) throw new Error(res.error)
  },
  replaceData: (data) => {
    updateData((d) => {
      d.threads = data.threads
      d.log = data.log
    })
    push()
  },
  open: openTarget,
  rescan: () => scan(),
  model: () => settings().chatModel,
  cwd: () => app.getPath('userData'),
  onChange: (state) => mainWindow?.webContents.send('chat', state)
})

function registerIpc(): void {
  ipcMain.handle('snapshot', () => snapshot())

  ipcMain.handle('scan', async () => {
    await scan()
    return snapshot()
  })

  ipcMain.handle('meta:update', (_e, id: string, patch: Partial<ProjectMeta>) => {
    const next = updateMeta(id, patch)
    push()
    return next
  })

  ipcMain.handle('settings:update', async (_e, patch: Partial<Settings>) => {
    const next = { ...settings(), ...patch }
    store.set('settings', next)
    if ('autostart' in patch) await setAutostart(next.autostart).catch(() => {})
    if ('roots' in patch) void scan()
    push()
    return next
  })

  ipcMain.handle('thread', (_e, id: string, action: ThreadAction) => threadAction(id, action))
  ipcMain.handle('log', (_e, id: string, text: string) => logSession(id, text))

  ipcMain.handle('chat:get', () => assistant.state())
  ipcMain.handle('chat:send', (_e, text: string) => assistant.send(text))
  ipcMain.handle('chat:stop', () => assistant.stop())
  ipcMain.handle('chat:undo', () => assistant.undo())
  ipcMain.handle('chat:reset', () => assistant.reset())

  ipcMain.handle('open', (_e, id: string, target: OpenTarget, arg?: string) => openTarget(id, target, arg))

  // Folderless projects: a name plus linked Claude sessions.
  const customChange = (fn: () => void): { ok: boolean; error?: string } => {
    try {
      fn()
      void scan()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: message(err) }
    }
  }
  ipcMain.handle('custom:create', (_e, name: string, sessions: string[]) =>
    customChange(() => updateData((d) => upsertCustom(d, name, sessions)))
  )
  ipcMain.handle('custom:link', (_e, id: string, sessions: string[]) =>
    customChange(() =>
      updateData((d) => {
        if (!d.custom[id]) throw new Error('That project no longer exists')
        upsertCustom(d, id, sessions)
      })
    )
  )
  ipcMain.handle('custom:bind', async (_e, id: string) => {
    const pick = await dialog.showOpenDialog(mainWindow!, { title: 'The folder this project lives in now', defaultPath: settings().roots[0], properties: ['openDirectory'] })
    if (pick.canceled) return { ok: true }
    const folder = projectFor(pick.filePaths[0], settings().roots)
    if (!folder) return { ok: false, error: `Pick a folder inside your project folders (${settings().roots.join(', ')})` }
    return customChange(() => updateData((d) => bindCustom(d, id, folder.id)))
  })
  ipcMain.handle('custom:remove', (_e, id: string) =>
    customChange(() =>
      updateData((d) => {
        delete d.custom[id]
        delete d.threads[id]
        delete d.log[id]
      })
    )
  )

  // Servers (SSH details) and passwords (names here, values in the system keyring).
  const vaultChange = (fn: () => void): { ok: boolean; error?: string } => {
    try {
      fn()
      push()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: message(err) }
    }
  }
  ipcMain.handle('server:save', (_e, c: Connection) =>
    vaultChange(() => {
      if (!c.name?.trim() || !c.user?.trim() || !c.host?.trim()) throw new Error('A server needs a name, a user and a host')
      updateData((d) => void (d.connections[c.name.trim()] = { ...c, name: c.name.trim() }))
    })
  )
  ipcMain.handle('server:remove', (_e, name: string) => vaultChange(() => updateData((d) => void delete d.connections[name])))
  ipcMain.handle('server:open', (_e, name: string) => {
    const c = readData().connections[name]
    if (c) openTerminal(app.getPath('home'), ['ssh', ...sshArgs(c)])
  })
  ipcMain.handle('secret:save', (_e, name: string, value: string, project: string | undefined, note: string) =>
    vaultChange(() => {
      if (!name.trim() || !value) throw new Error('A password needs a name and a value')
      storeSecret(name.trim(), value)
      updateData((d) => void (d.secrets[name.trim()] = { name: name.trim(), ...(project ? { project } : {}), ...(note ? { note } : {}), createdAt: Date.now() }))
    })
  )
  ipcMain.handle('secret:remove', (_e, name: string) =>
    vaultChange(() => {
      clearSecret(name)
      updateData((d) => void delete d.secrets[name])
    })
  )
  // Copies a password, then clears the clipboard after 30s if it still holds it.
  ipcMain.handle('secret:copy', (_e, name: string) => {
    const value = lookupSecret(name)
    if (value === null) return { ok: false, error: 'Not found in the keyring' }
    clipboard.writeText(value)
    setTimeout(() => {
      if (clipboard.readText() === value) clipboard.clear()
    }, 30_000)
    return { ok: true }
  })
  ipcMain.handle('ssh:keys', () => sshKeys())

  ipcMain.handle('claude:status', () => claudeSetupStatus(app.getAppPath()))
  ipcMain.handle('claude:setup', () => {
    try {
      return { ok: true, done: setupClaude(app.getAppPath()) }
    } catch (err) {
      return { ok: false, error: message(err), done: [] }
    }
  })

  ipcMain.handle('roots:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
}

// Private keys a server could use: everything in ~/.ssh that isn't a public key or config.
function sshKeys(): string[] {
  const dir = join(app.getPath('home'), '.ssh')
  try {
    return readdirSync(dir)
      .filter((f) => !f.endsWith('.pub') && !/^(known_hosts|config|authorized_keys|environment)/.test(f))
      .map((f) => `~/.ssh/${f}`)
  } catch {
    return []
  }
}

// ─── Window & tray ──────────────────────────────────────────────────────────

function createWindow(show: boolean): BrowserWindow {
  // LEFTOFF_SIZE=1400x900 sizes the window for screenshots (see scripts/demo-data.mjs).
  const [width, height] = (process.env.LEFTOFF_SIZE ?? '1100x820').split('x').map(Number)
  const win = new BrowserWindow({
    width,
    height,
    minWidth: 640,
    minHeight: 500,
    show: false,
    title: 'Left Off',
    icon: join(RESOURCES, 'icon.png'),
    autoHideMenuBar: true,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // F11 toggles full screen even with the menu bar hidden.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      event.preventDefault()
      win.setFullScreen(!win.isFullScreen())
    }
  })

  win.on('ready-to-show', () => {
    if (show) win.show()
  })

  // Closing tucks the app into the tray; it keeps scanning in the background.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      win.hide()
    }
  })

  // Coming back to the window is exactly when stale data hurts, so rescan if it's been a bit.
  win.on('focus', () => {
    if (Date.now() - scannedAt > 20_000) void scan()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

function showWindow(): void {
  if (!mainWindow) return
  mainWindow.show()
  mainWindow.focus()
}

function focusProject(id: string): void {
  showWindow()
  mainWindow?.webContents.send('focus-project', id)
}

function refreshTray(): void {
  if (!tray) return
  const meta = allMeta()
  const threads = readThreads()
  const recent = projects
    .filter((p) => !meta[p.id]?.hidden)
    .sort((a, b) => Number(!!meta[b.id]?.pinned) - Number(!!meta[a.id]?.pinned) || b.lastTouched - a.lastTouched)
    .slice(0, 8)
  tray.setToolTip('Left Off')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Left Off', click: showWindow },
      { type: 'separator' },
      ...recent.map((p) => {
        const current = threads[p.id]?.find((t) => t.status === 'active')
        return {
          label: `${meta[p.id]?.alias || p.name}   ·   ${current ? current.title : timeAgo(p.lastTouched)}`,
          click: () => focusProject(p.id)
        }
      }),
      { type: 'separator' },
      { label: 'Rescan now', click: () => void scan() },
      {
        label: 'Quit',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(join(RESOURCES, 'tray.png')))
  tray.on('click', () => {
    if (mainWindow?.isVisible() && mainWindow.isFocused()) mainWindow.hide()
    else showWindow()
  })
  refreshTray()
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

// LEFTOFF_DUMP=1 prints what a scan finds and exits; LEFTOFF_CHAT="…" also runs one
// assistant turn. Handy for checking against the real folders without opening a window.
async function dump(): Promise<void> {
  const t0 = Date.now()
  ;({ projects, unassigned } = await scanProjects(settings().roots))
  seedMeta(projects)
  const t1 = Date.now()
  const data = readData()
  for (const p of [...projects].sort((a, b) => b.lastTouched - a.lastTouched)) {
    console.log(`\n■ ${p.name}  — ${timeAgo(p.lastTouched)} (${p.lastTouchedBy})`)
    for (const r of p.repos) {
      const dirty = r.staged + r.changed + r.untracked + r.conflicted
      console.log(`  repo ${r.rel || '.'}: ${r.branch} ↑${r.ahead} ↓${r.behind} dirty=${dirty}${r.error ? ` ERROR ${r.error}` : ''}`)
    }
    const s = p.sessions[0]
    if (s) console.log(`  claude ${timeAgo(s.updated)} "${s.title}"`)
    const last = data.log[p.id]?.[0]
    if (last) console.log(`  last session ${timeAgo(last.at)}: ${last.text}`)
    const open = (data.threads[p.id] ?? []).filter((t) => t.status !== 'done')
    if (open.length) console.log(`  ongoing: ${open.map((t) => t.title).join(', ')}`)
  }
  const chat = process.env.LEFTOFF_CHAT
  if (chat) {
    const t2 = Date.now()
    // send() returns once the message is queued; the reply is done when busy drops.
    await assistant.send(chat)
    while (assistant.state().busy) await new Promise((r) => setTimeout(r, 200))
    const s = assistant.state()
    const reply = s.messages[s.messages.length - 1]
    console.log(`\n── assistant (${s.model}, ${Date.now() - t2}ms) ──\n${reply?.text}`)
    for (const a of reply?.actions ?? []) console.log(`  ${a.ok ? '✓' : '✗'} ${a.text}`)
    if (s.error) console.log(`  error: ${s.error}`)
    assistant.close()
  }
  console.log(`\nscanned ${projects.length} projects in ${t1 - t0}ms`)
}

// LEFTOFF_SCREENSHOT=out.png saves the window's own pixels and exits, for checking the UI
// without grabbing the rest of the screen. LEFTOFF_ASK="…" opens the chat first and waits
// for the reply.
async function screenshot(path: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 1500))
  const ask = process.env.LEFTOFF_ASK
  if (ask) {
    await mainWindow!.webContents.executeJavaScript("localStorage.setItem('chatOpen', 'true'); location.reload()")
    await new Promise((r) => setTimeout(r, 1500))
    await assistant.send(ask)
    while (assistant.state().busy) await new Promise((r) => setTimeout(r, 200))
    await new Promise((r) => setTimeout(r, 600))
  }
  if (process.env.LEFTOFF_EVAL) console.log(await mainWindow!.webContents.executeJavaScript(process.env.LEFTOFF_EVAL))
  const image = await mainWindow!.webContents.capturePage()
  await writeFile(path, image.toPNG())
  app.exit(0)
}

async function start(): Promise<void> {
  await loadShellPath()
  await initClaudeCache(join(app.getPath('userData'), 'claude-sessions.json'))

  if (DUMP) {
    await dump().catch((err) => console.error(err))
    app.exit(0)
    return
  }

  // First run: use the usual project folders if there are any; otherwise the window asks.
  if (!settings().roots.length) {
    const found = detectRoots()
    if (found.length) store.set('settings', { ...settings(), roots: found })
  }

  registerIpc()
  watchData()
  ensureLauncher().catch(() => {})
  if (settings().autostart) setAutostart(true).catch(() => {})

  const fromAutostart = process.argv.includes('--autostart')
  mainWindow = createWindow(!(fromAutostart && settings().startHidden))
  createTray()

  await scan()
  if (SHOT) return screenshot(SHOT)
  setInterval(() => void scan(), SCAN_EVERY)
}

if (!DUMP && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.on('before-quit', () => {
    quitting = true
    assistant.close()
  })
  // Stay alive in the tray when the window is closed.
  app.on('window-all-closed', () => {})
  app.whenReady().then(start)
}
