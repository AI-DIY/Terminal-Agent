import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ExecutionPlanService } from '../../../src/main/chat/execution-plan-service'
import { PlanResultAutoContinue } from '../../../src/main/chat/plan-result-auto-continue'
import { ChatRepository } from '../../../src/main/chat/chat-repository'
import { ChatService } from '../../../src/main/chat/chat-service'
import { resolveModelShellTargets } from '../../../src/shared/model-shell-target'
import type { ChatExecutionPlan } from '../../../src/shared/chat-plan'

function plan() {
  return {
    id: 'plan-1',
    title: '检查服务',
    status: 'pending_review' as const,
    steps: [{
      id: 'step-1',
      target: 'web-01',
      explanation: '查看状态',
      originalCommand: 'systemctl status api',
      sendState: 'pending' as const,
    }],
  }
}

describe('ExecutionPlanService', () => {
  it('binds a shared model target to the stable #1 session regardless of association order', async () => {
    const write = vi.fn()
    const service = new ExecutionPlanService({
      get: vi.fn(async () => ({ chat: {
        messages: [{ id: 'message-1', role: 'assistant', state: 'complete', content: '{}', executionPlan: plan() }],
        shells: [
          { sessionId: 'session-second', hostname: 'web-01', status: 'open' },
          { sessionId: 'session-first', hostname: 'web-01', status: 'open' },
        ],
      } })),
      updateMessage: vi.fn(async () => undefined),
      appendMessage: vi.fn(async () => undefined),
    }, {
      snapshot: () => [
        { id: 'session-second', hostname: 'web-01' },
        { id: 'session-first', hostname: 'web-01' },
      ],
      write,
    }, { match: () => null }, () => '00000000-0000-4000-8000-000000000001')

    await service.execute({ requestId: 'request-1', chatId: 'chat-1', messageId: 'message-1' })

    expect(write).toHaveBeenCalledWith('session-first', 'systemctl status api\n')
    expect(write).not.toHaveBeenCalledWith('session-second', 'systemctl status api\n')
  })

  it('persists execution phases with distinct request ids and does not append a result message', async () => {
    const write = vi.fn()
    const updateMessage = vi.fn(async () => undefined)
    const service = new ExecutionPlanService({
      get: vi.fn(async () => ({ chat: {
        messages: [{ id: 'message-1', role: 'assistant', state: 'complete', content: '{}', executionPlan: plan() }],
        shells: [{ sessionId: 'session-1', hostname: 'web-01', status: 'open' }],
      } })),
      updateMessage,
    }, {
      snapshot: () => [{ id: 'session-1', hostname: 'web-01' }],
      write,
    }, { match: () => null })

    await expect(service.execute({ requestId: 'request-1', chatId: 'chat-1', messageId: 'message-1' })).resolves.toBeUndefined()

    expect(write).toHaveBeenCalledWith('session-1', 'systemctl status api\n')
    expect(updateMessage.mock.calls.map(call => ((call as unknown as [{ requestId: string }])[0]).requestId)).toEqual(['request-1:executing', 'request-1:result'])
  })

  it('arms one result-output watcher before writing and preserves the confirmed AI context selection', async () => {
    const write = vi.fn(async () => undefined)
    const output = { expect: vi.fn(), forget: vi.fn(), complete: vi.fn(), cancel: vi.fn() }
    const watcher = { watch: vi.fn(() => output) }
    const service = new ExecutionPlanService({
      get: vi.fn(async () => ({ chat: {
        messages: [{ id: 'message-1', role: 'assistant', state: 'complete', content: '{}', executionPlan: plan() }],
        shells: [{ sessionId: 'session-1', hostname: 'web-01', status: 'open' }],
      } })),
      updateMessage: vi.fn(async () => undefined),
    }, {
      snapshot: () => [{ id: 'session-1', hostname: 'web-01' }],
      write,
    }, { match: () => null })
    service.setResultOutputWatcher(watcher)

    await service.execute({
      requestId: 'watch-output',
      chatId: 'chat-1',
      messageId: 'message-1',
      sshContextLines: 125,
      sshContextSessionIds: ['session-1'],
      skillIds: ['security-review'],
    })

    expect(watcher.watch).toHaveBeenCalledWith({
      chatId: 'chat-1',
      messageId: 'message-1',
      sshContextLines: 125,
      sshContextSessionIds: ['session-1'],
      skillIds: ['security-review'],
    })
    expect(output.expect).toHaveBeenCalledWith('session-1')
    expect(output.expect.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]!)
    expect(output.complete).toHaveBeenCalledOnce()
    expect(output.complete.mock.invocationCallOrder[0]).toBeGreaterThan(write.mock.invocationCallOrder[0]!)
    expect(output.cancel).not.toHaveBeenCalled()
  })

  it('adds an executed target back to the automatic-analysis context after it was unchecked', async () => {
    const write = vi.fn(async () => undefined)
    const output = { expect: vi.fn(), forget: vi.fn(), complete: vi.fn(), cancel: vi.fn() }
    const watcher = { watch: vi.fn(() => output) }
    const service = new ExecutionPlanService({
      get: vi.fn(async () => ({ chat: {
        messages: [{ id: 'message-1', role: 'assistant', state: 'complete', content: '{}', executionPlan: plan() }],
        shells: [{ sessionId: 'session-1', hostname: 'web-01', status: 'open' }],
      } })),
      updateMessage: vi.fn(async () => undefined),
    }, {
      snapshot: () => [{ id: 'session-1', hostname: 'web-01' }],
      write,
    }, { match: () => null })
    service.setResultOutputWatcher(watcher)

    await service.execute({
      requestId: 'restore-executed-target',
      chatId: 'chat-1',
      messageId: 'message-1',
      sshContextSessionIds: [],
    })

    expect(watcher.watch).toHaveBeenCalledWith({
      chatId: 'chat-1',
      messageId: 'message-1',
      sshContextSessionIds: ['session-1'],
    })
    expect(write).toHaveBeenCalledWith('session-1', 'systemctl status api\n')
  })

  it('waits for each transport completion before sending the next plan command', async () => {
    const targetPlan = {
      ...plan(),
      steps: [
        plan().steps[0],
        { id: 'step-2', target: 'db-01', explanation: '查看数据库状态', originalCommand: 'systemctl status db', sendState: 'pending' as const },
      ],
    }
    const resolvers: Array<(result: { completed: boolean; timedOut: boolean }) => void> = []
    const writeAndWaitForCompletion = vi.fn(() => new Promise<{ completed: boolean; timedOut: boolean }>(resolve => { resolvers.push(resolve) }))
    const updateMessage = vi.fn(async () => undefined)
    const service = new ExecutionPlanService({
      get: vi.fn(async () => ({ chat: {
        messages: [{ id: 'message-1', role: 'assistant', state: 'complete', content: '{}', executionPlan: targetPlan }],
        shells: [
          { sessionId: 'session-web', hostname: 'web-01', status: 'open' },
          { sessionId: 'session-db', hostname: 'db-01', status: 'open' },
        ],
      } })),
      updateMessage,
    }, {
      snapshot: () => [
        { id: 'session-web', hostname: 'web-01' },
        { id: 'session-db', hostname: 'db-01' },
      ],
      write: vi.fn(),
      writeAndWaitForCompletion,
    }, { match: () => null })

    const execution = service.execute({ requestId: 'serial-completion', chatId: 'chat-1', messageId: 'message-1' })
    // Let the queued execution reach its first transport call.
    for (let attempt = 0; attempt < 12 && writeAndWaitForCompletion.mock.calls.length === 0; attempt += 1) await Promise.resolve()
    expect(writeAndWaitForCompletion).toHaveBeenCalledOnce()
    expect(writeAndWaitForCompletion).toHaveBeenCalledWith('session-web', 'systemctl status api\n')

    resolvers[0]!({ completed: true, timedOut: false })
    await Promise.resolve()
    await Promise.resolve()
    expect(writeAndWaitForCompletion).toHaveBeenCalledTimes(2)
    expect(writeAndWaitForCompletion).toHaveBeenLastCalledWith('session-db', 'systemctl status db\n')

    resolvers[1]!({ completed: true, timedOut: false })
    await expect(execution).resolves.toBeUndefined()
    expect(updateMessage.mock.calls.map(call => ((call as unknown as [{ requestId: string }])[0]).requestId)).toEqual([
      'serial-completion:executing',
      'serial-completion:result',
    ])
  })

  it('does not inject a shell completion probe into a Raw TCP session', async () => {
    const write = vi.fn(async () => undefined)
    const writeAndWaitForCompletion = vi.fn()
    const supportsCommandCompletion = vi.fn(() => false)
    const output = { expect: vi.fn(), forget: vi.fn(), complete: vi.fn(), cancel: vi.fn() }
    const watcher = { watch: vi.fn(() => output) }
    const service = new ExecutionPlanService({
      get: vi.fn(async () => ({ chat: {
        messages: [{ id: 'message-1', role: 'assistant', state: 'complete', content: '{}', executionPlan: plan() }],
        shells: [{ sessionId: 'raw-session', hostname: 'web-01', status: 'open' }],
      } })),
      updateMessage: vi.fn(async () => undefined),
    }, {
      snapshot: () => [{ id: 'raw-session', hostname: 'web-01' }],
      write,
      writeAndWaitForCompletion,
      supportsCommandCompletion,
    }, { match: () => null })
    service.setResultOutputWatcher(watcher)

    await service.execute({ requestId: 'raw-session-plan', chatId: 'chat-1', messageId: 'message-1' })

    expect(supportsCommandCompletion).toHaveBeenCalledWith('raw-session')
    expect(write).toHaveBeenCalledWith('raw-session', 'systemctl status api\n')
    expect(writeAndWaitForCompletion).not.toHaveBeenCalled()
    expect(output.expect).toHaveBeenCalledWith('raw-session')
    expect(output.complete).toHaveBeenCalledOnce()
  })

  it('does not auto-analyse streaming output until the completion signal has settled', async () => {
    vi.useFakeTimers()
    try {
      let onData!: (event: { sessionId: string; data: string }) => void
      const outputSource = {
        onData: vi.fn((listener: (event: { sessionId: string; data: string }) => void) => {
          onData = listener
          return () => undefined
        }),
      }
      const observed: string[] = []
      const runtime = {
        continueAfterPlanResult: vi.fn(async () => {
          observed.push('final-output-was-visible-before-analysis')
          return true
        }),
      }
      let resolveCompletion!: (result: { completed: boolean; timedOut: boolean }) => void
      const writeAndWaitForCompletion = vi.fn(() => new Promise<{ completed: boolean; timedOut: boolean }>(resolve => { resolveCompletion = resolve }))
      const watcher = new PlanResultAutoContinue(
        outputSource,
        runtime,
        vi.fn(),
        { settleMs: 20, partialResultWaitMs: 50, timeoutMs: 1_000 },
      )
      const service = new ExecutionPlanService({
        get: vi.fn(async () => ({ chat: {
          messages: [{ id: 'message-1', role: 'assistant', state: 'complete', content: '{}', executionPlan: plan() }],
          shells: [{ sessionId: 'session-1', hostname: 'web-01', status: 'open' }],
        } })),
        updateMessage: vi.fn(async () => undefined),
      }, {
        snapshot: () => [{ id: 'session-1', hostname: 'web-01' }],
        write: vi.fn(),
        writeAndWaitForCompletion,
      }, { match: () => null })
      service.setResultOutputWatcher(watcher)

      const execution = service.execute({ requestId: 'completion-gate', chatId: 'chat-1', messageId: 'message-1' })
      for (let attempt = 0; attempt < 12 && writeAndWaitForCompletion.mock.calls.length === 0; attempt += 1) await Promise.resolve()
      expect(writeAndWaitForCompletion).toHaveBeenCalledOnce()

      onData({ sessionId: 'session-1', data: 'streaming result (still running)\n' })
      await vi.advanceTimersByTimeAsync(500)
      expect(runtime.continueAfterPlanResult).not.toHaveBeenCalled()

      resolveCompletion({ completed: true, timedOut: false })
      await execution
      await vi.advanceTimersByTimeAsync(20)
      expect(runtime.continueAfterPlanResult).toHaveBeenCalledOnce()
      expect(observed).toEqual(['final-output-was-visible-before-analysis'])
      watcher.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the output watcher when the final execution state cannot be saved', async () => {
    const output = { expect: vi.fn(), forget: vi.fn(), complete: vi.fn(), cancel: vi.fn() }
    const watcher = { watch: vi.fn(() => output) }
    const service = new ExecutionPlanService({
      get: vi.fn(async () => ({ chat: {
        messages: [{ id: 'message-1', role: 'assistant', state: 'complete', content: '{}', executionPlan: plan() }],
        shells: [{ sessionId: 'session-1', hostname: 'web-01', status: 'open' }],
      } })),
      updateMessage: vi.fn(async ({ requestId }: { requestId: string }) => {
        if (requestId.endsWith(':result')) throw new Error('storage unavailable')
      }),
    }, {
      snapshot: () => [{ id: 'session-1', hostname: 'web-01' }],
      write: vi.fn(async () => undefined),
    }, { match: () => null })
    service.setResultOutputWatcher(watcher)

    await expect(service.execute({ requestId: 'save-fails', chatId: 'chat-1', messageId: 'message-1' })).rejects.toThrow('storage unavailable')
    expect(output.cancel).toHaveBeenCalledOnce()
    expect(output.complete).not.toHaveBeenCalled()
  })

  it('keeps the AI original command while persisting a human final command', async () => {
    const updateMessage = vi.fn(async () => undefined)
    const service = new ExecutionPlanService({
      get: vi.fn(async () => ({ chat: {
        messages: [{ id: 'message-1', role: 'assistant', state: 'complete', content: '{}', executionPlan: plan() }],
        shells: [],
      } })),
      updateMessage,
    }, {
      snapshot: () => [],
      write: vi.fn(),
    }, { match: vi.fn(() => null) })

    await service.editStep({
      requestId: 'edit-command',
      chatId: 'chat-1',
      messageId: 'message-1',
      stepId: 'step-1',
      command: 'systemctl restart api',
    })

    expect(updateMessage).toHaveBeenCalledWith(expect.objectContaining({
      executionPlan: expect.objectContaining({
        status: 'pending_review',
        steps: [expect.objectContaining({
          originalCommand: 'systemctl status api',
          finalCommand: 'systemctl restart api',
        })],
      }),
    }))
  })

  it('writes the persisted human final command when the plan is confirmed', async () => {
    const write = vi.fn()
    const targetPlan = { ...plan(), steps: [{ ...plan().steps[0], finalCommand: 'systemctl restart api' }] }
    const service = new ExecutionPlanService({
      get: vi.fn(async () => ({ chat: {
        messages: [{ id: 'message-1', role: 'assistant', state: 'complete', content: '{}', executionPlan: targetPlan }],
        shells: [{ sessionId: 'session-1', hostname: 'web-01', status: 'open' }],
      } })),
      updateMessage: vi.fn(async () => undefined),
    }, {
      snapshot: () => [{ id: 'session-1', hostname: 'web-01' }],
      write,
    }, { match: vi.fn(() => null) })

    await service.execute({ requestId: 'execute-final-command', chatId: 'chat-1', messageId: 'message-1' })

    expect(write).toHaveBeenCalledWith('session-1', 'systemctl restart api\n')
    expect(write).not.toHaveBeenCalledWith('session-1', 'systemctl status api\n')
  })

  it('removes one host step without affecting the remaining plan steps', async () => {
    const updateMessage = vi.fn(async () => undefined)
    const targetPlan = {
      ...plan(),
      steps: [
        ...plan().steps,
        { id: 'step-2', target: 'db-01', explanation: '查看数据库状态', originalCommand: 'systemctl status db', sendState: 'pending' as const },
      ],
    }
    const service = new ExecutionPlanService({
      get: vi.fn(async () => ({ chat: {
        messages: [{ id: 'message-1', role: 'assistant', state: 'complete', content: '{}', executionPlan: targetPlan }],
        shells: [],
      } })),
      updateMessage,
    }, {
      snapshot: () => [],
      write: vi.fn(),
    }, { match: vi.fn(() => null) })

    await service.removeStep({ requestId: 'remove-host', chatId: 'chat-1', messageId: 'message-1', stepId: 'step-2' })

    expect(updateMessage).toHaveBeenCalledWith(expect.objectContaining({
      executionPlan: expect.objectContaining({
        steps: [expect.objectContaining({ id: 'step-1', target: 'web-01' })],
      }),
    }))
  })

  it('cancels a plan and removes its command when the last host step is removed', async () => {
    let persistedPlan: ChatExecutionPlan = plan()
    const updateMessage = vi.fn(async (request: { executionPlan?: ChatExecutionPlan }) => {
      if (request.executionPlan) persistedPlan = structuredClone(request.executionPlan)
      return undefined
    })
    const service = new ExecutionPlanService({
      get: vi.fn(async () => ({ chat: {
        messages: [{ id: 'message-1', role: 'assistant', state: 'complete', content: '{}', executionPlan: structuredClone(persistedPlan) }],
        shells: [],
      } })),
      updateMessage,
    }, {
      snapshot: () => [],
      write: vi.fn(),
    }, { match: vi.fn(() => null) })

    await service.removeStep({ requestId: 'remove-last', chatId: 'chat-1', messageId: 'message-1', stepId: 'step-1' })
    expect(updateMessage).toHaveBeenCalledWith(expect.objectContaining({
      executionPlan: expect.objectContaining({ status: 'cancelled', steps: [] }),
    }))

    expect(persistedPlan.steps).toEqual([])
    await expect(service.execute({ requestId: 'execute-empty', chatId: 'chat-1', messageId: 'message-1' })).rejects.toThrow('计划不可执行')

    const unknownStepService = new ExecutionPlanService({
      get: vi.fn(async () => ({ chat: {
        messages: [{ id: 'message-1', role: 'assistant', state: 'complete', content: '{}', executionPlan: { ...plan(), steps: [{ ...plan().steps[0], id: 'step-1' }, { id: 'step-2', target: 'db-01', explanation: '检查', originalCommand: 'uptime', sendState: 'pending' as const }] } }],
        shells: [],
      } })),
      updateMessage: vi.fn(async () => undefined),
    }, { snapshot: () => [], write: vi.fn() }, { match: vi.fn(() => null) })
    await expect(unknownStepService.removeStep({ requestId: 'remove-unknown', chatId: 'chat-1', messageId: 'message-1', stepId: 'missing' })).rejects.toThrow('计划不可删除')

    const lockedService = new ExecutionPlanService({
      get: vi.fn(async () => ({ chat: {
        messages: [{ id: 'message-1', role: 'assistant', state: 'complete', content: '{}', executionPlan: { ...plan(), status: 'executed' as const } }],
        shells: [],
      } })),
      updateMessage: vi.fn(async () => undefined),
    }, { snapshot: () => [], write: vi.fn() }, { match: vi.fn(() => null) })
    await expect(lockedService.removeStep({ requestId: 'remove-locked', chatId: 'chat-1', messageId: 'message-1', stepId: 'step-1' })).rejects.toThrow('计划不可删除')
  })

  it('serializes a removal behind an in-flight edit so a stale snapshot cannot restore a deleted step', async () => {
    let persistedPlan: ChatExecutionPlan = {
      ...plan(),
      steps: [
        ...plan().steps,
        { id: 'step-2', target: 'db-01', explanation: '查看数据库状态', originalCommand: 'systemctl status db', sendState: 'pending' as const },
      ],
    }
    let editSaveStarted!: () => void
    let releaseEditSave!: () => void
    const editSave = new Promise<void>(resolve => { editSaveStarted = resolve })
    const release = new Promise<void>(resolve => { releaseEditSave = resolve })
    const updateMessage = vi.fn(async (request: { requestId: string; executionPlan?: ChatExecutionPlan }) => {
      if (request.requestId === 'edit-race') {
        editSaveStarted()
        await release
      }
      if (request.executionPlan) persistedPlan = structuredClone(request.executionPlan)
      return undefined
    })
    const service = new ExecutionPlanService({
      get: vi.fn(async () => ({ chat: {
        messages: [{ id: 'message-1', role: 'assistant', state: 'complete', content: '{}', executionPlan: structuredClone(persistedPlan) }],
        shells: [],
      } })),
      updateMessage,
    }, { snapshot: () => [], write: vi.fn() }, { match: vi.fn(() => null) })

    const editing = service.editStep({ requestId: 'edit-race', chatId: 'chat-1', messageId: 'message-1', stepId: 'step-1', command: 'systemctl restart api' })
    await editSave
    const removing = service.removeStep({ requestId: 'remove-race', chatId: 'chat-1', messageId: 'message-1', stepId: 'step-2' })
    releaseEditSave()
    await Promise.all([editing, removing])

    expect(persistedPlan.steps).toEqual([expect.objectContaining({ id: 'step-1', finalCommand: 'systemctl restart api' })])
    expect(persistedPlan.steps).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'step-2' })]))
  })

  it('binds targets to the matching observed host when sessions share a route hostname', async () => {
    const write = vi.fn()
    const targetPlan = { ...plan(), steps: [{ ...plan().steps[0], target: 'db-prod' }] }
    const service = new ExecutionPlanService({
      get: vi.fn(async () => ({ chat: {
        messages: [{ id: 'message-1', role: 'assistant', state: 'complete', content: '{}', executionPlan: targetPlan }],
        shells: [
          { sessionId: 'session-web', hostname: '127.0.0.1', title: 'AI中台_10.54.98.34', status: 'open' },
          { sessionId: 'session-db', hostname: '127.0.0.1', title: 'AI中台_98.29', status: 'open' },
        ],
      } })),
      updateMessage: vi.fn(async () => undefined),
    }, {
      snapshot: () => [
        { id: 'session-web', hostname: '127.0.0.1', title: 'AI中台_10.54.98.34', observedHostname: 'web-prod' },
        { id: 'session-db', hostname: '127.0.0.1', title: 'AI中台_98.29', observedHostname: 'db-prod' },
      ],
      write,
    }, { match: () => null })

    await service.execute({ requestId: 'request-1', chatId: 'chat-1', messageId: 'message-1' })

    expect(write).toHaveBeenCalledWith('session-db', 'systemctl status api\n')
    expect(write).not.toHaveBeenCalledWith('session-web', 'systemctl status api\n')
  })

  it('matches canonical hostnames case-insensitively and ignores a trailing dot', async () => {
    const write = vi.fn()
    const targetPlan = { ...plan(), steps: [{ ...plan().steps[0], target: 'DB-PROD.' }] }
    const service = new ExecutionPlanService({
      get: vi.fn(async () => ({ chat: {
        messages: [{ id: 'message-1', role: 'assistant', state: 'complete', content: '{}', executionPlan: targetPlan }],
        shells: [
          { sessionId: 'session-web', hostname: '127.0.0.1', status: 'open' },
          { sessionId: 'session-db', hostname: '127.0.0.1', status: 'open' },
        ],
      } })),
      updateMessage: vi.fn(async () => undefined),
    }, {
      snapshot: () => [
        { id: 'session-web', hostname: '127.0.0.1', observedHostname: 'WEB-PROD' },
        { id: 'session-db', hostname: '127.0.0.1', observedHostname: 'db-prod' },
      ],
      write,
    }, { match: () => null })

    await service.execute({ requestId: 'request-canonical-case', chatId: 'chat-1', messageId: 'message-1' })

    expect(write).toHaveBeenCalledWith('session-db', 'systemctl status api\n')
    expect(write).not.toHaveBeenCalledWith('session-web', 'systemctl status api\n')
  })

  it('binds an ordinal target when shared route sessions have no distinct hostname or title', async () => {
    const write = vi.fn()
    const targetPlan = { ...plan(), steps: [{ ...plan().steps[0], target: '127.0.0.1#2' }] }
    const service = new ExecutionPlanService({
      get: vi.fn(async () => ({ chat: {
        messages: [{ id: 'message-1', role: 'assistant', state: 'complete', content: '{}', executionPlan: targetPlan }],
        shells: [
          { sessionId: 'session-first', hostname: '127.0.0.1', status: 'open' },
          { sessionId: 'session-second', hostname: '127.0.0.1', status: 'open' },
        ],
      } })),
      updateMessage: vi.fn(async () => undefined),
    }, {
      snapshot: () => [
        { id: 'session-first', hostname: '127.0.0.1' },
        { id: 'session-second', hostname: '127.0.0.1' },
      ],
      write,
    }, { match: () => null })

    await service.execute({ requestId: 'request-ordinal', chatId: 'chat-1', messageId: 'message-1' })

    expect(write).toHaveBeenCalledWith('session-second', 'systemctl status api\n')
    expect(write).not.toHaveBeenCalledWith('session-first', 'systemctl status api\n')
  })

  it('maps opaque model aliases back to hostname-less online sessions in association order', async () => {
    const write = vi.fn()
    const targets = resolveModelShellTargets([
      { stableKey: 'session-first', hostname: '127.0.0.1', displayName: 'Raw bridge 1' },
      { stableKey: 'session-second', hostname: '192.0.2.10', displayName: 'Raw bridge 2' },
    ])
    const targetPlan = { ...plan(), steps: [{ ...plan().steps[0], target: targets[1]! }] }
    const service = new ExecutionPlanService({
      get: vi.fn(async () => ({ chat: {
        messages: [{ id: 'message-1', role: 'assistant', state: 'complete', content: '{}', executionPlan: targetPlan }],
        shells: [
          { sessionId: 'session-first', hostname: '127.0.0.1', title: 'Raw bridge 1', status: 'open' },
          { sessionId: 'session-second', hostname: '192.0.2.10', title: 'Raw bridge 2', status: 'open' },
        ],
      } })),
      updateMessage: vi.fn(async () => undefined),
    }, {
      snapshot: () => [
        { id: 'session-first', hostname: '127.0.0.1', title: 'Raw bridge 1' },
        { id: 'session-second', hostname: '192.0.2.10', title: 'Raw bridge 2' },
      ],
      write,
    }, { match: () => null })

    await service.execute({ requestId: 'request-opaque-alias', chatId: 'chat-1', messageId: 'message-1' })

    expect(write).toHaveBeenCalledWith('session-second', 'systemctl status api\n')
    expect(write).not.toHaveBeenCalledWith('session-first', 'systemctl status api\n')
  })

  it('maps a strict user@hostname title hint to its corresponding session', async () => {
    const write = vi.fn()
    const targetPlan = { ...plan(), steps: [{ ...plan().steps[0], target: 'c-ce-js-0002' }] }
    const service = new ExecutionPlanService({
      get: vi.fn(async () => ({ chat: {
        messages: [{ id: 'message-1', role: 'assistant', state: 'complete', content: '{}', executionPlan: targetPlan }],
        shells: [
          { sessionId: 'session-first', hostname: '127.0.0.1', title: 'appuser@c-ce-js-0001', status: 'open' },
          { sessionId: 'session-second', hostname: '127.0.0.1', title: 'appuser@c-ce-js-0002', status: 'open' },
        ],
      } })),
      updateMessage: vi.fn(async () => undefined),
    }, {
      snapshot: () => [
        { id: 'session-first', hostname: '127.0.0.1', title: 'appuser@c-ce-js-0001' },
        { id: 'session-second', hostname: '127.0.0.1', title: 'appuser@c-ce-js-0002' },
      ],
      write,
    }, { match: () => null })

    await service.execute({ requestId: 'request-title-host', chatId: 'chat-1', messageId: 'message-1' })

    expect(write).toHaveBeenCalledWith('session-second', 'systemctl status api\n')
    expect(write).not.toHaveBeenCalledWith('session-first', 'systemctl status api\n')
  })

  it('executes through the real chat repository without an idempotency conflict', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'execution-plan-real-chat-'))
    try {
      const repository = new ChatRepository(join(directory, 'chat-workspaces.json'), {
        createId: (() => {
          let index = 0
          return () => `00000000-0000-4000-8000-${String(++index).padStart(12, '0')}`
        })(),
      })
      const chats = new ChatService(repository)
      const created = await chats.create({ requestId: 'create-real-plan' })
      const planMessage = await chats.appendMessage({
        requestId: 'append-real-plan',
        chatId: created.chat.id,
        role: 'assistant',
        state: 'complete',
        content: '{"version":1,"reply":"准备执行","plan":null}',
        executionPlan: plan(),
      })
      const messageId = planMessage.chat.messages.at(-1)!.id
      const session = { id: 'session-real', hostname: 'web-01', title: 'web-01' }
      await chats.associateShell({
        requestId: 'associate-real-plan',
        chatId: created.chat.id,
        sessionId: session.id,
        historyId: 'history-real-plan',
        hostname: session.hostname,
        title: session.title,
      })
      const write = vi.fn(async () => undefined)
      const service = new ExecutionPlanService(chats, {
        snapshot: () => [session],
        write,
      }, { match: () => null })

      await expect(service.execute({ requestId: 'execute-real-plan', chatId: created.chat.id, messageId })).resolves.toMatchObject({
        chat: { messages: [expect.objectContaining({ executionPlan: expect.objectContaining({ status: 'executed' }) })] },
      })
      expect(write).toHaveBeenCalledWith(session.id, 'systemctl status api\n')

      const restored = await repository.get(created.chat.id)
      expect(restored.messages.at(-1)?.executionPlan).toMatchObject({ status: 'executed' })
      await expect(chats.appendMessage({
        requestId: 'append-after-real-plan',
        chatId: created.chat.id,
        role: 'user',
        state: 'complete',
        content: '继续检查',
      })).resolves.toBeDefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

})
