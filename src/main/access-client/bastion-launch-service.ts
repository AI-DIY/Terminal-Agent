import type {
  BastionCatalogSnapshot,
  BastionHostSummary,
  BastionLaunchRequest,
  BastionLaunchResult,
} from '../../shared/contracts'
import type { AccessClientSessionOpener } from './access-client-service'
import { AccessClientLaunchFailure, formatAccessClientLaunchFailure } from './launch-failure'
import {
  BastionProviderUnavailableError,
  type BastionTargetResolver,
  UnavailableBastionTargetResolver,
} from './bastion-target-resolver'

export { UnavailableBastionTargetResolver }

const PROVIDER_UNAVAILABLE_MESSAGE = '未配置堡垒机目录来源。'
const RESOLVE_FAILED_MESSAGE = '无法解析堡垒机目标。'

export class BastionLaunchService {
  private readonly targetSessions = new Map<string, string>()
  private readonly pendingLaunches = new Map<string, Promise<BastionLaunchResult>>()

  constructor(
    private readonly resolver: BastionTargetResolver,
    private readonly sessions: AccessClientSessionOpener,
  ) {}

  async catalog(): Promise<BastionCatalogSnapshot> {
    try {
      return { available: true, systems: await this.resolver.listSystems() }
    } catch {
      return { available: false, systems: [], message: PROVIDER_UNAVAILABLE_MESSAGE }
    }
  }

  async hosts(systemId: string): Promise<BastionHostSummary[]> {
    try {
      return await this.resolver.listHosts(systemId)
    } catch (error) {
      throw publicProviderError(error, '无法读取堡垒机主机目录。')
    }
  }

  async launch(request: BastionLaunchRequest): Promise<BastionLaunchResult> {
    const key = requestKey(request)
    const existingSessionId = this.targetSessions.get(key)
    if (existingSessionId) return { kind: 'focused', sessionId: existingSessionId }

    const pendingLaunch = this.pendingLaunches.get(key)
    if (pendingLaunch) {
      const result = await pendingLaunch
      return { kind: 'focused', sessionId: result.sessionId }
    }

    const opening = this.openTarget(request, key)
    this.pendingLaunches.set(key, opening)
    try {
      return await opening
    } finally {
      if (this.pendingLaunches.get(key) === opening) this.pendingLaunches.delete(key)
    }
  }

  private async openTarget(request: BastionLaunchRequest, key: string): Promise<BastionLaunchResult> {

    let target
    try {
      target = await this.resolver.resolve(request)
    } catch (error) {
      throw publicProviderError(error, RESOLVE_FAILED_MESSAGE)
    }

    let session: unknown
    try {
      session = target.protocol === 'raw'
        ? await this.sessions.openRaw({
            host: target.host,
            port: target.port,
            title: target.title,
            columns: target.columns,
            rows: target.rows,
          })
        : await this.sessions.openSsh({
            host: target.host,
            port: target.port,
            username: target.username,
            ...(target.password !== undefined ? { password: target.password } : {}),
            title: target.title,
            columns: target.columns,
            rows: target.rows,
          })
    } catch (error) {
      if (error instanceof AccessClientLaunchFailure) {
        throw new Error(formatAccessClientLaunchFailure(error.code), { cause: error })
      }
      throw new Error('无法建立堡垒机终端会话。', { cause: error })
    }

    const sessionId = readSessionId(session)
    this.targetSessions.set(key, sessionId)
    return { kind: 'opened', sessionId }
  }

  closeSession(sessionId: string): void {
    for (const [key, openSessionId] of this.targetSessions) {
      if (openSessionId === sessionId) this.targetSessions.delete(key)
    }
  }
}

function requestKey(request: BastionLaunchRequest): string {
  return request.kind === 'cmdb'
    ? `cmdb:${request.systemId}:${request.hostId}`
    : `host:${request.target.trim().toLowerCase()}`
}

function readSessionId(session: unknown): string {
  if (!session || typeof session !== 'object') throw new Error('无法建立堡垒机终端会话。')
  const id = (session as { id?: unknown }).id
  if (typeof id !== 'string' || !id.trim()) throw new Error('无法建立堡垒机终端会话。')
  return id
}

function publicProviderError(error: unknown, fallback: string): Error {
  return new Error(error instanceof BastionProviderUnavailableError ? PROVIDER_UNAVAILABLE_MESSAGE : fallback)
}
