export type CandidateDisposition = 'pending' | 'autonomous-sent'

export function candidateState(value: { disposition: CandidateDisposition; confirmationId: string | null }): { label: string; canExecute: boolean } {
  if (value.disposition === 'autonomous-sent') return { label: '已由全自动驾驶发送', canExecute: false }
  return value.confirmationId ? { label: '已人工确认', canExecute: false } : { label: '待确认', canExecute: true }
}
