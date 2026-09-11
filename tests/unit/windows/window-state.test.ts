import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clampZoomFactor,
  createDefaultWindowState,
  isBoundsVisibleOnDisplays,
  WINDOW_ZOOM_MAX,
  WINDOW_ZOOM_MIN,
  WindowStateService,
} from '../../../src/main/windows/window-state'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function createService(): Promise<{ service: WindowStateService; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'terminal-agent-window-state-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'window-state.json')
  return { service: new WindowStateService(path), path }
}

describe('window state', () => {
  it('defaults to a normal, unzoomed window', () => {
    expect(createDefaultWindowState()).toEqual({ version: 1, maximized: false, fullScreen: false, zoomFactor: 1 })
  })

  it('clamps zoom to the supported range and rounds to one decimal', () => {
    expect(clampZoomFactor(Number.NaN)).toBe(1)
    expect(clampZoomFactor(0.01)).toBe(WINDOW_ZOOM_MIN)
    expect(clampZoomFactor(9)).toBe(WINDOW_ZOOM_MAX)
    expect(clampZoomFactor(1.24)).toBe(1.2)
  })

  it('accepts a remembered rectangle that still overlaps a display', () => {
    const displays = [{ x: 0, y: 0, width: 1920, height: 1080 }]
    expect(isBoundsVisibleOnDisplays({ x: 100, y: 100, width: 1200, height: 800 }, displays)).toBe(true)
    // A monitor was unplugged: the remembered position is unreachable.
    expect(isBoundsVisibleOnDisplays({ x: 4000, y: 3000, width: 1200, height: 800 }, displays)).toBe(false)
    expect(isBoundsVisibleOnDisplays({ x: 100, y: 100, width: 1200, height: 800 }, [])).toBe(false)
  })

  it('round-trips the maximized, fullscreen, zoom, and bounds snapshot', async () => {
    const { service, path } = await createService()

    await service.save({
      maximized: true,
      fullScreen: false,
      zoomFactor: 1.3,
      bounds: { x: 40, y: 60, width: 1280, height: 900 },
    })

    await expect(service.load()).resolves.toEqual({
      version: 1,
      maximized: true,
      fullScreen: false,
      zoomFactor: 1.3,
      bounds: { x: 40, y: 60, width: 1280, height: 900 },
    })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ maximized: true, zoomFactor: 1.3 })
  })

  it('drops remembered geometry when a snapshot omits bounds', async () => {
    const { service } = await createService()

    await service.save({ maximized: false, fullScreen: false, zoomFactor: 1, bounds: { x: 10, y: 20, width: 1000, height: 700 } })
    await service.save({ maximized: true, fullScreen: false, zoomFactor: 2 })

    await expect(service.load()).resolves.toMatchObject({
      maximized: true,
      zoomFactor: 2,
    })
  })
})
