import { describe, expect, it } from 'vitest'
import { MAX_VISIBLE_PANES, reconcileVisiblePanes, selectVisiblePane } from '../../../src/renderer/src/stores/visible-panes'

describe('visible terminal panes', () => {
  it('keeps at most four stable panes and replaces the previously active slot for a selected overflow tab', () => {
    const initial = Array.from({ length: MAX_VISIBLE_PANES }, (_, index) => `s${index + 1}`)

    const selected = selectVisiblePane(initial, 's5', 's3')

    expect(MAX_VISIBLE_PANES).toBe(4)
    expect(selected).toHaveLength(4)
    expect(selected).toContain('s5')
    expect(selected).not.toContain('s3')
    expect(selected.filter(id => id === 's5')).toHaveLength(1)
  })

  it('does not rearrange an already visible terminal pane', () => {
    const current = ['s1', 's2', 's3']

    expect(selectVisiblePane(current, 's2', 's1')).toEqual(current)
  })

  it('reconciles the requested count while retaining the active pane and filling stable slots', () => {
    const available = ['s1', 's2', 's3', 's4']

    const reduced = reconcileVisiblePanes(available, available, 's4', 2)
    expect(reduced).toEqual(['s1', 's4'])
    expect(reconcileVisiblePanes(reduced, available, 's4', 4)).toEqual(['s1', 's4', 's2', 's3'])
  })

  it('uses the requested user count when selecting a hidden tab', () => {
    expect(selectVisiblePane(['s1', 's2'], 's3', 's2', 2)).toEqual(['s1', 's3'])
  })
})
