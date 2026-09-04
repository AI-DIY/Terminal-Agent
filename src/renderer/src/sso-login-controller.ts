import type { SsoAuthState } from '../../shared/sso-contracts'

export type RootSurface = 'configuration' | 'login' | 'workbench'

export function resolveRootSurface(state: SsoAuthState): RootSurface {
  if (state === 'configuration-required') return 'configuration'
  if (state === 'login-required' || state === 'authenticating' || state === 'error') return 'login'
  return 'workbench'
}

export function canOpenSkills(state: SsoAuthState): boolean {
  return state === 'authenticated'
}

export function shouldRetryOnMount(state: SsoAuthState): boolean {
  return state === 'login-required'
}

export function loginStatusCopy(state: SsoAuthState): string {
  if (state === 'login-required') return '正在打开登录页'
  if (state === 'authenticating') return '正在安全获取用户信息'
  return ''
}

export function loginErrorCopy(message: string): string {
  if (/closed|window/i.test(message)) return '登录窗口已关闭'
  return `登录失败：${message.slice(0, 240)}`
}

export async function initializeSsoFailClosed(store: { initialize(): Promise<unknown> }, onReady: () => void): Promise<void> {
  try {
    await store.initialize()
  } catch {
    // The initial configuration-required state is the fail-closed fallback.
  } finally {
    onReady()
  }
}
