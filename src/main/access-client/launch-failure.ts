export const accessClientLaunchFailureCodes = [
  'runtime-not-found',
  'bridge-process-start-failed',
  'unsupported-launch-arguments',
  'temporary-profile-unreadable',
  'temporary-profile-invalid',
  'transport-connect-failed',
  'terminal-open-failed',
] as const

export type AccessClientLaunchFailureCode = typeof accessClientLaunchFailureCodes[number]

export class AccessClientLaunchFailure extends Error {
  constructor(readonly code: AccessClientLaunchFailureCode) {
    super(code)
    this.name = 'AccessClientLaunchFailure'
  }
}

const messages: Record<AccessClientLaunchFailureCode, string> = {
  'runtime-not-found': '找不到已安装的 Terminal-Agent。',
  'bridge-process-start-failed': '无法启动 Terminal-Agent。',
  'unsupported-launch-arguments': '堡垒机传入的启动参数不受支持。',
  'temporary-profile-unreadable': '无法读取堡垒机临时配置。',
  'temporary-profile-invalid': '堡垒机临时配置无效。',
  'transport-connect-failed': '无法连接堡垒机提供的终端通道。',
  'terminal-open-failed': '终端通道已连接，但无法打开终端会话。',
}

export function formatAccessClientLaunchFailure(code: AccessClientLaunchFailureCode, logPath?: string): string {
  const message = messages[code]
  return logPath ? `${message}请查看跳转日志：${logPath}` : message
}
