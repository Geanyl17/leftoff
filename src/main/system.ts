import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { delimiter, dirname, join } from 'path'
import { homedir } from 'os'
import { app, shell } from 'electron'

const run = promisify(execFile)

// Launched from KDE autostart we get a bare PATH, without linuxbrew (code, gh) or
// ~/.local/bin (claude). Borrow the login shell's PATH once at startup.
export async function loadShellPath(): Promise<void> {
  const parts = new Set((process.env.PATH ?? '').split(delimiter).filter(Boolean))
  try {
    const { stdout } = await run(process.env.SHELL || '/bin/bash', ['-lc', 'printf "%s" "$PATH"'], { timeout: 5000 })
    for (const p of stdout.split(delimiter)) if (p) parts.add(p)
  } catch {
    // fall back to the well-known locations below
  }
  for (const p of [join(homedir(), '.local/bin'), '/home/linuxbrew/.linuxbrew/bin', '/usr/local/bin']) parts.add(p)
  process.env.PATH = [...parts].join(delimiter)
}

export function which(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const p = join(dir, cmd)
    if (dir && existsSync(p)) return p
  }
  return null
}

function detached(cmd: string, args: string[], cwd?: string): void {
  const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore', env: process.env })
  child.on('error', (err) => console.error('[leftoff] could not start', cmd, err.message))
  child.unref()
}

export async function openEditor(path: string, line?: number): Promise<void> {
  const code = which('code') ?? which('codium')
  if (code) return detached(code, line ? ['-g', `${path}:${line}`] : [path])
  await shell.openPath(path)
}

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

const TERMINALS: [string, (dir: string, cmd: string[]) => string[]][] = [
  ['konsole', (dir, cmd) => ['--workdir', dir, ...(cmd.length ? ['-e', ...cmd] : [])]],
  ['kitty', (dir, cmd) => ['--directory', dir, ...cmd]],
  ['wezterm', (dir, cmd) => ['start', '--cwd', dir, ...(cmd.length ? ['--', ...cmd] : [])]],
  ['alacritty', (dir, cmd) => ['--working-directory', dir, ...(cmd.length ? ['-e', ...cmd] : [])]],
  ['gnome-terminal', (dir, cmd) => [`--working-directory=${dir}`, ...(cmd.length ? ['--', ...cmd] : [])]]
]

export function openTerminal(dir: string, cmd: string[] = []): void {
  // Drop back into a shell when the command exits so its output stays on screen.
  const wrapped = cmd.length ? ['bash', '-lc', `${cmd.map(quote).join(' ')}; exec "\${SHELL:-bash}"`] : []
  for (const [bin, args] of TERMINALS) {
    const path = which(bin)
    if (path) return detached(path, args(dir, wrapped), dir)
  }
  void shell.openPath(dir)
}

// ─── Desktop entries ────────────────────────────────────────────────────────

const AUTOSTART = join(homedir(), '.config', 'autostart', 'leftoff.desktop')
const LAUNCHER = join(homedir(), '.local', 'share', 'applications', 'leftoff.desktop')

function desktopEntry(extraArgs: string): string {
  const exec = app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Left Off',
    'GenericName=Project tracker',
    'Comment=Where you left off on every project',
    `Exec=${exec}${extraArgs}`,
    `Icon=${join(app.getAppPath(), 'resources', 'icon.png')}`,
    'Terminal=false',
    'Categories=Development;',
    'StartupWMClass=leftoff',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n')
}

async function writeIfChanged(path: string, content: string): Promise<void> {
  if ((await readFile(path, 'utf8').catch(() => '')) === content) return
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

export async function setAutostart(on: boolean): Promise<void> {
  if (on) await writeIfChanged(AUTOSTART, desktopEntry(' --autostart'))
  else await unlink(AUTOSTART).catch(() => {})
}

// Also list the app in the KDE launcher so it can be opened (or pinned) by hand.
export async function ensureLauncher(): Promise<void> {
  await writeIfChanged(LAUNCHER, desktopEntry(''))
}
