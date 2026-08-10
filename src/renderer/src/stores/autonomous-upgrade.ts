import { reactive } from 'vue'

export type AutonomousUpgradeState = {
  sessionId: string | null
  visible: boolean
}

export function createAutonomousUpgradeStore(): {
  state: AutonomousUpgradeState
  request(sessionId: string): void
  cancel(): void
  confirm(): string | null
} {
  const state = reactive<AutonomousUpgradeState>({ sessionId: null, visible: false })

  function clear(): void {
    state.sessionId = null
    state.visible = false
  }

  return {
    state,
    request(sessionId) {
      state.sessionId = sessionId
      state.visible = true
    },
    cancel: clear,
    confirm() {
      const sessionId = state.sessionId
      clear()
      return sessionId
    },
  }
}
