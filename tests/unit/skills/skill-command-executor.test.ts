import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { SkillCommandExecutor } from '../../../src/main/skills/skill-command-executor'

describe('SkillCommandExecutor', () => {
  it('runs an executable in the skill directory and captures output', async () => {
    const executor = new SkillCommandExecutor(() => process.cwd(), { platform: 'linux' })
    const result = await executor.run({ id: 'test-skill', invocationId: crypto.randomUUID(), executable: process.execPath, args: ['-e', 'process.stdout.write("ok")'] })
    expect(result).toMatchObject({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, cancelled: false })
  })

  it('normalizes curl to curl.exe for Windows inline commands', async () => {
    const calls: string[] = []
    const executor = new SkillCommandExecutor(() => process.cwd(), {
      platform: 'win32',
      spawnProcess: ((command: string) => {
        calls.push(command)
        const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }
        child.stdout = new EventEmitter()
        child.stderr = new EventEmitter()
        child.kill = () => { child.emit('close', 0) }
        queueMicrotask(() => child.emit('close', 0))
        return child
      }) as never,
    })
    await executor.run({ id: 'test-skill', invocationId: crypto.randomUUID(), command: 'curl https://example.com' })
    expect(calls[0]).toBe('curl.exe https://example.com')
  })

  it('marks aborted executions as cancelled', async () => {
    const controller = new AbortController()
    const executor = new SkillCommandExecutor(() => process.cwd(), { timeoutMs: 5_000 })
    const running = executor.run({ id: 'test-skill', invocationId: crypto.randomUUID(), executable: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'] }, controller.signal)
    controller.abort()
    const result = await running
    expect(result.cancelled).toBe(true)
  })

  it('does not spawn when cancellation was already requested', async () => {
    const controller = new AbortController()
    controller.abort()
    let spawned = false
    const executor = new SkillCommandExecutor(() => process.cwd(), {
      spawnProcess: (() => { spawned = true; throw new Error('must not spawn') }) as never,
    })
    const result = await executor.run({ id: 'test-skill', invocationId: crypto.randomUUID(), executable: process.execPath }, controller.signal)
    expect(result).toMatchObject({ exitCode: null, stdout: '', stderr: '', timedOut: false, cancelled: true })
    expect(spawned).toBe(false)
  })
})
