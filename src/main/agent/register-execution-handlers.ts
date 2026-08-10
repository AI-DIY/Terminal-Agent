import { ipcMain, type WebContents } from 'electron'
import { agentExecutionRequestSchema } from '../../shared/contracts'

type ExecutionGatewaySource = {
  execute(request: { sessionId: string; command: string; confirmationId?: string }): Promise<unknown>
}

export function registerExecutionHandlers(source: ExecutionGatewaySource, sender: WebContents): () => void {
  ipcMain.handle('agent:execute-command', async (event, request: unknown) => {
    if (event.sender !== sender) throw new Error('Untrusted renderer')
    return source.execute(agentExecutionRequestSchema.parse(request))
  })

  return () => {
    ipcMain.removeHandler('agent:execute-command')
  }
}
