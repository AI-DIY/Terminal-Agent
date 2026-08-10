export type AccessClientInvocation =
  | { kind: 'saved-session'; name: string }
  | { kind: 'temporary-session'; path: string; password?: string }
  | { kind: 'raw-port'; port: number }

export function parseAccessClientArgv(argv: readonly string[]): AccessClientInvocation {
  const args = argv.slice(1)
  if (args.length === 1 && args[0]?.startsWith('@')) {
    const name = args[0].slice(1).trim()
    if (name) return { kind: 'saved-session', name }
  }

  if (args[0] === '-load' && (args.length === 2 || (args.length === 4 && args[2] === '-pw'))) {
    const target = args[1]?.trim()
    const password = args.length === 4 ? args[3] : undefined
    if (!target || (args.length === 4 && !password)) throw unsupportedArguments()
    if (target.startsWith('tmp:')) {
      const path = target.slice(4)
      if (!path) throw unsupportedArguments()
      return { kind: 'temporary-session', path, ...(password ? { password } : {}) }
    }
    if (password) throw unsupportedArguments()
    return { kind: 'saved-session', name: target }
  }

  if (args.length === 3 && args[0] === '-raw' && args[1] === '-P') {
    try {
      return { kind: 'raw-port', port: parsePort(args[2]) }
    } catch {
      throw unsupportedArguments()
    }
  }

  throw unsupportedArguments()
}

export function parsePort(value: string | undefined): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid port')
  return port
}

function unsupportedArguments(): AccessClientLaunchFailure {
  return new AccessClientLaunchFailure('unsupported-launch-arguments')
}
import { AccessClientLaunchFailure } from './launch-failure'
