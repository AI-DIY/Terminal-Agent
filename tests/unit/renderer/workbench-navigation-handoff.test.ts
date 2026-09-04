import { describe, expect, it, afterEach } from 'vitest'
import {
  clearWorkbenchNavigationHandoff,
  consumeWorkbenchNavigationHandoff,
  setWorkbenchNavigationHandoff,
} from '../../../src/renderer/src/stores/workbench-navigation-handoff'

describe('workbench navigation handoff', () => {
  afterEach(() => clearWorkbenchNavigationHandoff())

  it('is consumed exactly once with the selected chat id', () => {
    setWorkbenchNavigationHandoff('chat-1')

    expect(consumeWorkbenchNavigationHandoff()).toEqual({ selectedChatId: 'chat-1' })
    expect(consumeWorkbenchNavigationHandoff()).toBeNull()
  })

  it('clears a pending handoff when the root leaves the workbench', () => {
    setWorkbenchNavigationHandoff('chat-2')
    clearWorkbenchNavigationHandoff()

    expect(consumeWorkbenchNavigationHandoff()).toBeNull()
  })
})
