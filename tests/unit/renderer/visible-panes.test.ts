import { describe, expect, it } from 'vitest'
import { MAX_VISIBLE_PANES, selectVisiblePane } from '../../../src/renderer/src/stores/visible-panes'

describe('visible terminal panes', () => {
  it('keeps at most nine stable panes and replaces the previously active slot for a selected overflow tab', () => {
    const initial = Array.from({ length: MAX_VISIBLE_PANES }, (_, index) => `s${index + 1}`)

    const selected = selectVisiblePane(initial, 's10', 's3')

    expect(selected).toHaveLength(9)
    expect(selected).toContain('s10')
    expect(selected).not.toContain('s3')
    expect(selected.filter(id => id === 's10')).toHaveLength(1)
  })

  it('does not rearrange an already visible terminal pane', () => {
    const current = ['s1', 's2', 's3']

    expect(selectVisiblePane(current, 's2', 's1')).toEqual(current)
  })
})
