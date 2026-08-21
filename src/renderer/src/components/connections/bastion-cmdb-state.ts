import type { BastionHostSummary } from '../../../../shared/contracts'

export type BastionHostResponseState = {
  requestId: number
  latestRequestId: number
  requestedSystemId: string
  selectedSystemId: string
}

export function availableHosts(
  hosts: BastionHostSummary[],
  systemId: string,
  openHostIds: ReadonlySet<string>,
): BastionHostSummary[] {
  return hosts.filter(host => host.systemId === systemId && !openHostIds.has(host.id))
}

export function shouldApplyBastionHostResponse(state: BastionHostResponseState): boolean {
  return state.requestId === state.latestRequestId && state.requestedSystemId === state.selectedSystemId
}

export function activeCmdbHostIds(sessionHostIds: ReadonlyMap<string, string>): Set<string> {
  return new Set(sessionHostIds.values())
}
