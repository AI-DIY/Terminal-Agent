import { modelHostname } from './model-context'

/**
 * Connection metadata used to derive the identity that may be sent to the
 * model.  `hostname` is often a transport address (for example 127.0.0.1
 * when a bastion/Raw bridge is in use), so callers must not use it directly
 * without passing it through the resolver below.
 */
export type ModelShellTargetInput = {
  hostname?: string
  /** A non-address stable key (normally the live session id) used only to derive an opaque alias. */
  stableKey?: string
  /** A persisted association hostname used when the live endpoint only has a transport address. */
  fallbackHostname?: string
  observedHostname?: string
  /** A persisted observed value used when the live value is malformed. */
  fallbackObservedHostname?: string
  displayName?: string
  /** A persisted title used when the live title has no identity hint. */
  fallbackDisplayName?: string
}

/**
 * Resolve one model-safe target for every online Shell, preserving input
 * order.  Real/observed hostnames are preferred.  When an AccessClient title
 * contains an explicit `user@hostname` token, that DNS-like hostname is a
 * useful identity hint and is accepted after strict validation.  If no safe
 * identity is available, an opaque, non-address alias is generated.
 *
 * Opaque aliases are derived from a stable key when one is available and do
 * not expose that key directly.  Callers without a stable key get an
 * order-based fallback for backwards compatibility.  The execution path uses
 * this same function over the same candidate list, allowing a plan target to
 * be mapped back to its session without putting connection metadata in the
 * model request.
 */
export function resolveModelShellTargets(entries: readonly ModelShellTargetInput[]): string[] {
  const bases = entries.map(resolveModelShellBase)
  const used = new Set(bases.filter((value): value is string => Boolean(value)))
  let aliasOrdinal = 1
  return bases.map((base, index) => {
    if (base) return base
    let ordinal = aliasOrdinal
    let attempt = 0
    let alias = opaqueShellAlias(entries[index]?.stableKey, ordinal, attempt)
    while (used.has(alias)) {
      ordinal += 1
      attempt += 1
      alias = opaqueShellAlias(entries[index]?.stableKey, ordinal, attempt)
    }
    used.add(alias)
    aliasOrdinal = Math.max(aliasOrdinal + 1, ordinal + 1)
    return alias
  })
}

/**
 * Pick the same connection that the stable #1 presentation label represents
 * when a model-facing target is shared by multiple live Shells.  A plan's
 * target intentionally names a host rather than a session, so this keeps
 * execution deterministic without exposing session ids to the model.
 */
export function selectStableModelTargetIndex(
  target: string,
  modelTargets: readonly string[],
  stableKeys: readonly (string | undefined)[],
): number | undefined {
  let selected: number | undefined
  for (const [index, modelTarget] of modelTargets.entries()) {
    if (!sameModelShellTarget(modelTarget, target)) continue
    if (selected === undefined) {
      selected = index
      continue
    }
    const selectedKey = stableKeys[selected]?.trim() ?? ''
    const candidateKey = stableKeys[index]?.trim() ?? ''
    if (candidateKey.localeCompare(selectedKey) < 0 || (candidateKey === selectedKey && index < selected)) {
      selected = index
    }
  }
  return selected
}

/** Match stored/legacy targets without changing the value persisted in a plan. */
export function sameModelShellTarget(left: string | undefined, right: string | undefined): boolean {
  const normalize = (value: string | undefined): string | undefined => {
    const normalized = value?.trim().replace(/\.$/, '').toLowerCase()
    return normalized || undefined
  }
  const normalizedLeft = normalize(left)
  const normalizedRight = normalize(right)
  return normalizedLeft !== undefined && normalizedLeft === normalizedRight
}

function opaqueShellAlias(stableKey: string | undefined, ordinal: number, attempt: number): string {
  if (!stableKey?.trim()) return `online-shell-${ordinal}`
  const token = stableHash(attempt === 0 ? stableKey.trim() : `${stableKey.trim()}#${attempt}`)
  return `online-shell-${token}`
}

/** Small deterministic non-cryptographic digest; the value is only an opaque UI/model label. */
function stableHash(value: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ (code + index + 1), 0x85ebca6b)
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`
}

/** Resolve a single preferred identity before opaque alias allocation. */
export function resolveModelShellBase(entry: ModelShellTargetInput): string | undefined {
  return modelHostname(entry.observedHostname)
    ?? modelHostname(entry.fallbackObservedHostname)
    ?? modelHostname(entry.hostname)
    ?? modelHostname(entry.fallbackHostname)
    ?? modelHostnameFromTitle(entry.displayName)
    ?? modelHostnameFromTitle(entry.fallbackDisplayName)
}

/**
 * Extract only a strict DNS-like token following `@` in a title.  This is
 * deliberately narrower than `modelHostname`: arbitrary display text must not
 * become a model host identity merely because it happens to contain `@`.
 */
export function modelHostnameFromTitle(value: string | undefined): string | undefined {
  if (!value) return undefined
  const pattern = /(?:^|[\s("'`])[^@\s("'`]+@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)$/g
  let match: RegExpExecArray | null
  let candidate: string | undefined
  while ((match = pattern.exec(value)) !== null) candidate = match[1]
  if (!candidate) return undefined
  return modelHostname(candidate)
}
