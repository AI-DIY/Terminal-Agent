import { createHash, randomUUID } from 'node:crypto'

export type ConfirmationMarker = {
  id: string
}

type ConfirmationRecord = {
  sessionId: string
  commandHash: string
  expiresAt: number
}

export class ConfirmationService {
  private readonly records = new Map<string, ConfirmationRecord>()

  constructor(
    private readonly createId: () => string = randomUUID,
    private readonly now: () => number = Date.now,
  ) {}

  issue(sessionId: string, command: string): ConfirmationMarker {
    this.removeExpired()
    const id = this.createId()
    this.records.set(id, {
      sessionId,
      commandHash: hashCommand(command),
      expiresAt: this.now() + 5 * 60 * 1_000,
    })
    return { id }
  }

  consume(sessionId: string, command: string, markerId: string): boolean {
    const record = this.records.get(markerId)
    if (!record) return false
    if (record.expiresAt <= this.now()) {
      this.records.delete(markerId)
      return false
    }
    if (record.sessionId !== sessionId || record.commandHash !== hashCommand(command)) return false
    this.records.delete(markerId)
    return true
  }

  closeSession(sessionId: string): void {
    for (const [markerId, record] of this.records) {
      if (record.sessionId === sessionId) this.records.delete(markerId)
    }
  }

  private removeExpired(): void {
    for (const [markerId, record] of this.records) {
      if (record.expiresAt <= this.now()) this.records.delete(markerId)
    }
  }
}

function hashCommand(command: string): string {
  return createHash('sha256').update(command, 'utf8').digest('hex')
}
