import { incompatibleChatDocumentVersionMessage } from './chat-contracts'

export async function recoverChatStreamsBeforeCreatingMainWindow(
  recoverInterruptedStreams: () => Promise<void>,
  createMainWindow: () => void,
): Promise<void> {
  try {
    await recoverInterruptedStreams()
  } catch (error) {
    if (!(error instanceof Error) || error.message !== incompatibleChatDocumentVersionMessage) throw error
  }
  createMainWindow()
}
