import { describe, expect, it } from 'vitest'
import { TITLE_BAR_OVERLAY_HEIGHT, titleBarOverlayForTheme } from '../../../src/main/windows/title-bar-overlay'

describe('title bar overlay', () => {
  it('matches the renderer chrome tokens and keeps native symbols legible for every theme', () => {
    expect(TITLE_BAR_OVERLAY_HEIGHT).toBe(48)
    expect(titleBarOverlayForTheme('pearl')).toEqual({ color: '#f0f3f6', symbolColor: '#1d242c', height: 48 })
    expect(titleBarOverlayForTheme('graphite')).toEqual({ color: '#25292e', symbolColor: '#f0f3f6', height: 48 })
    expect(titleBarOverlayForTheme('noble-purple')).toEqual({ color: '#302044', symbolColor: '#f7f0ff', height: 48 })
    expect(titleBarOverlayForTheme('imperial-gold')).toEqual({ color: '#242019', symbolColor: '#fff4d4', height: 48 })
    expect(titleBarOverlayForTheme('sakura-pink')).toEqual({ color: '#f8dfe8', symbolColor: '#4c2635', height: 48 })
    expect(titleBarOverlayForTheme('jasmine-green-tea')).toEqual({ color: '#e5f0e6', symbolColor: '#243b31', height: 48 })
  })

  it('rejects an unknown theme before it reaches BrowserWindow', () => {
    expect(() => titleBarOverlayForTheme('dark' as never)).toThrow()
  })
})
