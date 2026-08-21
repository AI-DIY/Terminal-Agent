import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { implementedPrototypeActions } from '../../../src/renderer/src/prototype-actions'

const EXPECTED_SOURCE = 'simplified-core-workbench-v18-unified-ssh-connection.html'
const EXPECTED_AREAS = [
  'chatSessions',
  'shellCanvas',
  'globalChat',
  'settings',
  'ssh',
] as const
const EXPECTED_AREA_ACTION_COUNTS = {
  chatSessions: 4,
  shellCanvas: 7,
  globalChat: 9,
  settings: 6,
  ssh: 4,
} as const
const REVIEWED_FIXTURE_ACTION_IDS = [
  'chatSessions.create',
  'chatSessions.select-live',
  'chatSessions.select-history',
  'chatSessions.restore-live',
  'shellCanvas.layout',
  'shellCanvas.focus',
  'shellCanvas.close',
  'shellCanvas.maximize',
  'shellCanvas.duplicate',
  'shellCanvas.reconnect',
  'shellCanvas.history',
  'globalChat.send',
  'globalChat.stream',
  'globalChat.retry',
  'globalChat.compress',
  'globalChat.copilot',
  'globalChat.autonomous',
  'globalChat.edit-plan',
  'globalChat.approve',
  'globalChat.reject',
  'settings.routing',
  'settings.llm-profiles',
  'settings.vlm-profiles',
  'settings.fence',
  'settings.memory',
  'settings.appearance',
  'settings.memory',
  'ssh.cmdb',
  'ssh.bastion-host',
  'ssh.password',
  'ssh.private-key',
] as const
const REVIEWED_IMPLEMENTED_ACTION_IDS = [
  'chatSessions.create',
  'chatSessions.select-live',
  'chatSessions.select-history',
  'chatSessions.restore-live',
  'shellCanvas.layout',
  'shellCanvas.focus',
  'shellCanvas.close',
  'shellCanvas.maximize',
  'shellCanvas.duplicate',
  'shellCanvas.reconnect',
  'shellCanvas.history',
  'settings.routing',
  'settings.llm-profiles',
  'settings.vlm-profiles',
  'settings.fence',
  'settings.appearance',
  'settings.memory',
  'ssh.cmdb',
  'ssh.bastion-host',
  'ssh.password',
  'ssh.private-key',
] as const
const CANONICAL_ACTION_ID = /^[A-Za-z][A-Za-z0-9]*\.[a-z0-9]+(?:-[a-z0-9]+)*$/

type PrototypeArea = (typeof EXPECTED_AREAS)[number]
type PrototypeFixture = {
  source: string
  areas: Record<PrototypeArea, string[]>
}

function assertValidPrototypeFixture(value: unknown): asserts value is PrototypeFixture {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('prototype fixture must be an object')
  }

  const fixture = value as Record<string, unknown>
  const actualRootKeys = Object.keys(fixture).sort()
  const expectedRootKeys = ['areas', 'source']
  if (JSON.stringify(actualRootKeys) !== JSON.stringify(expectedRootKeys)) {
    throw new Error(
      `prototype fixture root must contain exactly: ${expectedRootKeys.join(', ')}; received: ${actualRootKeys.join(', ')}`,
    )
  }

  if (fixture.source !== EXPECTED_SOURCE) {
    throw new Error(`prototype fixture source must equal "${EXPECTED_SOURCE}"`)
  }

  if (typeof fixture.areas !== 'object' || fixture.areas === null || Array.isArray(fixture.areas)) {
    throw new Error('prototype fixture areas must be an object')
  }

  const areas = fixture.areas as Record<string, unknown>
  const actualAreas = Object.keys(areas).sort()
  const expectedAreas = [...EXPECTED_AREAS].sort()
  if (JSON.stringify(actualAreas) !== JSON.stringify(expectedAreas)) {
    throw new Error(
      `prototype fixture areas must contain exactly: ${expectedAreas.join(', ')}; received: ${actualAreas.join(', ')}`,
    )
  }

  for (const area of EXPECTED_AREAS) {
    const actions = areas[area]
    if (
      !Array.isArray(actions)
      || actions.length === 0
      || actions.some((action) => typeof action !== 'string' || action.trim() === '')
    ) {
      throw new Error(`prototype fixture areas.${area} must be a non-empty string array`)
    }
  }

  assertExactActionInventory(
    'prototype fixture',
    REVIEWED_FIXTURE_ACTION_IDS,
    canonicalActionIds(areas as Record<PrototypeArea, string[]>),
  )
}

function loadPrototypeFixture(): PrototypeFixture {
  const fixture = JSON.parse(readFileSync(
    new URL('../../fixtures/v18-prototype-actions.json', import.meta.url),
    'utf8',
  )) as unknown
  assertValidPrototypeFixture(fixture)
  return fixture
}

function canonicalActionIds(areas: Readonly<Record<string, readonly string[]>>): string[] {
  return Object.entries(areas).flatMap(([area, actions]) => (
    actions.map((action) => `${area}.${action}`)
  ))
}

function duplicateActionIds(actionIds: readonly string[]): string[] {
  const counts = new Map<string, number>()
  for (const actionId of actionIds) {
    counts.set(actionId, (counts.get(actionId) ?? 0) + 1)
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([actionId]) => actionId)
    .sort()
}

function actionInventoryDifference(
  required: readonly string[],
  implemented: readonly string[],
): { missing: string[]; extra: string[] } {
  const requiredIds = new Set(required)
  const implementedIds = new Set(implemented)

  return {
    missing: [...requiredIds].filter((actionId) => !implementedIds.has(actionId)).sort(),
    extra: [...implementedIds].filter((actionId) => !requiredIds.has(actionId)).sort(),
  }
}

function assertExactActionInventory(
  inventoryName: string,
  expected: readonly string[],
  actual: readonly string[],
): void {
  const { missing, extra } = actionInventoryDifference(expected, actual)
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${inventoryName} action IDs must match reviewed baseline; missing: ${missing.join(', ') || '(none)'}; extra: ${extra.join(', ') || '(none)'}`,
    )
  }
}

function createStructurallyValidFixture(): PrototypeFixture {
  return {
    source: EXPECTED_SOURCE,
    areas: {
      chatSessions: ['action'],
      shellCanvas: ['action'],
      globalChat: ['action'],
      settings: ['action'],
      ssh: ['action'],
    },
  }
}

describe('V18 prototype coverage', () => {
  it('keeps the checked-in fixture structurally healthy and fixed at 5 areas and 30 actions', () => {
    const fixture = loadPrototypeFixture()

    expect(fixture.source).toBe(EXPECTED_SOURCE)
    expect(Object.keys(fixture.areas).sort()).toEqual([...EXPECTED_AREAS].sort())
    expect(Object.fromEntries(
      EXPECTED_AREAS.map((area) => [area, fixture.areas[area].length]),
    )).toEqual(EXPECTED_AREA_ACTION_COUNTS)
    expect(canonicalActionIds(fixture.areas)).toHaveLength(30)
  })

  it.each([
    {
      name: 'a non-object root',
      fixture: () => null,
      message: 'prototype fixture must be an object',
    },
    {
      name: 'the wrong source',
      fixture: () => ({ ...createStructurallyValidFixture(), source: 'other.html' }),
      message: `prototype fixture source must equal "${EXPECTED_SOURCE}"`,
    },
    {
      name: 'an extra root field',
      fixture: () => ({ ...createStructurallyValidFixture(), unexpected: true }),
      message: 'prototype fixture root must contain exactly:',
    },
    {
      name: 'a missing fixed area',
      fixture: () => {
        const fixture = createStructurallyValidFixture()
        Reflect.deleteProperty(fixture.areas, 'ssh')
        return fixture
      },
      message: 'prototype fixture areas must contain exactly:',
    },
    {
      name: 'an extra area',
      fixture: () => ({
        ...createStructurallyValidFixture(),
        areas: { ...createStructurallyValidFixture().areas, other: ['action'] },
      }),
      message: 'prototype fixture areas must contain exactly:',
    },
    {
      name: 'a non-array action value',
      fixture: () => ({
        ...createStructurallyValidFixture(),
        areas: { ...createStructurallyValidFixture().areas, ssh: 'password' },
      }),
      message: 'prototype fixture areas.ssh must be a non-empty string array',
    },
    {
      name: 'an empty action array',
      fixture: () => ({
        ...createStructurallyValidFixture(),
        areas: { ...createStructurallyValidFixture().areas, ssh: [] },
      }),
      message: 'prototype fixture areas.ssh must be a non-empty string array',
    },
    {
      name: 'a blank action value',
      fixture: () => ({
        ...createStructurallyValidFixture(),
        areas: { ...createStructurallyValidFixture().areas, ssh: [' '] },
      }),
      message: 'prototype fixture areas.ssh must be a non-empty string array',
    },
  ])('rejects $name with a clear structural error', ({ fixture, message }) => {
    expect(() => assertValidPrototypeFixture(fixture())).toThrowError(message)
  })

  it('preserves area identity in canonical fixture action IDs', () => {
    expect(canonicalActionIds({ settings: ['shared'], ssh: ['shared'] })).toEqual([
      'settings.shared',
      'ssh.shared',
    ])
  })

  it.each([
    {
      name: 'reports a repeated canonical ID',
      actionIds: ['chatSessions.create', 'chatSessions.create'],
      expected: ['chatSessions.create'],
    },
    {
      name: 'does not merge equal action names from different areas',
      actionIds: ['settings.create', 'chatSessions.create'],
      expected: [],
    },
  ])('$name', ({ actionIds, expected }) => {
    expect(duplicateActionIds(actionIds)).toEqual(expected)
  })

  it('keeps fixture canonical action IDs unique and well formed', () => {
    const actionIds = canonicalActionIds(loadPrototypeFixture().areas)

    expect(duplicateActionIds(actionIds)).toEqual([])
    expect(actionIds.filter((actionId) => !CANONICAL_ACTION_ID.test(actionId))).toEqual([])
  })

  it('rejects a structurally valid fixture action rename', () => {
    const fixture = structuredClone(loadPrototypeFixture())
    fixture.areas.ssh[0] = 'connection-manager'

    expect(() => assertValidPrototypeFixture(fixture)).toThrowError(
      'prototype fixture action IDs must match reviewed baseline; missing: ssh.cmdb; extra: ssh.connection-manager',
    )
  })

  it('keeps implemented prototype action IDs unique and well formed', () => {
    const actionIds: readonly string[] = implementedPrototypeActions

    expect(duplicateActionIds(actionIds)).toEqual([])
    expect(actionIds.filter((actionId) => !CANONICAL_ACTION_ID.test(actionId))).toEqual([])
  })

  it('keeps the current production action inventory fixed at the reviewed baseline', () => {
    expect(() => assertExactActionInventory(
      'implemented prototype',
      REVIEWED_IMPLEMENTED_ACTION_IDS,
      implementedPrototypeActions,
    )).not.toThrow()
  })

  it.each([
    {
      name: 'a deleted action',
      actionIds: REVIEWED_IMPLEMENTED_ACTION_IDS.filter(actionId => actionId !== 'chatSessions.restore-live'),
      message: 'implemented prototype action IDs must match reviewed baseline; missing: chatSessions.restore-live; extra: (none)',
    },
    {
      name: 'an added action',
      actionIds: [...implementedPrototypeActions, 'chatSessions.rename'],
      message: 'implemented prototype action IDs must match reviewed baseline; missing: (none); extra: chatSessions.rename',
    },
    {
      name: 'an action moved to another area',
      actionIds: REVIEWED_IMPLEMENTED_ACTION_IDS.map(actionId => actionId === 'chatSessions.create' ? 'settings.create' : actionId),
      message: 'implemented prototype action IDs must match reviewed baseline; missing: chatSessions.create; extra: settings.create',
    },
  ])('rejects $name in the current production inventory', ({ actionIds, message }) => {
    expect(() => assertExactActionInventory(
      'implemented prototype',
      REVIEWED_IMPLEMENTED_ACTION_IDS,
      actionIds,
    )).toThrowError(message)
  })

  it.each([
    {
      name: 'missing IDs',
      required: ['ssh.password', 'ssh.private-key'],
      implemented: ['ssh.password'],
      expected: { missing: ['ssh.private-key'], extra: [] },
    },
    {
      name: 'extra IDs',
      required: ['ssh.password'],
      implemented: ['ssh.password', 'ssh.private-key'],
      expected: { missing: [], extra: ['ssh.private-key'] },
    },
    {
      name: 'missing and extra IDs',
      required: ['ssh.password', 'ssh.private-key'],
      implemented: ['settings.appearance', 'ssh.password'],
      expected: { missing: ['ssh.private-key'], extra: ['settings.appearance'] },
    },
  ])('reports full canonical $name', ({ required, implemented, expected }) => {
    expect(actionInventoryDifference(required, implemented)).toEqual(expected)
  })

  // Task 15 enables this final equality gate after all V18 behavior tests pass.
  it.skip('provides a production implementation for every confirmed V18 action', () => {
    const required = canonicalActionIds(loadPrototypeFixture().areas)

    expect(actionInventoryDifference(required, implementedPrototypeActions)).toEqual({
      missing: [],
      extra: [],
    })
  })
})
