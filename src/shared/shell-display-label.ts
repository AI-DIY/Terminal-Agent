export type HostnameDisplayLabel = {
  displayLabel: string
  ordinal: number
}

export type HostnameDisplayEntry = {
  hostname: string
  displayName?: string
  observedHostname?: string
}

/** The name used to address a Shell in chat and execution plans. */
export function canonicalHostname(entry: HostnameDisplayEntry): string {
  return entry.observedHostname?.trim() || entry.hostname.trim()
}

export function resolvedHostnames(entries: readonly HostnameDisplayEntry[]): string[] {
  const hostnames = entries.map(canonicalHostname)
  const totals = countValues(hostnames)
  const ordinals = new Map<string, number>()
  const bases = entries.map((entry, index) => {
    const hostname = hostnames[index]!
    const ordinal = (ordinals.get(hostname) ?? 0) + 1
    ordinals.set(hostname, ordinal)
    const title = normalizeTargetPart(entry.displayName)
    return {
      hostname,
      ordinal,
      base: (totals.get(hostname) ?? 0) > 1 && title ? title : normalizeTargetPart(hostname)!,
    }
  })
  const baseTotals = countValues(bases.map(item => item.base))
  const used = new Set<string>()
  return bases.map(item => {
    const uniqueCanonical = (totals.get(item.hostname) ?? 0) === 1 && item.base === normalizeTargetPart(item.hostname)
    const collidesWithAnotherBase = (baseTotals.get(item.base) ?? 0) > 1
    let value = uniqueCanonical ? item.base : collidesWithAnotherBase ? withOrdinal(item.base, item.ordinal) : item.base
    let ordinal = item.ordinal
    while (used.has(value)) value = withOrdinal(item.base, ++ordinal)
    used.add(value)
    return value
  })
}

export function hostnameDisplayLabels(entries: readonly HostnameDisplayEntry[]): HostnameDisplayLabel[] {
  const totals = new Map<string, number>()
  for (const entry of entries) {
    const hostname = canonicalHostname(entry)
    totals.set(hostname, (totals.get(hostname) ?? 0) + 1)
  }
  const ordinals = new Map<string, number>()
  return entries.map(entry => {
    const hostname = canonicalHostname(entry)
    const ordinal = (ordinals.get(hostname) ?? 0) + 1
    ordinals.set(hostname, ordinal)
    const displayName = entry.observedHostname?.trim() || entry.displayName?.trim() || hostname
    return {
      displayLabel: totals.get(hostname)! > 1 ? `${displayName} #${ordinal}` : displayName,
      ordinal,
    }
  })
}

function countValues(values: readonly string[]): Map<string, number> {
  const totals = new Map<string, number>()
  for (const value of values) totals.set(value, (totals.get(value) ?? 0) + 1)
  return totals
}

/** Plan targets must remain valid host-like tokens even when a connection title has spaces. */
function normalizeTargetPart(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, '-')
  return normalized ? normalized.slice(0, 255) : undefined
}

function withOrdinal(value: string, ordinal: number): string {
  const suffix = `#${ordinal}`
  return `${value.slice(0, Math.max(1, 255 - suffix.length))}${suffix}`
}
