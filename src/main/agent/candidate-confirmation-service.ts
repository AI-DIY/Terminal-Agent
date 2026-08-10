import type { ConfirmationMarker, ConfirmationService } from './confirmation-service'

export type SavedCommandCandidate = {
  id: string
  sessionId: string
  command: string
}

export class CandidateConfirmationService {
  private readonly candidates = new Map<string, SavedCommandCandidate>()

  constructor(private readonly confirmations: ConfirmationService) {}

  save(candidate: SavedCommandCandidate): void {
    this.candidates.set(candidate.id, { ...candidate })
  }

  issueForCandidate(sessionId: string, candidateId: string): ConfirmationMarker {
    const candidate = this.candidates.get(candidateId)
    if (!candidate || candidate.sessionId !== sessionId) {
      throw new Error('Unknown command candidate')
    }
    return this.confirmations.issue(sessionId, candidate.command)
  }

  closeSession(sessionId: string): void {
    this.confirmations.closeSession(sessionId)
    for (const [candidateId, candidate] of this.candidates) {
      if (candidate.sessionId === sessionId) this.candidates.delete(candidateId)
    }
  }
}
