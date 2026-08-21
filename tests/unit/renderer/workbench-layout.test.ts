import { describe, expect, it } from 'vitest'
import { clampSidebarWidth, createWorkbenchLayout } from '../../../src/renderer/src/stores/workbench-layout'

describe('workbench layout state', () => {
  it('clamps sidebar widths to safe ranges', () => {
    expect(clampSidebarWidth(80, 210, 420)).toBe(210)
    expect(clampSidebarWidth(480, 210, 420)).toBe(420)
    expect(clampSidebarWidth(320, 210, 420)).toBe(320)
  })

  it('toggles both sidebars without owning session state', () => {
    const layout = createWorkbenchLayout()
    expect(layout.leftCollapsed.value).toBe(false)
    expect(layout.rightCollapsed.value).toBe(false)
    layout.toggleLeft()
    layout.toggleRight()
    expect(layout.leftCollapsed.value).toBe(true)
    expect(layout.rightCollapsed.value).toBe(true)
    expect(layout.leftWidth.value).toBe(230)
    expect(layout.rightWidth.value).toBe(400)
  })
})
