import { createApp } from 'vue'
import App from './App.vue'
import { getLayoutPreferencesStore } from './stores/layout-preferences'
import { applyInitialTheme } from './theme'
import { createInitialRenderGate } from './render-gate'

async function bootstrap(): Promise<void> {
  const layout = getLayoutPreferencesStore()
  await layout.load().catch(() => undefined)
  applyInitialTheme(document.documentElement, layout.state.theme)
  const renderGate = createInitialRenderGate(document.documentElement)
  renderGate.release()
  createApp(App).mount('#app')
  await window.terminalAgent.settings.appearance.ready()
}

void bootstrap()
