export async function recoverChatStreamsBeforeCreatingMainWindow(
  recoverInterruptedStreams: () => Promise<void>,
  createMainWindow: () => void,
): Promise<void> {
  await recoverInterruptedStreams()
  createMainWindow()
}
