import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const SSH_CONNECTION_LOG_FILE_NAME = 'ssh-connection.log'

export type SshConnectionDiagnosticFields = Record<string, string | number | boolean | undefined>

export type SshConnectionDiagnostics = {
  readonly logPath: string
  record(event: string, fields?: SshConnectionDiagnosticFields): void
}

type DiagnosticWriter = (path: string, line: string) => Promise<void>

/**
 * Keep SSH transport traces beside the packaged runtime so a tester can find
 * them without needing Electron's user-data directory. No caller may add
 * credentials or command content to these records.
 */
export function sshConnectionLogPath(executablePath: string): string {
  return join(dirname(executablePath), 'logs', SSH_CONNECTION_LOG_FILE_NAME)
}

export function createSshConnectionDiagnostics(
  executablePath = process.execPath,
  write: DiagnosticWriter = appendDiagnosticLine,
): SshConnectionDiagnostics {
  const logPath = sshConnectionLogPath(executablePath)
  let writeTail: Promise<void> = Promise.resolve()

  return {
    logPath,
    record(event, fields = {}) {
      const line = `${JSON.stringify({
        timestamp: new Date().toISOString(),
        source: 'ssh',
        event: sanitizeText(event),
        ...sanitizeFields(fields),
      })}\n`
      // Never delay a connection or transfer on diagnostics I/O. The tail
      // preserves line order when several SSH sessions emit at once.
      writeTail = writeTail
        .then(() => write(logPath, line), () => write(logPath, line))
        .catch(() => undefined)
    },
  }
}

export const noOpSshConnectionDiagnostics: SshConnectionDiagnostics = {
  logPath: '',
  record: () => undefined,
}

function sanitizeFields(fields: SshConnectionDiagnosticFields): SshConnectionDiagnosticFields {
  return Object.fromEntries(Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => [sanitizeText(name), typeof value === 'string' ? sanitizeText(value) : value]))
}

function sanitizeText(value: string): string {
  return value.replace(/[\r\n\t]/g, ' ').slice(0, 384)
}

async function appendDiagnosticLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, line, 'utf8')
}
