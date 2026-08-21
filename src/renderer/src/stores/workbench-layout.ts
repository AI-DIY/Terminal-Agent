import { ref } from 'vue'

export function clampSidebarWidth(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function createWorkbenchLayout() {
  const leftWidth = ref(230)
  const rightWidth = ref(400)
  const leftCollapsed = ref(false)
  const rightCollapsed = ref(false)
  const theme = ref<'light' | 'dark'>('light')

  return {
    leftWidth,
    rightWidth,
    leftCollapsed,
    rightCollapsed,
    theme,
    setLeftWidth(value: number): void { leftWidth.value = clampSidebarWidth(value, 210, 360) },
    setRightWidth(value: number): void { rightWidth.value = clampSidebarWidth(value, 340, 520) },
    toggleLeft(): void { leftCollapsed.value = !leftCollapsed.value },
    toggleRight(): void { rightCollapsed.value = !rightCollapsed.value },
  }
}
