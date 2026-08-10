/// <reference types="vite/client" />

interface Window {
  terminalAgent: import('../../preload/api').TerminalAgentApi
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}
