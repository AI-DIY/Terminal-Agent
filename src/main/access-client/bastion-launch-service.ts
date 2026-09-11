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
import { hostHintFromTitle } from '../../shared/shell-display-label'

export { UnavailableBastionTargetResolver }

const PROVIDER_UNAVAILABLE_MESSAGE = '未配置堡垒机目录来源。'
const RESOLVE_FAILED_MESSAGE = '无法解析堡垒机目标。'

export class BastionLaunchService {
  /** Request keys avoid repeat catalogue lookups for one exact picker choice. */
  private readonly requestSessions = new Map<string, string>()
  /** Target keys deliberately use the selected hostname, never a relay IP. */
  private readonly targetSessions = new Map<string, string>()
  private readonly pendingLaunches = new Map<string, Promise<BastionLaunchResult>>()
  private readonly pendingTargets = new Map<string, Promise<BastionLaunchResult>>()

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
    const existingSessionId = this.requestSessions.get(key)
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

  private async openTarget(request: BastionLaunchRequest, requestKeyValue: string): Promise<BastionLaunchResult> {

    let target
    try {
      target = await this.resolver.resolve(request)
    } catch (error) {
      throw publicProviderError(error, RESOLVE_FAILED_MESSAGE)
    }

    const hostname = resolvedTargetHostname(request, target)
    // A hostname is the primary identity, but hostnames such as `web-01` are
    // routinely repeated across independent CMDB systems. Keep that stable
    // route scope in the key so a staging selection never focuses prod.
    const targetKey = hostname
      ? `${targetScope(request)}:hostname:${hostname}`
      : `request:${requestKeyValue}`
    const existingSessionId = this.targetSessions.get(targetKey)
    if (existingSessionId) {
      this.requestSessions.set(requestKeyValue, existingSessionId)
      return { kind: 'focused', sessionId: existingSessionId }
    }

    const pendingTarget = this.pendingTargets.get(targetKey)
    if (pendingTarget) {
      const opened = await pendingTarget
      this.requestSessions.set(requestKeyValue, opened.sessionId)
      return { kind: 'focused', sessionId: opened.sessionId }
    }

    const opening = this.openResolvedTarget(target, targetKey, hostname)
    this.pendingTargets.set(targetKey, opening)
    try {
      const opened = await opening
      this.requestSessions.set(requestKeyValue, opened.sessionId)
      return opened
    } finally {
      if (this.pendingTargets.get(targetKey) === opening) this.pendingTargets.delete(targetKey)
    }
  }

  private async openResolvedTarget(
    target: Awaited<ReturnType<BastionTargetResolver['resolve']>>,
    targetKey: string,
    hostname: string | undefined,
  ): Promise<BastionLaunchResult> {
    let session: unknown
    try {
      session = target.protocol === 'raw'
        ? await this.sessions.openRaw({
            host: target.host,
            ...(hostname ? { hostname } : {}),
            port: target.port,
            title: target.title,
            columns: target.columns,
            rows: target.rows,
          })
        : await this.sessions.openSsh({
            host: target.host,
            ...(hostname ? { hostname } : {}),
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
    this.targetSessions.set(targetKey, sessionId)
    return { kind: 'opened', sessionId }
  }

  closeSession(sessionId: string): void {
    for (const [key, openSessionId] of this.targetSessions) {
      if (openSessionId === sessionId) this.targetSessions.delete(key)
    }
    for (const [key, openSessionId] of this.requestSessions) {
      if (openSessionId === sessionId) this.requestSessions.delete(key)
    }
  }
}

function requestKey(request: BastionLaunchRequest): string {
  return request.kind === 'cmdb'
    ? `cmdb:${request.systemId}:${request.hostId}`
    : `host:${request.target.trim().toLowerCase()}`
}

function targetScope(request: BastionLaunchRequest): string {
  return request.kind === 'cmdb'
    ? `cmdb:${request.systemId}`
    : `host:${request.target.trim().toLowerCase()}`
}

function resolvedTargetHostname(request: BastionLaunchRequest, target: Awaited<ReturnType<BastionTargetResolver['resolve']>>): string | undefined {
  return normalizeHostname(target.hostname)
    ?? (request.kind === 'host' ? normalizeHostname(request.target) : undefined)
    ?? hostnameFromTitle(target.title)
}

function hostnameFromTitle(title: string): string | undefined {
  return normalizeHostname(hostHintFromTitle(title))
}

function normalizeHostname(value: string | undefined): string | undefined {
  const candidate = value?.trim().replace(/^\[|\]$/g, '')
  if (!candidate || /\s/.test(candidate) || isIpLiteral(candidate)) return undefined
  return /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/.test(candidate)
    ? candidate.toLowerCase()
    : undefined
}

function isIpLiteral(value: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return value.split('.').every(part => Number(part) <= 255)
  return value.includes(':') && /^[0-9a-f:%]+$/i.test(value)
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
