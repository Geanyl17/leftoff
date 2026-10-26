// Renders resources/logo.svg to the PNG app and tray icons with ImageMagick.
// Run with `npm run icon` after changing the logo.
import { execFileSync } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const RES = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources')

for (const [file, size] of [
  ['icon.png', 256],
  ['tray.png', 32]
]) {
  // Rasterize well above the target size, then scale down, for clean edges.
  // PNG32: plain 8-bit RGBA, which every tray and launcher reads.
  execFileSync('magick', ['-background', 'none', '-density', '1200', join(RES, 'logo.svg'), '-resize', `${size}x${size}`, `PNG32:${join(RES, file)}`])
}
console.log('wrote resources/icon.png and resources/tray.png from resources/logo.svg')
