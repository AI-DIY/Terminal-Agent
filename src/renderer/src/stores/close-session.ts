export async function closeSession(
  sessionId: string,
  requestClose: (sessionId: string) => Promise<void>,
  remove: (sessionId: string) => void,
  reportError: (message: string) => void,
): Promise<void> {
  try {
    await requestClose(sessionId)
    remove(sessionId)
  } catch (error) {
    reportError(error instanceof Error ? error.message : '无法关闭 SSH 会话。')
  }
}
