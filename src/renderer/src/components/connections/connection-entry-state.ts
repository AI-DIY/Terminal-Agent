import { isCompleteBastionTarget as isSharedCompleteBastionTarget } from '../../../../shared/contracts'

export type SshConnectionMode = 'cmdb' | 'bastionHost' | 'password' | 'privateKey'

export type ConnectionEntryState = {
  mode: SshConnectionMode
  host: string
  port: number
  username: string
  password: string
  passphrase: string
  keyReference: string | null
}

export function nextConnectionEntryState(state: ConnectionEntryState, mode: SshConnectionMode): ConnectionEntryState {
  return {
    ...state,
    mode,
    password: '',
    passphrase: '',
    keyReference: null,
  }
}

export function isCompleteBastionTarget(value: string): boolean {
  return isSharedCompleteBastionTarget(value)
}
