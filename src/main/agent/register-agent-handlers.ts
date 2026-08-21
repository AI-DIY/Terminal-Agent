import { ipcMain, type WebContents } from 'electron'
import { agentStartRequestSchema, type AgentCandidate, type AgentStreamEvent, type SessionMode } from '../../shared/contracts'
import { ModelConfigurationError, UnsafeAgentOutputError } from './agent-model-runtime'
import { ModelConnectionError } from '../model/chat-completions-client'
import type { AgentEventPublisher, AgentGoalContext } from './agent-contracts'
import type { AgentExecutionResult } from './execution-gateway'
import type { HostMemorySettingsService } from '../settings/host-memory-settings-service'
import { containsSensitiveMaterial, SensitiveTextStreamRedactor } from './sensitive-data'

type Scheduler = {
  start(context: AgentGoalContext, publish: AgentEventPublisher): Promise<void>
}
type SessionSource = {
  snapshot(): Array<{ id: string; hostname: string; mode: SessionMode }>
  observedHostname(sessionId: string): string | undefined
  onClosed?(listener: (event: { sessionId: string }) => void): () => void
}
type HostFactsSource = {
  snapshot(hostname: string): Promise<AgentGoalContext['facts'] | null>
}
type CandidateSink = {
  save(candidate: Pick<AgentCandidate, 'id' | 'sessionId' | 'command'>): void
}
type ExecutionGatewaySource = {
  execute(request: { sessionId: string; command: string }): Promise<AgentExecutionResult>
}
export type AgentHandlerOptions = {
  timeoutMs?: number
  createAbortController?: () => AbortController
  hostMemory?: Pick<HostMemorySettingsService, 'canCollect'> & Partial<Pick<HostMemorySettingsService, 'canObserveHost'>>
}
type ActiveRun = {
  runId: string
  controller: AbortController
  timeout: ReturnType<typeof setTimeout> | undefined
}

export function registerAgentHandlers(
  scheduler: Scheduler,
  sessions: SessionSource,
  facts: HostFactsSource,
  candidates: CandidateSink,
  sender: WebContents,
  executionGateway?: ExecutionGatewaySource,
  options: AgentHandlerOptions = {},
): () => void {
  const activeRuns = new Map<string, ActiveRun>()
  const timeoutMs = options.timeoutMs ?? 60_000
  const createAbortController = options.createAbortController ?? (() => new AbortController())

  const cancelRun = (sessionId: string): void => {
    const run = activeRuns.get(sessionId)
    if (!run) return
    activeRuns.delete(sessionId)
    if (run.timeout) clearTimeout(run.timeout)
    run.controller.abort()
  }

  const completeRun = (sessionId: string, run: ActiveRun): void => {
    if (activeRuns.get(sessionId) !== run) return
    activeRuns.delete(sessionId)
    if (run.timeout) clearTimeout(run.timeout)
  }

  const unregisterClosed = sessions.onClosed?.(event => {
    cancelRun(event.sessionId)
  })

  ipcMain.handle('agent:start', async (event, request: unknown) => {
    if (event.sender !== sender) throw new Error('Untrusted renderer')
    const parsed = agentStartRequestSchema.parse(request)
    const session = sessions.snapshot().find(item => item.id === parsed.sessionId)
    if (!session) throw new Error('Unknown terminal session')
    cancelRun(session.id)
    const run: ActiveRun = { runId: parsed.runId, controller: createAbortController(), timeout: undefined }
    activeRuns.set(session.id, run)

    const isCurrentRun = () => activeRuns.get(session.id) === run && !run.controller.signal.aborted
    run.timeout = setTimeout(() => {
      if (activeRuns.get(session.id) !== run) return
      activeRuns.delete(session.id)
      run.timeout = undefined
      run.controller.abort()
      sendError(sender, session.id, parsed.runId, 'AI 分析超时。请稍后重试。')
    }, timeoutMs)
    let output: SensitiveTextStreamRedactor | undefined
    try {
      if (options.hostMemory && !await options.hostMemory.canCollect()) {
        if (isCurrentRun()) sendError(sender, session.id, parsed.runId, '主机记忆未启用，无法读取缓存事实。请在设置中重新启用。')
        return
      }
      const observedHostname = sessions.observedHostname(session.id)
      if (!observedHostname) {
        if (isCurrentRun()) sendError(sender, session.id, parsed.runId, '当前会话尚未收集到主机事实。请稍后重试。')
        return
      }
      if (options.hostMemory && !await canReadHost(options.hostMemory, session.hostname, observedHostname)) {
        if (isCurrentRun()) sendError(sender, session.id, parsed.runId, '主机记忆未启用，无法读取缓存事实。请在设置中重新启用。')
        return
      }

      let snapshot: AgentGoalContext['facts'] | null
      try {
        snapshot = await facts.snapshot(observedHostname)
      } catch {
        snapshot = null
      }
      if (!isCurrentRun()) return
      if (options.hostMemory && !await canReadHost(options.hostMemory, session.hostname, observedHostname)) {
        if (isCurrentRun()) sendError(sender, session.id, parsed.runId, '主机记忆授权已撤销，无法读取缓存事实。请重新授权后重试。')
        return
      }
      if (!snapshot) {
        sendError(sender, session.id, parsed.runId, '当前会话尚未收集到主机事实。请稍后重试。')
        return
      }

      const streamOutput = new SensitiveTextStreamRedactor()
      output = streamOutput
      const pendingPublishes: Promise<void>[] = []
      await scheduler.start({
        goal: parsed.goal,
        session: { id: session.id, hostname: observedHostname },
        facts: snapshot,
        signal: run.controller.signal,
        hasImages: parsed.hasImages ?? false,
      }, streamEvent => {
        const publishing = publishStreamEvent(
          sender,
          session.id,
          parsed.runId,
          streamEvent,
          candidates,
          streamOutput,
          isCurrentRun,
          () => sessions.snapshot().find(item => item.id === session.id)?.mode,
          executionGateway,
        )
        pendingPublishes.push(publishing)
        void publishing.catch(() => undefined)
        return publishing
      })
      await Promise.all(pendingPublishes)
      publishRemainingDelta(sender, session.id, parsed.runId, streamOutput, isCurrentRun)
    } catch (error) {
      if (output) publishRemainingDelta(sender, session.id, parsed.runId, output, isCurrentRun)
      if (isCurrentRun()) sendError(sender, session.id, parsed.runId, publicErrorMessage(error))
    } finally {
      completeRun(session.id, run)
    }
  })

  return () => {
    ipcMain.removeHandler('agent:start')
    unregisterClosed?.()
    for (const sessionId of activeRuns.keys()) cancelRun(sessionId)
  }
}

async function canReadHost(hostMemory: AgentHandlerOptions['hostMemory'], connectionLabel: string, hostname: string): Promise<boolean> {
  if (!hostMemory || !await hostMemory.canCollect()) return false
  return !hostMemory.canObserveHost || await hostMemory.canObserveHost(connectionLabel, hostname)
}

async function publishStreamEvent(
  sender: WebContents,
  sessionId: string,
  runId: string,
  event: AgentStreamEvent,
  candidates: CandidateSink,
  output: SensitiveTextStreamRedactor,
  isCurrentRun: () => boolean,
  getCurrentMode: () => SessionMode | undefined,
  executionGateway?: ExecutionGatewaySource,
): Promise<void> {
  if (!isCurrentRun()) return
  if (event.kind === 'delta') {
    const content = output.push(event.content)
    if (content && isCurrentRun()) sender.send('agent:delta', { sessionId, runId, content })
    return
  }
  const values = [
    event.analysis,
    ...event.evidenceStrategy,
    ...(event.candidate ? [event.candidate.command, event.candidate.explanation] : []),
  ]
  if (values.some(containsSensitiveMaterial)) throw new UnsafeAgentOutputError('AI proposal contains sensitive data')
  let autonomousExecution = false
  if (event.candidate) {
    if (event.candidate.sessionId !== sessionId) throw new Error('Candidate session does not match the active session')
    if (!isCurrentRun()) return
    if (getCurrentMode() === 'autonomous') {
      if (!executionGateway) throw new Error('Autonomous execution gateway is unavailable')
      const result = await executionGateway.execute({ sessionId, command: event.candidate.command })
      if (result.kind !== 'sent') throw new Error('Autonomous candidate was not sent')
      if (!isCurrentRun()) return
      autonomousExecution = true
    } else {
      candidates.save({
        id: event.candidate.id,
        sessionId: event.candidate.sessionId,
        command: event.candidate.command,
      })
    }
  }
  if (!isCurrentRun()) return
  sender.send('agent:proposal', {
    sessionId,
    runId,
    analysis: event.analysis,
    evidenceStrategy: event.evidenceStrategy,
    candidate: event.candidate,
    ...(autonomousExecution ? { autonomousExecution: true as const } : {}),
  })
}

function publishRemainingDelta(
  sender: WebContents,
  sessionId: string,
  runId: string,
  output: SensitiveTextStreamRedactor,
  isCurrentRun: () => boolean,
): void {
  if (!isCurrentRun()) return
  const content = output.finish()
  if (content && isCurrentRun()) sender.send('agent:delta', { sessionId, runId, content })
}

function sendError(sender: WebContents, sessionId: string, runId: string, message: string): void {
  sender.send('agent:error', { sessionId, runId, message })
}

function publicErrorMessage(error: unknown): string {
  if (error instanceof ModelConfigurationError) {
    return '未配置 AI 模型。请前往设置完成模型连接后重试。'
  }
  if (error instanceof ModelConnectionError) {
    return error.message
  }
  if (error instanceof UnsafeAgentOutputError) {
    return 'AI 响应包含敏感内容，已拒绝显示和执行。'
  }
  return 'AI 分析暂时不可用。请检查模型连接后重试。'
}
