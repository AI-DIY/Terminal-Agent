import type { TitleBarOverlay } from 'electron'
import { workbenchThemeSchema, type WorkbenchTheme } from '../../shared/contracts'

export const TITLE_BAR_OVERLAY_HEIGHT = 48

export function titleBarOverlayForTheme(input: WorkbenchTheme): TitleBarOverlay {
  const theme = workbenchThemeSchema.parse(input)
  return theme === 'graphite'
    ? { color: '#25292e', symbolColor: '#f0f3f6', height: TITLE_BAR_OVERLAY_HEIGHT }
    : { color: '#f0f3f6', symbolColor: '#1d242c', height: TITLE_BAR_OVERLAY_HEIGHT }
}
