import type { WorkbenchTheme } from '../../shared/contracts'

export type ThemeRoot = { dataset: { theme?: string } }

export function applyInitialTheme(root: ThemeRoot, theme: WorkbenchTheme): void {
  root.dataset.theme = theme
}
