import type { TitleBarOverlay } from 'electron'
import { workbenchThemeSchema, type WorkbenchTheme } from '../../shared/contracts'

export const TITLE_BAR_OVERLAY_HEIGHT = 48

export function titleBarOverlayForTheme(input: WorkbenchTheme): TitleBarOverlay {
  const theme = workbenchThemeSchema.parse(input)
  if (theme === 'graphite') {
    return { color: '#25292e', symbolColor: '#f0f3f6', height: TITLE_BAR_OVERLAY_HEIGHT }
  }
  if (theme === 'noble-purple') {
    return { color: '#302044', symbolColor: '#f7f0ff', height: TITLE_BAR_OVERLAY_HEIGHT }
  }
  if (theme === 'imperial-gold') {
    return { color: '#242019', symbolColor: '#fff4d4', height: TITLE_BAR_OVERLAY_HEIGHT }
  }
  if (theme === 'sakura-pink') {
    return { color: '#f8dfe8', symbolColor: '#4c2635', height: TITLE_BAR_OVERLAY_HEIGHT }
  }
  if (theme === 'jasmine-green-tea') {
    return { color: '#e5f0e6', symbolColor: '#243b31', height: TITLE_BAR_OVERLAY_HEIGHT }
  }
  return { color: '#f0f3f6', symbolColor: '#1d242c', height: TITLE_BAR_OVERLAY_HEIGHT }
}
