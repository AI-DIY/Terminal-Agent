export type RenderGateRoot = { dataset: Record<string, string | undefined> }

export function createInitialRenderGate(root: RenderGateRoot) {
  let ready = false
  root.dataset.renderReady = 'false'

  return {
    release(): void {
      ready = true
      root.dataset.renderReady = 'true'
    },
    isReady(): boolean {
      return ready
    },
  }
}
