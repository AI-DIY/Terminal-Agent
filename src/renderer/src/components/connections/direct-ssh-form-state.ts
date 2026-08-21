import type { RendererSessionRequest } from '../../../../shared/contracts'

export type DirectSshFormInput =
  | {
      mode: 'password'
      host: string
      port: number
      username: string
      password: string
    }
  | {
      mode: 'privateKey'
      host: string
      port: number
      username: string
      keyReference: string | null
      passphrase: string
    }

export function toDirectConnectionRequest(input: DirectSshFormInput): RendererSessionRequest | { error: string } {
  const host = input.host.trim()
  const username = input.username.trim()
  if (!host || !username) return { error: '请填写主机地址和用户名。' }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) return { error: '请输入有效端口。' }

  const common = { host, port: input.port, username }
  if (input.mode === 'password') return { ...common, auth: { kind: 'password', password: input.password } }
  if (!input.keyReference) return { error: '请选择私钥文件。' }
  return {
    ...common,
    auth: {
      kind: 'privateKey',
      keyReference: input.keyReference,
      ...(input.passphrase ? { passphrase: input.passphrase } : {}),
    },
  }
}
