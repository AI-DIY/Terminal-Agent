import type { HostMemoryRecord } from '../../shared/contracts'

export type HostFacts = HostMemoryRecord
export type HostProcess = NonNullable<HostFacts['processes']>[number]

export type ObservationPlatform = 'linux'
