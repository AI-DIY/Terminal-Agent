<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import type { WorkbenchLayoutPatch } from '../../../../shared/contracts'
import {
  clampSidebarWidth,
  createDelayedLayoutSaver,
  getLayoutPreferencesStore,
  keyboardSidebarWidth,
} from '../../stores/layout-preferences'

defineProps<{ modalOpen?: boolean; currentChatTitle: string; currentChatShellCount: number }>()
const layout = getLayoutPreferencesStore()
const shellStyle = computed(() => ({
  '--left-width': layout.state.leftCollapsed ? '44px' : `${layout.state.leftWidth}px`,
  '--right-width': layout.state.rightCollapsed ? '48px' : `${layout.state.rightWidth}px`,
}))
function saveLayout(patch: WorkbenchLayoutPatch): void {
  void layout.saveLayout(patch).catch(() => undefined)
}

const widthSaver = createDelayedLayoutSaver(saveLayout)

function toggleSidebar(side: 'left' | 'right'): void {
  const field = side === 'left' ? 'leftCollapsed' : 'rightCollapsed'
  const patch = { [field]: !layout.state[field] } as WorkbenchLayoutPatch
  layout.previewLayout(patch)
  saveLayout(patch)
}

function resizeWithKeyboard(side: 'left' | 'right', event: KeyboardEvent): void {
  const field = side === 'left' ? 'leftWidth' : 'rightWidth'
  const width = keyboardSidebarWidth(side, layout.state[field], event.key)
  if (width === null) return
  event.preventDefault()
  const collapsedField = side === 'left' ? 'leftCollapsed' : 'rightCollapsed'
  if (layout.state[collapsedField]) {
    const expandedPatch = { [collapsedField]: false } as WorkbenchLayoutPatch
    layout.previewLayout(expandedPatch)
    saveLayout(expandedPatch)
  }
  const widthPatch = { [field]: width } as WorkbenchLayoutPatch
  layout.previewLayout(widthPatch)
  widthSaver.queue(widthPatch)
}

function startResize(side: 'left' | 'right', event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()
  const widthField = side === 'left' ? 'leftWidth' : 'rightWidth'
  const collapsedField = side === 'left' ? 'leftCollapsed' : 'rightCollapsed'
  const startX = event.clientX
  const startWidth = layout.state[widthField]
  const target = event.currentTarget as HTMLElement
  if (layout.state[collapsedField]) {
    layout.previewLayout({ [collapsedField]: false } as WorkbenchLayoutPatch)
    saveLayout({ [collapsedField]: false } as WorkbenchLayoutPatch)
  }
  target.setPointerCapture(event.pointerId)

  const move = (moveEvent: PointerEvent): void => {
    const pointerDelta = moveEvent.clientX - startX
    const width = clampSidebarWidth(side, startWidth + (side === 'left' ? pointerDelta : -pointerDelta))
    const patch = { [widthField]: width } as WorkbenchLayoutPatch
    layout.previewLayout(patch)
    widthSaver.queue(patch)
  }
  const end = (): void => {
    widthSaver.flush()
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
    target.removeEventListener('pointermove', move)
    target.removeEventListener('pointerup', end)
    target.removeEventListener('pointercancel', end)
  }
  target.addEventListener('pointermove', move)
  target.addEventListener('pointerup', end)
  target.addEventListener('pointercancel', end)
}

onBeforeUnmount(widthSaver.flush)
</script>

<template>
  <main class="workbench-shell" :class="`theme-${layout.state.theme}`" :style="shellStyle">
    <header class="app-header" :inert="modalOpen || undefined" :aria-hidden="modalOpen ? 'true' : undefined">
      <div class="brand"><span class="brand-mark" aria-hidden="true">TA</span><strong>Terminal-Agent</strong></div>
      <div class="current-chat">当前聊天&nbsp; / &nbsp;<b>{{ currentChatTitle }}</b><span>{{ currentChatShellCount }} 个 Shell</span></div>
      <div class="app-header-actions"><slot name="app-actions" /></div>
    </header>
    <section class="workspace" :inert="modalOpen || undefined" :aria-hidden="modalOpen ? 'true' : undefined">
      <div class="side-region left-region">
        <div v-show="!layout.state.leftCollapsed" class="side-content"><slot name="sidebar" /></div>
        <button v-show="layout.state.leftCollapsed" type="button" class="restore-button" aria-label="展开任务历史" title="展开任务历史" @click="toggleSidebar('left')"><span class="restore-icon" aria-hidden="true">→</span><span>任务历史</span></button>
      </div>
      <div class="separator" role="separator" aria-label="调整任务历史宽度" aria-orientation="vertical" aria-valuemin="210" aria-valuemax="360" :aria-valuenow="layout.state.leftWidth" tabindex="0" @pointerdown="startResize('left', $event)" @keydown="resizeWithKeyboard('left', $event)" />
      <section class="shell-region">
        <slot name="shell" />
      </section>
      <div class="separator" role="separator" aria-label="调整 AI 工作区宽度" aria-orientation="vertical" aria-valuemin="340" aria-valuemax="520" :aria-valuenow="layout.state.rightWidth" tabindex="0" @pointerdown="startResize('right', $event)" @keydown="resizeWithKeyboard('right', $event)" />
      <div class="side-region right-region">
        <div v-show="!layout.state.rightCollapsed" class="side-content"><slot name="agent" /></div>
        <button v-show="layout.state.rightCollapsed" type="button" class="restore-button" aria-label="展开 AI 工作区" title="展开 AI 工作区" @click="toggleSidebar('right')"><span class="restore-icon" aria-hidden="true">←</span><span>AI 工作区</span></button>
      </div>
    </section>
    <button v-if="!layout.state.leftCollapsed" type="button" class="collapse-button collapse-left" aria-label="收起任务历史" title="收起任务历史" @click="toggleSidebar('left')">‹</button>
    <button v-if="!layout.state.rightCollapsed" type="button" class="collapse-button collapse-right" aria-label="收起 AI 工作区" title="收起 AI 工作区" @click="toggleSidebar('right')">›</button>
    <slot name="overlays" />
  </main>
</template>

<style scoped>
.workbench-shell {
  --chrome: #f0f3f6; --panel: #f7f8fa; --surface: #fff; --surface-soft: #f5f7f9; --hover: #edf1f5; --selected: #e7effa;
  --text-strong: #1d242c; --text: #39424c; --muted: #68737f; --faint: #8d97a2; --line: #d9dfe6; --line-soft: #e8ecf1;
  --accent: #2f6fc4; --accent-soft: #dfeafa; --green: #18794e; --amber: #8c5b12; --red: #b0444b; --terminal: #151a20;
  position: relative; display: grid; grid-template-rows: 40px minmax(0, 1fr); width: 100%; height: 100vh; overflow: hidden; background: var(--surface); color: var(--text); font-family: Inter, "Segoe UI", sans-serif;
}
.workbench-shell.theme-graphite {
  --chrome: #171a1e; --panel: #1d2126; --surface: #22272e; --surface-soft: #292f36; --hover: #303740; --selected: #243b52;
  --text-strong: #f2f4f6; --text: #d4d9df; --muted: #a8b0ba; --faint: #7f8995; --line: #414951; --line-soft: #343b43;
  --accent: #6da7e8; --accent-soft: #27496d; --green: #64c492; --amber: #d5a75d; --red: #e27b82; --terminal: #101317;
  color-scheme: dark;
}
.app-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; padding: 0 12px; border-bottom: 1px solid var(--line); background: var(--chrome); }
.brand { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }.brand strong { color: var(--text-strong); font-size: 13px; }.brand-mark { display: grid; place-items: center; width: 26px; height: 26px; border: 1px solid color-mix(in srgb, var(--accent) 72%, var(--line)); border-radius: 5px; background: var(--accent); color: #fff; font-size: 10px; font-weight: 800; }
.current-chat { min-width: 0; flex: 1; overflow: hidden; color: var(--muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.current-chat b { color: var(--text-strong); font-weight: 650; }
.current-chat span { margin-left: 8px; color: var(--faint); }
.app-header-actions { display: flex; align-items: center; gap: 6px; min-width: 0; }
.workspace { display: grid; grid-template-columns: var(--left-width) 3px minmax(320px, 1fr) 3px var(--right-width); min-width: 0; min-height: 0; }
.side-region, .shell-region, .side-content, .shell-content { min-width: 0; min-height: 0; }
.side-region { position: relative; overflow: hidden; background: var(--panel); }
.right-region { border-left: 1px solid var(--line); background: var(--surface); }
.side-content { width: 100%; height: 100%; }
.separator { z-index: 2; cursor: col-resize; background: var(--line-soft); touch-action: none; }
.separator:hover, .separator:focus { outline: 0; background: var(--accent); }
.shell-region { min-width: 0; min-height: 0; overflow: hidden; background: var(--surface); }
.restore-button { display: flex; align-items: center; justify-content: flex-start; gap: 8px; width: 100%; height: 100%; padding: 10px 8px; border: 0; border-inline: 1px solid var(--line); background: var(--panel); color: var(--text-strong); writing-mode: vertical-rl; }
.restore-button span:not(.restore-icon) { font-size: 10px; font-weight: 680; }.restore-icon { color: var(--accent); font-size: 18px; font-weight: 750; writing-mode: horizontal-tb; }
.collapse-button { position: absolute; z-index: 3; top: 48px; width: 22px; height: 26px; padding: 0; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--muted); }
.collapse-left { left: calc(var(--left-width) - 13px); }
.collapse-right { right: calc(var(--right-width) - 13px); }
@media (max-width: 1060px) {
  .workspace { grid-template-columns: min(var(--left-width), 22vw) 3px minmax(320px, 1fr) 3px min(var(--right-width), 35vw); }
  .collapse-left { left: calc(min(var(--left-width), 22vw) - 13px); }
  .collapse-right { right: calc(min(var(--right-width), 35vw) - 13px); }
}
</style>
