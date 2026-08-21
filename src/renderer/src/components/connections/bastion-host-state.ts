import { isCompleteBastionTarget, type BastionLaunchRequest } from '../../../../shared/contracts'

export function bastionHostRequest(target: string): Extract<BastionLaunchRequest, { kind: 'host' }> | { error: string } {
  const normalizedTarget = target.trim()
  if (!isCompleteBastionTarget(normalizedTarget)) return { error: '请输入完整 IP 或完整主机名。' }
  return { kind: 'host', target: normalizedTarget }
}
