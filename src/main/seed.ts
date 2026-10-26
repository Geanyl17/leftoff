import type { Settings } from '@shared/types'

// roots starts empty: on first run the app picks the usual project folders (see roots.ts)
// or asks.
export const DEFAULT_SETTINGS: Settings = {
  roots: [],
  autostart: true,
  startHidden: false,
  autoRecord: true,
  opacity: 0.9,
  chatModel: 'claude-opus-5-5'
}
