import { describe, expect, it } from 'vitest'
import {
  HOST_MEMORY_COMMAND_GROUPS,
  HOST_MEMORY_COMMANDS,
  hostMemoryCommandWillRun,
  hostMemoryCommandsForScopes,
} from '../../../src/shared/host-memory-commands'

describe('host memory command catalog', () => {
  it('keeps the fixed read-only commands in their execution order', () => {
    expect(HOST_MEMORY_COMMANDS.map(item => item.id)).toEqual([
      'hostname',
      'os-name',
      'os-version',
      'cpu-model',
      'cpu-architecture',
      'cpu-cores',
      'memory',
      'disks',
      'network',
      'processes',
      'current-user',
      'working-directory',
      'services',
    ])
    expect(HOST_MEMORY_COMMANDS[0]).toMatchObject({
      id: 'hostname',
      command: 'hostname',
      required: true,
      scope: null,
    })
    expect(HOST_MEMORY_COMMANDS[1]).toMatchObject({
      id: 'os-name',
      command: 'uname -s',
      required: true,
      scope: null,
    })
  })

  it('always includes hostname and filters optional commands by enabled scope', () => {
    expect(hostMemoryCommandsForScopes({
      identity: false,
      hardware: false,
      processes: false,
      runtime: true,
    }).map(item => item.id)).toEqual([
      'hostname',
      'os-name',
      'current-user',
      'working-directory',
      'services',
    ])
    expect(hostMemoryCommandsForScopes({
      identity: false,
      hardware: false,
      processes: false,
      runtime: false,
    }).map(item => item.command)).toEqual(['hostname', 'uname -s'])
  })

  it('groups every command and respects both the global toggle and scopes', () => {
    expect(HOST_MEMORY_COMMAND_GROUPS.map(group => [group.id, group.label])).toEqual([
      ['identity', '身份与系统'],
      ['hardware', '硬件'],
      ['processes', '进程'],
      ['runtime', '运行环境'],
    ])
    expect(HOST_MEMORY_COMMAND_GROUPS.flatMap(group => (
      HOST_MEMORY_COMMANDS.filter(item => item.group === group.id).map(item => item.id)
    ))).toEqual(HOST_MEMORY_COMMANDS.map(item => item.id))

    const enabled = { enabled: true, scopes: { identity: true, hardware: false, processes: true, runtime: false } }
    expect(HOST_MEMORY_COMMANDS.map(item => hostMemoryCommandWillRun(item, enabled))).toEqual([
      true, true, true, false, false, false, false, false, false, true, false, false, false,
    ])
    expect(HOST_MEMORY_COMMANDS.every(item => !hostMemoryCommandWillRun(item, { ...enabled, enabled: false }))).toBe(true)
  })
})
