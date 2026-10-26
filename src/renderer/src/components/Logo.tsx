// A progress ring stopped three-quarters of the way round: work paused where you left it.
// Same drawing as resources/logo.svg, which the app and tray icons are rendered from.
// Without the tile (in the app's own top bar) it crops to the ring and the track takes
// the border colour, so it reads on light and dark themes alike.
export function Logo({ size = 24, tile = true }: { size?: number; tile?: boolean }) {
  return (
    <svg width={size} height={size} viewBox={tile ? '0 0 100 100' : '20 20 60 60'} aria-hidden="true">
      {tile && <rect x="4" y="4" width="92" height="92" rx="24" fill="#18181b" />}
      <circle cx="50" cy="50" r="23" fill="none" stroke={tile ? '#3f3f46' : 'var(--border)'} strokeWidth="10" />
      <path d="M50 27a23 23 0 1 1-23 23" fill="none" stroke="#f59e0b" strokeWidth="10" strokeLinecap="round" />
    </svg>
  )
}
