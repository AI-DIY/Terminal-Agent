import { describe, expect, it } from 'vitest'
import { HOST_MEMORY_COMMANDS, hostMemoryCommandsForScopes } from '../../../src/shared/host-memory-commands'

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
  })

  it('always includes hostname and filters optional commands by enabled scope', () => {
    expect(hostMemoryCommandsForScopes({
      identity: false,
      hardware: false,
      processes: false,
      runtime: true,
    }).map(item => item.id)).toEqual([
      'hostname',
      'current-user',
      'working-directory',
      'services',
    ])
    expect(hostMemoryCommandsForScopes({
      identity: false,
      hardware: false,
      processes: false,
      runtime: false,
    }).map(item => item.command)).toEqual(['hostname'])
  })
})
