import { resolvedHostnames, sshHostnameDisplayLabels } from '../../../../shared/shell-display-label'
import { resolveModelShellTargets, sameModelShellTarget, selectStableModelTargetIndex } from '../../../../shared/model-shell-target'

export type PlanTargetShell = {
  sessionId?: string
  hostname: string
  observedHostname?: string
  title?: string
}

/**
 * Convert a model-facing plan target into the same stable, user-facing label
 * used by the SSH canvas.  A host target can describe several connections;
 * in that case it intentionally resolves to the stable #1 connection.
 */
export function planTargetLabelForShells(target: string, shells: readonly PlanTargetShell[]): string {
  const labels = sshHostnameDisplayLabels(shells.map(shell => ({
    hostname: shell.hostname,
    observedHostname: shell.observedHostname,
    displayName: shell.title,
    stableKey: shell.sessionId,
  })))
  const resolved = resolvedHostnames(shells.map(shell => ({
    hostname: shell.hostname,
    observedHostname: shell.observedHostname,
    displayName: shell.title,
  })))
  const modelTargets = resolveModelShellTargets(shells.map(shell => ({
    stableKey: shell.sessionId,
    hostname: shell.hostname,
    observedHostname: shell.observedHostname,
    displayName: shell.title,
  })))
  const stableModelIndex = selectStableModelTargetIndex(target, modelTargets, shells.map(shell => shell.sessionId))
  const index = stableModelIndex ?? shells.findIndex((shell, shellIndex) => [
    modelTargets[shellIndex], resolved[shellIndex], shell.observedHostname, shell.title, shell.hostname,
  ].some(identity => sameModelShellTarget(identity, target)))
  return index < 0 ? target : labels[index]?.displayLabel ?? target
}
