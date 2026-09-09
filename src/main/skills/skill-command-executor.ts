import { spawn, type ChildProcess } from 'node:child_process'
import { skillCommandRequestSchema, skillCommandResultSchema, type SkillCommandRequest, type SkillCommandResult, type SkillId } from '../../shared/skill-contracts'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_CAPTURE_BYTES = 1_000_000

export type SkillCommandExecutorOptions = {
  timeoutMs?: number
  maxOutputBytes?: number
  platform?: NodeJS.Platform
  spawnProcess?: typeof spawn
}

export type SkillCommandDirectoryResolver = (skillId: SkillId) => Promise<string> | string

type ActiveProcess = {
  child: ChildProcess
  resolve: (result: SkillCommandResult) => void
  reject: (error: unknown) => void
  stdout: string
  stderr: string
  timedOut: boolean
  cancelled: boolean
  timeout: ReturnType<typeof setTimeout>
  settled: boolean
}

/**
 * Executes only a command explicitly supplied by the model after a Skill has
 * been loaded.  Every child runs hidden, in the Skill directory, with bounded
 * output and a hard timeout.  No command is inferred from copied files.
 */
export class SkillCommandExecutor {
  private readonly active = new Map<string, ActiveProcess>()
  private readonly timeoutMs: number
  private readonly maxOutputBytes: number
  private readonly platform: NodeJS.Platform
  private readonly spawnProcess: typeof spawn

  constructor(
    private readonly resolveDirectory: SkillCommandDirectoryResolver,
    options: SkillCommandExecutorOptions = {},
  ) {
    this.timeoutMs = clampTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    this.maxOutputBytes = Math.max(1, Math.floor(options.maxOutputBytes ?? MAX_CAPTURE_BYTES))
    this.platform = options.platform ?? process.platform
    this.spawnProcess = options.spawnProcess ?? spawn
  }

  async run(input: SkillCommandRequest, signal?: AbortSignal): Promise<SkillCommandResult> {
    const request = skillCommandRequestSchema.parse(input)
    // Do not even spawn a process for a request cancelled before it reaches
    // the executor. This closes the small race between the chat controller's
    // abort and command creation while preserving the same result shape used
    // for an in-flight cancellation.
    if (signal?.aborted) {
      return skillCommandResultSchema.parse({
        id: request.id,
        invocationId: request.invocationId,
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        cancelled: true,
      })
    }
    if (this.active.has(request.invocationId)) throw new Error(`Skill invocation already running: ${request.invocationId}`)
    const cwd = await this.resolveDirectory(request.id)
    const timeoutMs = clampTimeout(request.timeoutMs ?? this.timeoutMs)
    const useShellCommand = request.command !== undefined
    const command = useShellCommand ? normalizeInlineCommand(request.command!, this.platform) : request.executable!
    const args = useShellCommand ? [] : request.args ?? []

    return new Promise<SkillCommandResult>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = this.spawnProcess(command, args, {
          cwd,
          // Inline commands intentionally use the platform shell because
          // standard Skills often include pipes/redirects.  Structured
          // executable + args calls avoid a shell and therefore preserve
          // argument boundaries.
          shell: useShellCommand,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        reject(error)
        return
      }

      const active: ActiveProcess = {
        child,
        resolve,
        reject,
        stdout: '',
        stderr: '',
        timedOut: false,
        cancelled: false,
        timeout: setTimeout(() => {
          active.timedOut = true
          terminate(child)
        }, timeoutMs),
        settled: false,
      }
      this.active.set(request.invocationId, active)
      const append = (kind: 'stdout' | 'stderr', chunk: Buffer | string): void => {
        const value = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        const current = active[kind]
        if (current.length >= this.maxOutputBytes) return
        active[kind] = current + value.slice(0, this.maxOutputBytes - current.length)
      }
      child.stdout?.on('data', chunk => append('stdout', chunk))
      child.stderr?.on('data', chunk => append('stderr', chunk))
      child.once('error', error => {
        // `close` follows an `error` for normal spawn failures.  Keep the
        // diagnostic in stderr and let close publish one deterministic result.
        append('stderr', error instanceof Error ? error.message : String(error))
      })
      child.once('close', code => {
        if (active.settled) return
        active.settled = true
        clearTimeout(active.timeout)
        this.active.delete(request.invocationId)
        const result = skillCommandResultSchema.parse({
          id: request.id,
          invocationId: request.invocationId,
          exitCode: typeof code === 'number' ? code : null,
          stdout: active.stdout,
          stderr: active.stderr,
          timedOut: active.timedOut,
          cancelled: active.cancelled,
        })
        resolve(result)
      })

      if (signal) {
        if (signal.aborted) {
          active.cancelled = true
          terminate(child)
        } else {
          const onAbort = () => {
            active.cancelled = true
            terminate(child)
          }
          signal.addEventListener('abort', onAbort, { once: true })
          child.once('close', () => signal.removeEventListener('abort', onAbort))
        }
      }
    })
  }

  cancel(invocationId: string): boolean {
    const active = this.active.get(invocationId)
    if (!active) return false
    active.cancelled = true
    terminate(active.child)
    return true
  }

  cancelAll(): void {
    for (const active of this.active.values()) {
      active.cancelled = true
      terminate(active.child)
    }
  }

  isRunning(invocationId: string): boolean {
    return this.active.has(invocationId)
  }
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS
  return Math.min(10 * 60_000, Math.max(100, Math.floor(value)))
}

function normalizeInlineCommand(command: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return command
  // Windows PowerShell aliases `curl` to Invoke-WebRequest in interactive
  // sessions.  Child processes use cmd.exe, but normalising removes that
  // ambiguity and follows the Skill contract explicitly.
  return command.replace(/^(\s*)curl(?=\s|$)/i, '$1curl.exe')
}

function terminate(child: ChildProcess): void {
  try { child.kill() } catch { /* A process may have exited between timeout and kill. */ }
}
