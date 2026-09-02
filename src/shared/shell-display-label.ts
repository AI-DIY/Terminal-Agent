export type HostnameDisplayLabel = {
  displayLabel: string
  ordinal: number
}

export type HostnameDisplayEntry = {
  hostname: string
  displayName?: string
  observedHostname?: string
  /** Optional stable connection key used to keep duplicate ordinals steady while tabs are reordered. */
  stableKey?: string
}

/**
 * Resolve the comparison identity used by the SSH workspace's small host
 * ordinal badge.  A bastion can expose one relay address for several target
 * machines, so an observed remote hostname wins over the transport address.
 *
 * This is deliberately separate from `canonicalHostname`.  The latter is a
 * model/execution-plan contract and must continue to use the persisted route
 * when no observation is available.  The ordinal identity is only a UI
 * comparison key, so it is case-insensitive and may use a conservative host
 * hint from a connection title when the route is a loopback/relay address.
 */
export function sshHostIdentity(entry: HostnameDisplayEntry): string {
  const observed = entry.observedHostname?.trim()
  if (observed && !isIpLiteral(observed)) return observed.toLowerCase()
  const hostname = entry.hostname.trim()
  if (hostname && !isIpLiteral(hostname)) return hostname.toLowerCase()
  // AccessClient/Raw bridges commonly use loopback as their route.  If the
  // title contains an explicit host token (for example `appuser@web-01` or
  // `堡垒机_web-01`), use that token so different targets do not all receive
  // the same ordinal merely because they share the relay address.
  const titleHint = hostHintFromTitle(entry.displayName)
  if (titleHint) return titleHint.toLowerCase()
  return hostname.toLowerCase()
}

/** The name used to address a Shell in chat and execution plans. */
export function canonicalHostname(entry: HostnameDisplayEntry): string {
  return entry.observedHostname?.trim() || entry.hostname.trim()
}

/**
 * Labels for visible SSH tabs/cards.  Unlike the legacy model-facing label
 * helper below, this function counts by `sshHostIdentity`, keeping the #x
 * badge tied to the actual remote host when a bastion relay is shared.
 */
export function sshHostnameDisplayLabels(entries: readonly HostnameDisplayEntry[]): HostnameDisplayLabel[] {
  const identities = entries.map(sshHostIdentity)
  const totals = countValues(identities)
  const ordinals = stableOrdinals(entries, identities)
  return entries.map((entry, index) => {
    const identity = identities[index]!
    const ordinal = ordinals[index]!
    const displayName = entry.observedHostname?.trim() || entry.displayName?.trim() || entry.hostname.trim()
    return {
      displayLabel: totals.get(identity)! > 1 ? `${displayName} #${ordinal}` : displayName,
      ordinal,
    }
  })
}

/**
 * Derive ordinals from a stable connection key when one is available.  The
 * renderer supplies the session id, so dragging a tab changes presentation
 * order without changing which connection is #1.  Callers that do not have a
 * key (for example persisted model metadata) retain source-order semantics.
 */
function stableOrdinals(entries: readonly HostnameDisplayEntry[], identities: readonly string[]): number[] {
  const hasStableKeys = entries.some(entry => Boolean(entry.stableKey?.trim()))
  if (!hasStableKeys) {
    const counters = new Map<string, number>()
    return identities.map(identity => {
      const ordinal = (counters.get(identity) ?? 0) + 1
      counters.set(identity, ordinal)
      return ordinal
    })
  }

  const groups = new Map<string, number[]>()
  identities.forEach((identity, index) => {
    const group = groups.get(identity) ?? []
    group.push(index)
    groups.set(identity, group)
  })
  const result = Array.from({ length: entries.length }, () => 1)
  for (const indexes of groups.values()) {
    indexes.sort((left, right) => {
      const leftKey = entries[left]?.stableKey?.trim() ?? ''
      const rightKey = entries[right]?.stableKey?.trim() ?? ''
      return leftKey.localeCompare(rightKey) || left - right
    })
    indexes.forEach((index, ordinalIndex) => { result[index] = ordinalIndex + 1 })
  }
  return result
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

function hostHintFromTitle(value: string | undefined): string | undefined {
  const title = value?.trim()
  if (!title) return undefined

  // Prefer an explicit user@host token.  This mirrors the strict shape used
  // by model-shell-target without importing model-facing sanitisation into
  // the renderer's presentation helper.
  const atMatch = /(?:^|[^\w@.-])[^\s@]+@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)$/.exec(title)
  if (atMatch?.[1]) return atMatch[1]

  // Bastion labels in existing integrations often append the target after an
  // underscore.  Only accept a host-like suffix; ordinary titles such as
  // “生产终端” remain associated with the route address and retain legacy
  // duplicate behaviour.
  const suffix = title.split('_').at(-1)?.trim()
  if (suffix && (isHostLikeToken(suffix) || isIpLiteral(suffix))) return suffix

  // A plain DNS-like title is also useful when a provider labels the target
  // directly (for example `web-01.example.com`).  Avoid treating natural
  // language labels such as “primary” as host identities unless they contain
  // a separator or digit.
  if (isHostLikeToken(title) && /[.\d-]/.test(title)) return title
  return undefined
}

function isHostLikeToken(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/.test(value) && /[A-Za-z]/.test(value)
}

function isIpLiteral(value: string): boolean {
  const candidate = value.trim().replace(/^\[|\]$/g, '')
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidate)) {
    return candidate.split('.').every(part => Number(part) >= 0 && Number(part) <= 255)
  }
  // This deliberately accepts only hexadecimal/colon IPv6 forms; hostnames
  // containing a colon (for example a label) are not treated as addresses.
  return candidate.includes(':') && /^[0-9a-f:%]+$/i.test(candidate)
}
