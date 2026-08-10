import { ipcMain, type WebContents } from 'electron'
import { candidateConfirmationRequestSchema } from '../../shared/contracts'

type CandidateConfirmationSource = {
  issueForCandidate(sessionId: string, candidateId: string): { id: string }
}

export function registerConfirmationHandlers(source: CandidateConfirmationSource, sender: WebContents): () => void {
  ipcMain.handle('agent:confirm-candidate', (event, request: unknown) => {
    if (event.sender !== sender) throw new Error('Untrusted renderer')
    const parsed = candidateConfirmationRequestSchema.parse(request)
    return source.issueForCandidate(parsed.sessionId, parsed.candidateId)
  })

  return () => {
    ipcMain.removeHandler('agent:confirm-candidate')
  }
}
