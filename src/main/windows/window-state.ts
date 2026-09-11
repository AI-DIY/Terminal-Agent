import { z } from 'zod'
import { AtomicJsonStore } from '../persistence/atomic-json-store'

/**
 * Persisted window presentation state.  The workbench already restores its
 * layout, so this store only covers what belongs to the OS window itself:
 * whether it was maximized/fullscreen, where it was, and the renderer zoom the
 * user selected.
 */
export const WINDOW_ZOOM_MIN = 0.5
export const WINDOW_ZOOM_MAX = 3

export const windowBoundsSchema = z.object({
  x: z.number().int().min(-32_000).max(32_000),
  y: z.number().int().min(-32_000).max(32_000),
  width: z.number().int().min(400).max(32_000),
  height: z.number().int().min(300).max(32_000),
}).strict()
export type WindowBounds = z.infer<typeof windowBoundsSchema>

export const windowStateSchema = z.object({
  version: z.literal(1),
  maximized: z.boolean(),
  fullScreen: z.boolean(),
  zoomFactor: z.number().min(WINDOW_ZOOM_MIN).max(WINDOW_ZOOM_MAX),
  bounds: windowBoundsSchema.optional(),
}).strict()
export type WindowState = z.infer<typeof windowStateSchema>

/** The subset the main window observes and writes. */
export type WindowStateSnapshot = Omit<WindowState, 'version'>

export function createDefaultWindowState(): WindowState {
  return { version: 1, maximized: false, fullScreen: false, zoomFactor: 1 }
}

export function clampZoomFactor(value: number): number {
  if (!Number.isFinite(value)) return 1
  // Keep one decimal: Electron accepts fractional factors and the UI only
  // needs coarse zoom steps.
  return Math.min(WINDOW_ZOOM_MAX, Math.max(WINDOW_ZOOM_MIN, Math.round(value * 10) / 10))
}

/**
 * Reject a remembered position when it can no longer be reached (for example
 * after a monitor was unplugged).  A width/height that overlaps a display is
 * enough to keep the window usable, so a partial intersection is accepted.
 */
export function isBoundsVisibleOnDisplays(
  bounds: WindowBounds,
  displays: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
): boolean {
  return displays.some(display => (
    bounds.x < display.x + display.width
    && bounds.x + bounds.width > display.x
    && bounds.y < display.y + display.height
    && bounds.y + bounds.height > display.y
  ))
}

export class WindowStateService {
  private readonly store: AtomicJsonStore<WindowState>

  constructor(filePath: string) {
    this.store = new AtomicJsonStore(filePath, windowStateSchema, createDefaultWindowState)
  }

  async load(): Promise<WindowState> {
    return this.store.load()
  }

  async save(snapshot: WindowStateSnapshot): Promise<WindowState> {
    return this.store.update(() => ({
      version: 1,
      maximized: snapshot.maximized,
      fullScreen: snapshot.fullScreen,
      zoomFactor: clampZoomFactor(snapshot.zoomFactor),
      ...(snapshot.bounds ? { bounds: snapshot.bounds } : {}),
    }))
  }
}
