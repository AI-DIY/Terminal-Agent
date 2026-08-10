import type { SavedDirectSessionInput } from '../../../shared/contracts'
import type { DirectSessionSummary } from '../../../main/ssh/direct-session-repository'

export type DirectSessionProfileForm = {
  id: string
  name: string
  host: string
  port: number
  username: string
  authKind: 'password' | 'privateKey'
  privateKeyPath?: string
}

export function formFromSavedProfile(profile: DirectSessionSummary): DirectSessionProfileForm {
  return {
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authKind: profile.authKind,
    privateKeyPath: profile.privateKeyPath,
  }
}

export function savedProfileFromForm(
  form: DirectSessionProfileForm,
  credentials: { password?: string; passphrase?: string } = {},
): SavedDirectSessionInput {
  const common = {
    id: form.id,
    name: form.name.trim(),
    host: form.host.trim(),
    port: form.port,
    username: form.username.trim(),
  }
  if (form.authKind === 'password') {
    return {
      ...common,
      auth: { kind: 'password', ...(credentials.password !== undefined ? { password: credentials.password } : {}) },
    }
  }
  if (!form.privateKeyPath?.trim()) throw new Error('请选择私钥文件。')
  return {
    ...common,
    auth: {
      kind: 'privateKey',
      privateKeyPath: form.privateKeyPath,
      ...(credentials.passphrase !== undefined ? { passphrase: credentials.passphrase } : {}),
    },
  }
}
