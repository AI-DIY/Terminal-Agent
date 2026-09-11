import { describe, expect, it, vi } from 'vitest'
import { buildStructuredShellContext, dedupeStructuredShellsForPrompt, StructuredChatAgent } from '../../../src/main/chat/structured-chat-agent'

const request = {
  messages: [{ role: 'user' as const, content: '检查服务' }],
  availableHostnames: ['web-02'],
}

describe('StructuredChatAgent', () => {
  it('projects online task associations in stored order with connection-title display labels', () => {
    expect(buildStructuredShellContext([
      { sessionId: 'first', hostname: 'web-01', title: 'primary', status: 'open' },
      { sessionId: 'second', hostname: 'web-01', title: 'secondary', status: 'open' },
      { sessionId: 'closed', hostname: 'db-01', title: 'closed', status: 'closed' },
    ], [
      { id: 'second', hostname: 'web-01', title: 'secondary' },
      { id: 'first', hostname: 'web-01', title: 'primary' },
      { id: 'closed', hostname: 'db-01', title: 'closed' },
    ])).toEqual([
      { hostname: 'web-01', title: 'primary', displayLabel: 'primary #1', ordinal: 1 },
      { hostname: 'web-01', title: 'secondary', displayLabel: 'secondary #2', ordinal: 2 },
    ])
  })

  it('keeps AI duplicate ordinals tied to stable session ids when association order changes', () => {
    expect(buildStructuredShellContext([
      { sessionId: 'session-b', hostname: 'web-01', title: 'second', status: 'open' },
      { sessionId: 'session-a', hostname: 'web-01', title: 'first', status: 'open' },
    ], [
      { id: 'session-a', hostname: 'web-01', title: 'first' },
      { id: 'session-b', hostname: 'web-01', title: 'second' },
    ])).toEqual([
      { hostname: 'web-01', title: 'second', displayLabel: 'second #2', ordinal: 2 },
      { hostname: 'web-01', title: 'first', displayLabel: 'first #1', ordinal: 1 },
    ])
  })

  it('carries recent output lines into each matching online Shell context entry', () => {
    expect(buildStructuredShellContext([
      { sessionId: 'first', hostname: 'web-01', title: 'primary', status: 'open' },
    ], [
      { id: 'first', hostname: 'web-01', title: 'primary', recentLines: ['last command', 'result'] },
    ])).toEqual([
      {
        hostname: 'web-01',
        title: 'primary',
        displayLabel: 'primary',
        ordinal: 1,
        recentLines: ['last command', 'result'],
      },
    ])
  })

  it('carries the observed hostname as the canonical AI target identity', () => {
    expect(buildStructuredShellContext([
      { sessionId: 'first', hostname: '127.0.0.1', title: 'AI中台_10.54.98.34', status: 'open' },
      { sessionId: 'second', hostname: '127.0.0.1', title: 'AI中台_98.29', status: 'open' },
    ], [
      { id: 'first', hostname: '127.0.0.1', title: 'AI中台_10.54.98.34', observedHostname: 'web-prod' },
      { id: 'second', hostname: '127.0.0.1', title: 'AI中台_98.29', observedHostname: 'db-prod' },
    ])).toMatchObject([
      { hostname: 'web-prod', observedHostname: 'web-prod' },
      { hostname: 'db-prod', observedHostname: 'db-prod' },
    ])
  })

  it('uses a valid persisted observation when the live observation is malformed', () => {
    expect(buildStructuredShellContext([
      { sessionId: 'first', hostname: '127.0.0.1', observedHostname: 'persisted-host', title: 'bridge', status: 'open' },
    ], [
      { id: 'first', hostname: '127.0.0.1', observedHostname: 'not a hostname', title: 'bridge' },
    ])).toMatchObject([{ hostname: 'persisted-host' }])
  })

  it('falls back to the association hostname when the live endpoint only exposes an address', () => {
    expect(buildStructuredShellContext([
      { sessionId: 'first', hostname: 'real-host', title: '连接 192.0.2.10', status: 'open' },
    ], [
      { id: 'first', hostname: '192.0.2.10', observedHostname: 'not a hostname', title: '连接 192.0.2.10' },
    ])).toEqual([
      { hostname: 'real-host', title: '连接', displayLabel: '连接', ordinal: 1 },
    ])
  })

  it('keeps an IP-only online Shell visible through a strict user@hostname title hint', () => {
    const shells = buildStructuredShellContext([
      { sessionId: 'access-session', hostname: '127.0.0.1', title: 'appuser@c-ce-js-0002', status: 'open' },
    ], [
      { id: 'access-session', hostname: '127.0.0.1', title: 'appuser@c-ce-js-0002', recentLines: ['[appuser@c-ce-js-0002 ~]$ free -h', '172.17.0.1/16'] },
    ])

    expect(shells).toMatchObject([{ hostname: 'c-ce-js-0002', title: 'appuser@c-ce-js-0002' }])
    expect(JSON.stringify(shells)).not.toContain('127.0.0.1')
    expect(JSON.stringify(shells)).not.toContain('172.17.0.1')
  })

  it('keeps hostname-less Raw Shells with unique safe targets and no address literals', () => {
    const shells = buildStructuredShellContext([
      { sessionId: 'raw-first', hostname: '127.0.0.1', title: 'Raw bridge 1', status: 'open' },
      { sessionId: 'raw-second', hostname: '127.0.0.1', title: 'Raw bridge 2', status: 'open' },
    ], [
      { id: 'raw-first', hostname: '127.0.0.1', title: 'Raw bridge 1', recentLines: ['connected to 127.0.0.1'] },
      { id: 'raw-second', hostname: '127.0.0.1', title: 'Raw bridge 2' },
    ])

    expect(shells.map(shell => shell.hostname)).toHaveLength(2)
    expect(shells.every(shell => /^online-shell-[a-z0-9-]+$/.test(shell.hostname))).toBe(true)
    expect(shells[0]?.hostname).not.toBe(shells[1]?.hostname)
    expect(new Set(shells.map(shell => shell.hostname)).size).toBe(2)
    expect(JSON.stringify(shells)).not.toContain('127.0.0.1')
  })

  it('deduplicates repeated model hosts by retaining the stable #1 entry', () => {
    expect(dedupeStructuredShellsForPrompt([
      { hostname: 'web-01', title: 'second', displayLabel: 'second #2', ordinal: 2 },
      { hostname: 'web-01', title: 'first', displayLabel: 'first #1', ordinal: 1 },
    ])).toEqual([
      { hostname: 'web-01', title: 'first', displayLabel: 'first #1', ordinal: 1 },
    ])
  })

  it('includes the safe Shell target in the structured system prompt and allow-list', async () => {
    let system = ''
    const complete = vi.fn(async messages => {
      system = String(messages[0]?.content ?? '')
      return '{"version":1,"reply":"已看到在线 Shell。","plan":null}'
    })
    const availableShells = buildStructuredShellContext([
      { sessionId: 'raw-session', hostname: '127.0.0.1', title: 'Raw bridge', status: 'open' },
    ], [{ id: 'raw-session', hostname: '127.0.0.1', title: 'Raw bridge' }])

    await expect(new StructuredChatAgent({ complete }).run({
      messages: [{ role: 'user', content: '当前运行情况如何' }],
      availableHostnames: availableShells.map(shell => shell.hostname),
      availableShells,
    })).resolves.toMatchObject({ reply: '已看到在线 Shell。' })

    expect(system).toContain(availableShells[0]!.hostname)
    expect(availableShells[0]!.hostname).toMatch(/^online-shell-[a-z0-9-]+$/)
    expect(system).toContain('匿名 Shell 标识')
    expect(system).toContain('当前任务上下文优先于历史 assistant 回复')
    expect(system).not.toContain('127.0.0.1')
  })

  it('returns the first valid JSON response without exposing provider deltas', async () => {
    const complete = vi.fn().mockResolvedValue('{"version":1,"reply":"已准备。","plan":null}')
    await expect(new StructuredChatAgent({ complete }).run(request)).resolves.toMatchObject({ reply: '已准备。', plan: null })
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('keeps catalogue-only demo skills out of the model instructions', async () => {
    let system = ''
    const complete = vi.fn(async messages => {
      system = String(messages[0]?.content ?? '')
      return '{"version":1,"reply":"已准备。","plan":null}'
    })

    await expect(new StructuredChatAgent({ complete }).run({
      ...request,
      skillIds: ['security-review'],
    })).resolves.toMatchObject({ reply: '已准备。' })

    expect(system).toContain('当前启用的产品技能工作方法')
    expect(system).toContain('当前启用的产品技能工作方法：[]')
    expect(system).toContain('不能绕过任何安全围栏')
    expect(system).not.toContain('多主机巡检')
  })

  it('repairs invalid JSON twice at most and fails after the third model call', async () => {
    const complete = vi.fn().mockResolvedValueOnce('{not json').mockResolvedValueOnce('{still invalid').mockResolvedValueOnce('{also invalid')
    await expect(new StructuredChatAgent({ complete }).run(request)).rejects.toThrow('AI 未能生成可执行计划，请重试。')
    expect(complete).toHaveBeenCalledTimes(3)
  })

  it('repairs a plan that targets an offline hostname', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce('{"version":1,"reply":"准备","plan":{"title":"检查","steps":[{"target":"missing-host","explanation":"检查","command":"pwd"}]}}')
      .mockResolvedValueOnce('{"version":1,"reply":"准备","plan":{"title":"检查","steps":[{"target":"web-02","explanation":"检查","command":"pwd"}]}}')
    await expect(new StructuredChatAgent({ complete }).run(request)).resolves.toMatchObject({ plan: { steps: [{ target: 'web-02' }] } })
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('reports bounded thinking and repairing stages without exposing generated JSON', async () => {
    const stages: string[] = []
    const complete = vi.fn()
      .mockResolvedValueOnce('{not json')
      .mockResolvedValueOnce('{"version":1,"reply":"完成","plan":null}')
    await expect(new StructuredChatAgent({ complete, onStage: stage => stages.push(stage) }).run(request)).resolves.toMatchObject({ reply: '完成' })
    expect(stages).toEqual(['thinking', 'repairing', 'thinking', 'observing'])
    expect(stages.every(stage => ['thinking', 'executing', 'observing', 'repairing'].includes(stage))).toBe(true)
    expect(stages.join(' ')).not.toContain('{')
  })

  it('gives the model hostname-based display labels while retaining hostname targets', async () => {
    let system = ''
    const complete = vi.fn(async messages => {
      system = String(messages[0]?.content ?? '')
      return '{"version":1,"reply":"完成","plan":{"title":"检查","steps":[{"target":"web-01","explanation":"检查","command":"pwd"}]}}'
    })
    await expect(new StructuredChatAgent({ complete }).run({
      ...request,
      availableHostnames: ['web-01'],
      availableShells: [{ hostname: 'web-01', title: '10.54.98.34', displayLabel: 'web-01 #1', ordinal: 1 }],
    })).resolves.toMatchObject({ plan: { steps: [{ target: 'web-01' }] } })
    expect(system).toContain('web-01 #1')
    expect(system).toContain('displayLabel')
    expect(system).toContain('target')
    expect(system).not.toContain('10.54.98.34')
  })

  it('treats repeated hostnames as one model target and strips IPs from retry context', async () => {
    const systems: string[] = []
    const complete = vi.fn()
      .mockImplementationOnce(async (messages: Array<{ content: unknown }>) => {
        systems.push(String(messages[0]?.content ?? ''))
        return '{"version":1,"reply":"重试","plan":{"title":"检查","steps":[{"target":"missing-192.0.2.10","explanation":"检查","command":"pwd"}]}}'
      })
      .mockImplementationOnce(async (messages: Array<{ content: unknown }>) => {
        systems.push(`${String(messages[0]?.content ?? '')}\n${String(messages.at(-1)?.content ?? '')}`)
        return '{"version":1,"reply":"完成","plan":null}'
      })

    await expect(new StructuredChatAgent({ complete }).run({
      messages: [{ role: 'user', content: '检查 192.0.2.10' }],
      availableHostnames: ['vm-01', 'VM-01', '192.0.2.10'],
      availableShells: [
        { hostname: 'vm-01', title: '主连接 192.0.2.10', displayLabel: '主连接 192.0.2.10', ordinal: 1 },
        { hostname: 'vm-01', title: '备用连接', displayLabel: '备用连接 #2', ordinal: 2 },
      ],
    })).resolves.toMatchObject({ plan: null })

    expect(systems[0]).toContain('["vm-01"]')
    expect(systems[0]).not.toContain('192.0.2.10')
    expect(systems[1]).not.toContain('192.0.2.10')
  })

  it('runs one standard Skill action, feeds its result back, then returns the final reply', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ action: { type: 'load_skill', skillId: 'echo-hello' } }))
      .mockResolvedValueOnce('{"version":1,"reply":"技能已加载。","plan":null}')
    const loadSkill = vi.fn().mockResolvedValue({ id: 'echo-hello', name: 'echo-hello', description: 'Echo', content: '# Echo' })
    const events: string[] = []
    await expect(new StructuredChatAgent({ complete }).run({
      ...request,
      skillCatalog: [{ id: 'echo-hello', name: 'echo-hello', description: 'Echo', enabled: true }],
      skillRuntime: { loadSkill, readSkillFile: vi.fn(), runSkillCommand: vi.fn(), onEvent: event => events.push(event.stage) },
    })).resolves.toMatchObject({ reply: '技能已加载。' })
    expect(loadSkill).toHaveBeenCalledWith('echo-hello', undefined)
    expect(complete).toHaveBeenCalledTimes(2)
    expect(events).toEqual(['loading', 'organizing', 'completed'])
    expect(String(complete.mock.calls[1]?.[0]?.at(-1)?.content)).toContain('技能动作结果')
  })

  it('skips disabled standard Skill actions without invoking the executor', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ action: { type: 'run_skill_command', skillId: 'echo-hello', invocationId: crypto.randomUUID(), command: 'echo hi' } }))
      .mockResolvedValueOnce('{"version":1,"reply":"未启用，未执行。","plan":null}')
    const runSkillCommand = vi.fn()
    await expect(new StructuredChatAgent({ complete }).run({
      ...request,
      skillCatalog: [{ id: 'echo-hello', name: 'echo-hello', description: 'Echo', enabled: false }],
      skillRuntime: { loadSkill: vi.fn(), readSkillFile: vi.fn(), runSkillCommand },
    })).resolves.toMatchObject({ reply: '未启用，未执行。' })
    expect(runSkillCommand).not.toHaveBeenCalled()
  })

  it('feeds a structured failure back when the optional Skill runtime is unavailable', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ action: { type: 'load_skill', skillId: 'echo-hello' } }))
      .mockResolvedValueOnce('{"version":1,"reply":"当前环境不支持技能，继续普通回答。","plan":null}')

    await expect(new StructuredChatAgent({ complete }).run({
      ...request,
      skillCatalog: [{ id: 'echo-hello', name: 'echo-hello', description: 'Echo', enabled: true }],
    })).resolves.toMatchObject({ reply: '当前环境不支持技能，继续普通回答。' })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(String(complete.mock.calls[1]?.[0]?.at(-1)?.content)).toContain('当前环境未启用技能执行器')
  })

  it('does not repeat a completed command when the provider replays its invocation id', async () => {
    const invocationId = crypto.randomUUID()
    const action = { type: 'run_skill_command', skillId: 'echo-hello', invocationId, executable: 'node', args: ['scripts/echo.js'] }
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ action }))
      .mockResolvedValueOnce(JSON.stringify({ action }))
      .mockResolvedValueOnce('{"version":1,"reply":"命令结果已整理。","plan":null}')
    const runSkillCommand = vi.fn().mockResolvedValue({ id: 'echo-hello', invocationId, exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, cancelled: false })

    await expect(new StructuredChatAgent({ complete }).run({
      ...request,
      skillCatalog: [{ id: 'echo-hello', name: 'echo-hello', description: 'Echo', enabled: true }],
      skillRuntime: { loadSkill: vi.fn(), readSkillFile: vi.fn(), runSkillCommand },
    })).resolves.toMatchObject({ reply: '命令结果已整理。' })
    expect(runSkillCommand).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledTimes(3)
  })

  it('requires a selected local Skill to load, run, and feed its result back before a final reply', async () => {
    const invocationId = crypto.randomUUID()
    const document = {
      id: 'query-system-inspection',
      name: 'query-system-inspection',
      description: 'Query a local system-inspection source.',
      content: '---\nname: query-system-inspection\ndescription: Query a local source.\n---\n\n```text\nnode scripts/query-system.js "example-user"\n```',
    }
    const complete = vi.fn()
      // This mirrors the reported failure: a model tries to answer with a
      // progress message instead of actually invoking the selected Skill.
      .mockResolvedValueOnce('{"version":1,"reply":"正在查询，请稍候。","plan":null}')
      .mockResolvedValueOnce(JSON.stringify({ action: {
        type: 'run_skill_command', skillId: 'query-system-inspection', invocationId,
        executable: 'node', args: ['scripts/query-system.js', 'e0074566'],
      } }))
      .mockResolvedValueOnce('{"version":1,"reply":"查询结果已整理。","plan":null}')
    const loadSkill = vi.fn().mockResolvedValue(document)
    const runSkillCommand = vi.fn().mockResolvedValue({
      id: 'query-system-inspection', invocationId, exitCode: 0, stdout: 'application-a', stderr: '', timedOut: false, cancelled: false,
    })
    const events: string[] = []

    await expect(new StructuredChatAgent({ complete }).run({
      messages: [{ role: 'user', content: 'e0074566 归属哪个应用系统？' }],
      // A local Skill must not depend on a remote Shell being online.
      availableHostnames: [],
      selectedSkillIds: ['query-system-inspection'],
      skillCatalog: [{ id: 'query-system-inspection', name: 'query-system-inspection', description: document.description, enabled: true }],
      skillRuntime: { loadSkill, readSkillFile: vi.fn(), runSkillCommand, onEvent: event => events.push(event.stage) },
    })).resolves.toMatchObject({ reply: '查询结果已整理。', plan: null })

    expect(loadSkill).toHaveBeenCalledWith('query-system-inspection', undefined)
    expect(runSkillCommand).toHaveBeenCalledWith({
      id: 'query-system-inspection', invocationId, executable: 'node', args: ['scripts/query-system.js', 'e0074566'],
    }, undefined)
    expect(complete).toHaveBeenCalledTimes(3)
    expect(String(complete.mock.calls[0]?.[0]?.[0]?.content)).toContain('本机技能独立于在线 Shell')
    expect(String(complete.mock.calls[1]?.[0]?.at(-1)?.content)).toContain('尚未实际执行')
    expect(String(complete.mock.calls[2]?.[0]?.at(-1)?.content)).toContain('application-a')
    expect(events).toEqual(['loading', 'organizing', 'completed', 'executing', 'completed'])
  })

  it('allows a selected Skill to execute a dynamic curl command after loading its fixed example', async () => {
    const invocationId = crypto.randomUUID()
    const document = {
      id: 'query-system-inspection', name: 'query-system-inspection', description: 'Queries an application system.',
      content: '---\nname: query-system-inspection\ndescription: Queries an application system.\n---\n\nUse curl with the provided employee number.\n\n```text\ncurl.exe -s "https://query.example.test/lookup?employee=e0128483&scope=application"\n```',
    }
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ action: {
        type: 'run_skill_command', skillId: 'query-system-inspection', invocationId,
        command: 'curl.exe -s "https://query.example.test/lookup?employee=e0074566&scope=application"',
      } }))
      .mockResolvedValueOnce('{"version":1,"reply":"已查询 e0074566。","plan":null}')
    const runSkillCommand = vi.fn().mockResolvedValue({
      id: 'query-system-inspection', invocationId, exitCode: 0, stdout: 'application-a', stderr: '', timedOut: false, cancelled: false,
    })

    await expect(new StructuredChatAgent({ complete }).run({
      ...request,
      messages: [{ role: 'user', content: '查询 e0074566 归属的应用系统' }],
      availableHostnames: [],
      selectedSkillIds: ['query-system-inspection'],
      skillCatalog: [{ id: 'query-system-inspection', name: 'query-system-inspection', description: document.description, enabled: true }],
      skillRuntime: { loadSkill: vi.fn().mockResolvedValue(document), readSkillFile: vi.fn(), runSkillCommand },
    })).resolves.toMatchObject({ reply: '已查询 e0074566。' })

    expect(runSkillCommand).toHaveBeenCalledTimes(1)
    expect(runSkillCommand).toHaveBeenCalledWith({
      id: 'query-system-inspection', invocationId,
      command: 'curl.exe -s "https://query.example.test/lookup?employee=e0074566&scope=application"',
    }, undefined)
    expect(JSON.stringify(complete.mock.calls[1]?.[0])).toContain('employee=e0074566')
  })

  it('allows an explicitly selected Skill to ask for a genuinely missing input through clarify_skill', async () => {
    const document = {
      id: 'requires-ticket', name: 'requires-ticket', description: 'Looks up a ticket.',
      content: '---\nname: requires-ticket\ndescription: Looks up a ticket.\n---\n\nA ticket number is required before this local lookup can run.',
    }
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ action: {
        type: 'clarify_skill', skillId: 'requires-ticket', missingInput: '工单编号',
      } }))
      .mockResolvedValueOnce('{"version":1,"reply":"请提供工单编号。","plan":null}')
    const runSkillCommand = vi.fn()

    await expect(new StructuredChatAgent({ complete }).run({
      ...request,
      selectedSkillIds: ['requires-ticket'],
      skillCatalog: [{ id: 'requires-ticket', name: 'requires-ticket', description: document.description, enabled: true }],
      skillRuntime: { loadSkill: vi.fn().mockResolvedValue(document), readSkillFile: vi.fn(), runSkillCommand },
    })).resolves.toMatchObject({ reply: '请提供工单编号。' })

    expect(runSkillCommand).not.toHaveBeenCalled()
    expect(String(complete.mock.calls[1]?.[0]?.at(-1)?.content)).toContain('"missingInput":"工单编号"')
  })

  it.each([
    ['missing', [] as Array<{ id: string; name: string; description: string; enabled: boolean }>, '技能不存在或当前不可用'],
    ['disabled', [{ id: 'unavailable', name: 'unavailable', description: 'Disabled.', enabled: false }], '技能已禁用'],
  ])('reports an explicitly selected %s Skill without invoking local execution', async (_kind, skillCatalog, reason) => {
    const loadSkill = vi.fn()
    const runSkillCommand = vi.fn()
    let system = ''
    const complete = vi.fn(async messages => {
      system = String(messages[1]?.content ?? '')
      return '{"version":1,"reply":"技能当前不可用。","plan":null}'
    })

    await expect(new StructuredChatAgent({ complete }).run({
      ...request,
      selectedSkillIds: ['unavailable'],
      skillCatalog,
      skillRuntime: { loadSkill, readSkillFile: vi.fn(), runSkillCommand },
    })).resolves.toMatchObject({ reply: '技能当前不可用。' })

    expect(loadSkill).not.toHaveBeenCalled()
    expect(runSkillCommand).not.toHaveBeenCalled()
    expect(system).toContain(reason)
  })

  it('feeds selected Skill timeout details into the final reasoning turn', async () => {
    const invocationId = crypto.randomUUID()
    const document = {
      id: 'slow-check', name: 'slow-check', description: 'Runs a local check.',
      content: '---\nname: slow-check\ndescription: Runs a local check.\n---\n\n```text\nnode scripts/slow-check.js\n```',
    }
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ action: {
        type: 'run_skill_command', skillId: 'slow-check', invocationId, executable: 'node', args: ['scripts/slow-check.js'],
      } }))
      .mockResolvedValueOnce('{"version":1,"reply":"本机检查超时。","plan":null}')
    const runSkillCommand = vi.fn().mockResolvedValue({
      id: 'slow-check', invocationId, exitCode: null, stdout: 'partial', stderr: 'timed out', timedOut: true, cancelled: false,
    })

    await expect(new StructuredChatAgent({ complete }).run({
      ...request,
      selectedSkillIds: ['slow-check'],
      skillCatalog: [{ id: 'slow-check', name: 'slow-check', description: document.description, enabled: true }],
      skillRuntime: { loadSkill: vi.fn().mockResolvedValue(document), readSkillFile: vi.fn(), runSkillCommand },
    })).resolves.toMatchObject({ reply: '本机检查超时。' })

    expect(runSkillCommand).toHaveBeenCalledOnce()
    expect(String(complete.mock.calls[1]?.[0]?.at(-1)?.content)).toContain('"timedOut":true')
  })

  it('rejects an oversized Skill prompt before calling the model', async () => {
    const complete = vi.fn()
    await expect(new StructuredChatAgent({ complete }).run({
      ...request,
      contextLimit: 1,
      skillCatalog: [{ id: 'echo-hello', name: 'echo-hello', description: 'Echo', enabled: true }],
    })).rejects.toThrow('聊天上下文及技能说明超出当前模型限制')
    expect(complete).not.toHaveBeenCalled()
  })

  it('accepts a fenced action with alternative keys and a missing invocation id', async () => {
    const document = {
      id: 'query-system-inspection', name: 'query-system-inspection', description: 'Queries an application system.',
      content: '---\nname: query-system-inspection\ndescription: Queries an application system.\n---\n\nnode scripts/query-system.js\n',
    }
    const runSkillCommand = vi.fn().mockImplementation(async (input: { invocationId: string }) => ({
      id: 'query-system-inspection', invocationId: input.invocationId, exitCode: 0, stdout: 'application-a', stderr: '', timedOut: false, cancelled: false,
    }))
    const complete = vi.fn()
      // Weaker models wrap the object in a fence and use snake_case keys.
      .mockResolvedValueOnce('```json\n{"action":{"type":"run_skill_command","skill_id":"query-system-inspection","command":"node scripts/query-system.js --list e0074566"}}\n```')
      .mockResolvedValueOnce('{"version":1,"reply":"已查询。","plan":null}')

    await expect(new StructuredChatAgent({ complete }).run({
      ...request,
      messages: [{ role: 'user', content: 'e0074566 归属哪个应用系统？' }],
      availableHostnames: [],
      selectedSkillIds: ['query-system-inspection'],
      skillCatalog: [{ id: 'query-system-inspection', name: 'query-system-inspection', description: document.description, enabled: true }],
      skillRuntime: { loadSkill: vi.fn().mockResolvedValue(document), readSkillFile: vi.fn(), runSkillCommand },
    })).resolves.toMatchObject({ reply: '已查询。' })

    const call = runSkillCommand.mock.calls[0]?.[0] as { id: string; invocationId: string; command?: string; executable?: string }
    expect(call.id).toBe('query-system-inspection')
    expect(call.command).toBe('node scripts/query-system.js --list e0074566')
    expect(call.invocationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })

  it('splits an argv command and prefers the inline command when both forms are supplied', async () => {
    const document = {
      id: 'query-system-inspection', name: 'query-system-inspection', description: 'Queries an application system.',
      content: '---\nname: query-system-inspection\ndescription: Queries an application system.\n---\n\nnode scripts/query-system.js\n',
    }
    const runSkillCommand = vi.fn().mockImplementation(async (input: { invocationId: string }) => ({
      id: 'query-system-inspection', invocationId: input.invocationId, exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, cancelled: false,
    }))
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        action: {
          type: 'run_skill_command',
          skillId: 'query-system-inspection',
          // Both forms at once used to fail the strict schema and look like
          // "no action returned" to the user.
          command: 'node scripts/query-system.js --list e0074566',
          executable: 'node',
          args: ['scripts/query-system.js', '--list', 'e0074566'],
        },
      }))
      .mockResolvedValueOnce('{"version":1,"reply":"已查询。","plan":null}')

    await expect(new StructuredChatAgent({ complete }).run({
      ...request,
      availableHostnames: [],
      selectedSkillIds: ['query-system-inspection'],
      skillCatalog: [{ id: 'query-system-inspection', name: 'query-system-inspection', description: document.description, enabled: true }],
      skillRuntime: { loadSkill: vi.fn().mockResolvedValue(document), readSkillFile: vi.fn(), runSkillCommand },
    })).resolves.toMatchObject({ reply: '已查询。' })

    expect(runSkillCommand.mock.calls[0]?.[0]).toMatchObject({
      id: 'query-system-inspection',
      command: 'node scripts/query-system.js --list e0074566',
    })

    const argvComplete = vi.fn()
      .mockResolvedValueOnce('{"action":{"type":"run_skill_command","skillId":"query-system-inspection","invocationId":"not-a-uuid","executable":"node","args":"scripts/query-system.js --list e0074566"}}')
      .mockResolvedValueOnce('{"version":1,"reply":"已查询。","plan":null}')
    const argvRunner = vi.fn().mockImplementation(async (input: { invocationId: string }) => ({
      id: 'query-system-inspection', invocationId: input.invocationId, exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, cancelled: false,
    }))

    await expect(new StructuredChatAgent({ complete: argvComplete }).run({
      ...request,
      availableHostnames: [],
      selectedSkillIds: ['query-system-inspection'],
      skillCatalog: [{ id: 'query-system-inspection', name: 'query-system-inspection', description: document.description, enabled: true }],
      skillRuntime: { loadSkill: vi.fn().mockResolvedValue(document), readSkillFile: vi.fn(), runSkillCommand: argvRunner },
    })).resolves.toMatchObject({ reply: '已查询。' })

    expect(argvRunner.mock.calls[0]?.[0]).toMatchObject({
      id: 'query-system-inspection',
      executable: 'node',
      args: ['scripts/query-system.js', '--list', 'e0074566'],
    })
  })
})
