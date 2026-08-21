import type {
  BastionHostSummary,
  BastionLaunchRequest,
  BastionSystemSummary,
} from '../../shared/contracts'

export type BastionResolvedConnection =
  | {
      protocol: 'ssh'
      host: string
      port: number
      username: string
      password?: string
      title: string
      columns: number
      rows: number
    }
  | {
      protocol: 'raw'
      host: string
      port: number
      title: string
      columns: number
      rows: number
    }

export type BastionTargetResolver = {
  listSystems(): Promise<BastionSystemSummary[]>
  listHosts(systemId: string): Promise<BastionHostSummary[]>
  resolve(request: BastionLaunchRequest): Promise<BastionResolvedConnection>
}

export class BastionProviderUnavailableError extends Error {
  constructor() {
    super('未配置堡垒机目录来源。')
  }
}

export class UnavailableBastionTargetResolver implements BastionTargetResolver {
  async listSystems(): Promise<BastionSystemSummary[]> {
    throw new BastionProviderUnavailableError()
  }

  async listHosts(): Promise<BastionHostSummary[]> {
    throw new BastionProviderUnavailableError()
  }

  async resolve(): Promise<BastionResolvedConnection> {
    throw new BastionProviderUnavailableError()
  }
}
