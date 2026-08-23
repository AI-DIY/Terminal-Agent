import { describe, expect, it } from 'vitest'
import { TITLE_BAR_OVERLAY_HEIGHT, titleBarOverlayForTheme } from '../../../src/main/windows/title-bar-overlay'

describe('title bar overlay', () => {
  it('matches the renderer chrome tokens for both themes', () => {
    expect(TITLE_BAR_OVERLAY_HEIGHT).toBe(48)
    expect(titleBarOverlayForTheme('pearl')).toEqual({ color: '#f0f3f6', symbolColor: '#1d242c', height: 48 })
    expect(titleBarOverlayForTheme('graphite')).toEqual({ color: '#25292e', symbolColor: '#f0f3f6', height: 48 })
  })

  it('rejects an unknown theme before it reaches BrowserWindow', () => {
    expect(() => titleBarOverlayForTheme('dark' as never)).toThrow()
  })
})
