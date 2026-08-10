import { describe, expect, it } from 'vitest'
import { candidateState } from '../../../src/renderer/src/components/command-candidate-state'

describe('candidateState', () => {
  it('labels a Copilot candidate as pending until the user confirms it', () => {
    expect(candidateState({ disposition: 'pending', confirmationId: null })).toEqual({ label: '待确认', canExecute: true })
    expect(candidateState({ disposition: 'pending', confirmationId: 'm1' })).toEqual({ label: '已人工确认', canExecute: false })
  })

  it('uses the candidate disposition rather than the current session mode after an upgrade', () => {
    expect(candidateState({ disposition: 'pending', confirmationId: null })).toEqual({ label: '待确认', canExecute: true })
    expect(candidateState({ disposition: 'autonomous-sent', confirmationId: null })).toEqual({ label: '已由全自动驾驶发送', canExecute: false })
  })
})
