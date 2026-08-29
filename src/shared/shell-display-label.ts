export type HostnameDisplayLabel = {
  displayLabel: string
  ordinal: number
}

export type HostnameDisplayEntry = {
  hostname: string
  displayName?: string
}

export function hostnameDisplayLabels(entries: readonly HostnameDisplayEntry[]): HostnameDisplayLabel[] {
  const totals = new Map<string, number>()
  for (const entry of entries) totals.set(entry.hostname, (totals.get(entry.hostname) ?? 0) + 1)
  const ordinals = new Map<string, number>()
  return entries.map(entry => {
    const ordinal = (ordinals.get(entry.hostname) ?? 0) + 1
    ordinals.set(entry.hostname, ordinal)
    const displayName = entry.displayName?.trim() || entry.hostname
    return {
      displayLabel: totals.get(entry.hostname)! > 1 ? `${displayName} #${ordinal}` : displayName,
      ordinal,
    }
  })
}
