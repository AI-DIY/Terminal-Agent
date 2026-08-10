import { describe, expect, it } from 'vitest'
import { ConfirmationService } from '../../../src/main/agent/confirmation-service'

describe('ConfirmationService', () => {
  it('consumes a marker only for its exact command and session', () => {
    const service = new ConfirmationService(() => 'marker-1')
    const marker = service.issue('session-a', 'systemctl restart nginx')

    expect(service.consume('session-a', 'systemctl restart nginx', marker.id)).toBe(true)
    expect(service.consume('session-a', 'systemctl restart nginx', marker.id)).toBe(false)
  })

  it('rejects use against a changed command or another session', () => {
    const service = new ConfirmationService(() => 'marker-2')
    const marker = service.issue('session-a', 'systemctl restart nginx')

    expect(service.consume('session-a', 'systemctl stop nginx', marker.id)).toBe(false)
    expect(service.consume('session-b', 'systemctl restart nginx', marker.id)).toBe(false)
    expect(service.consume('session-a', 'systemctl restart nginx', marker.id)).toBe(true)
  })

  it('expires markers and removes every marker for a closed session', () => {
    let now = 1_000
    const service = new ConfirmationService(() => 'marker-3', () => now)
    const expiring = service.issue('session-a', 'id')
    now += 5 * 60 * 1_000 + 1
    expect(service.consume('session-a', 'id', expiring.id)).toBe(false)

    const retained = service.issue('session-a', 'uname -a')
    service.closeSession('session-a')
    expect(service.consume('session-a', 'uname -a', retained.id)).toBe(false)
  })
})
