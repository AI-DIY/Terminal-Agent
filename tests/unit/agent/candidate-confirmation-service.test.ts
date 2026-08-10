import { describe, expect, it } from 'vitest'
import { CandidateConfirmationService } from '../../../src/main/agent/candidate-confirmation-service'
import { ConfirmationService } from '../../../src/main/agent/confirmation-service'

describe('CandidateConfirmationService', () => {
  it('issues a marker from a saved candidate without taking a renderer command string', () => {
    const service = new CandidateConfirmationService(new ConfirmationService(() => 'marker-1'))
    service.save({ id: 'candidate-1', sessionId: 'session-a', command: 'systemctl restart nginx' })

    expect(service.issueForCandidate('session-a', 'candidate-1')).toEqual({ id: 'marker-1' })
    expect(() => service.issueForCandidate('session-b', 'candidate-1')).toThrow('Unknown command candidate')
  })
})
