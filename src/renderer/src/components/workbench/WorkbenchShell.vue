<script setup lang="ts">
import { PanelLeftOpen, PanelRightOpen } from '@lucide/vue'
import { computed, onBeforeUnmount } from 'vue'
import type { WorkbenchLayoutPatch } from '../../../../shared/contracts'
import {
  clampSidebarWidth,
  createDelayedLayoutSaver,
  getLayoutPreferencesStore,
  keyboardSidebarWidth,
} from '../../stores/layout-preferences'

const props = defineProps<{ modalOpen?: boolean; currentChatTitle: string; currentChatShellCount: number; currentVersion?: string; welcomeName?: string }>()
const welcomeName = computed(() => props.welcomeName?.trim() || '朋友')
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
      <div class="brand"><span class="brand-mark" aria-hidden="true">TA</span><strong>Terminal-Agent</strong><span class="app-version">v{{ currentVersion || '—' }}</span></div>
      <div class="current-chat"><span class="welcome-copy">欢迎回来，<b>{{ welcomeName }}</b></span><span class="welcome-divider" aria-hidden="true">·</span><span class="task-copy">当前任务&nbsp; / &nbsp;<b>{{ currentChatTitle }}</b><em>{{ currentChatShellCount }} 个 SSH</em></span></div>
      <div class="app-header-actions"><slot name="app-actions" /></div>
    </header>
    <section class="workspace" :inert="modalOpen || undefined" :aria-hidden="modalOpen ? 'true' : undefined">
      <div class="side-region left-region">
        <div v-show="!layout.state.leftCollapsed" class="side-content"><slot name="sidebar" :collapse="() => toggleSidebar('left')" /></div>
        <button v-show="layout.state.leftCollapsed" type="button" class="restore-button" aria-label="展开任务历史区" title="展开任务历史区" @click="toggleSidebar('left')"><PanelLeftOpen :size="16" aria-hidden="true" /><span>任务历史区</span></button>
      </div>
      <div class="separator" role="separator" aria-label="调整任务历史区宽度" aria-orientation="vertical" aria-valuemin="210" aria-valuemax="360" :aria-valuenow="layout.state.leftWidth" tabindex="0" @pointerdown="startResize('left', $event)" @keydown="resizeWithKeyboard('left', $event)" />
      <section class="shell-region">
        <slot name="shell" />
      </section>
      <div class="separator" role="separator" aria-label="调整 AI工作区宽度" aria-orientation="vertical" aria-valuemin="340" aria-valuemax="900" :aria-valuenow="layout.state.rightWidth" tabindex="0" @pointerdown="startResize('right', $event)" @keydown="resizeWithKeyboard('right', $event)" />
      <div class="side-region right-region">
        <div v-show="!layout.state.rightCollapsed" class="side-content"><slot name="agent" :collapse="() => toggleSidebar('right')" /></div>
        <button v-show="layout.state.rightCollapsed" type="button" class="restore-button" aria-label="展开 AI工作区" title="展开 AI工作区" @click="toggleSidebar('right')"><PanelRightOpen :size="16" aria-hidden="true" /><span>AI工作区</span></button>
      </div>
    </section>
    <slot name="overlays" />
  </main>
</template>

<style scoped>
.workbench-shell {
  position: relative;
  display: grid;
  grid-template-rows: 48px minmax(0, 1fr);
  --window-controls-inset: max(138px, calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 138px))));
  width: 100vw;
  min-width: 0;
  height: 100vh;
  min-height: 604px;
  margin: 0;
  overflow: hidden;
  border: 0;
  border-radius: 0;
  background: var(--surface);
  color: var(--text);
  box-shadow: none;
  font-family: Inter, "Segoe UI", "Microsoft YaHei", sans-serif;
}
.workbench-shell.theme-graphite {
  color-scheme: dark;
  box-shadow: none;
}
.app-header { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 0 calc(14px + var(--window-controls-inset)) 0 14px; border-bottom: 1px solid var(--line); background: var(--chrome); -webkit-app-region: drag; }
.brand { display: flex; align-items: center; gap: 9px; min-width: 176px; flex: 0 0 auto; }.brand strong { color: var(--text-strong); font-size: 13px; font-weight: 700; }.app-version { align-self: flex-end; margin: 0 0 8px -4px; color: var(--faint); font-size: 9px; font-weight: 600; letter-spacing: .02em; }.brand-mark { display: grid; place-items: center; box-sizing: border-box; width: 28px; height: 28px; border: 1px solid #535e6a; border-radius: 0; background: #1d242c; color: #fff; font-size: 10px; font-weight: 800; }
.current-chat { display: flex; align-items: center; min-width: 0; flex: 1; overflow: hidden; color: var(--muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.current-chat b { color: var(--text-strong); font-size: 11px; font-weight: 680; }
.current-chat > span { margin-left: 9px; color: var(--faint); }
.current-chat .welcome-copy { flex: 0 0 auto; margin-left: 0; color: var(--muted); }
.current-chat .welcome-copy b { color: var(--accent); font-size: 10px; }
.current-chat .welcome-divider { flex: 0 0 auto; color: var(--line); }
.current-chat > .welcome-copy + .welcome-divider { margin-left: 8px; }
.current-chat .task-copy { min-width: 0; overflow: hidden; margin-left: 0; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
.current-chat .task-copy em { margin-left: 9px; color: var(--faint); font-style: normal; }
.app-header-actions { display: flex; align-items: center; gap: 6px; min-width: 0; -webkit-app-region: no-drag; }
.app-header-actions :deep(*) { -webkit-app-region: no-drag; }
.workspace { display: grid; grid-template-columns: var(--left-width) 3px minmax(450px, 1fr) 3px var(--right-width); min-width: 0; min-height: 0; overflow: hidden; }
.side-region, .shell-region, .side-content, .shell-content { min-width: 0; min-height: 0; }
.side-region { position: relative; overflow: hidden; background: var(--panel); }
.right-region { background: var(--panel); }
.side-content { width: 100%; height: 100%; }
.separator { position: relative; z-index: 2; cursor: col-resize; background: var(--surface); touch-action: none; }
.separator::after { position: absolute; inset: 0 auto 0 1px; width: 1px; background: var(--line); content: ""; }
.separator:hover::after, .separator:focus::after { left: 0; width: 3px; background: var(--accent); }
.shell-region { min-width: 0; min-height: 0; overflow: hidden; background: var(--surface); }
.restore-button { display: flex; align-items: center; justify-content: flex-start; gap: 8px; width: 100%; height: 100%; padding: 12px 13px; border: 0; border-inline: 1px solid var(--line); background: var(--panel); color: var(--text-strong); writing-mode: vertical-rl; }
.restore-button span { font-size: 10px; font-weight: 680; }
@media (max-width: 1180px) {
  .workspace { grid-template-columns: min(var(--left-width), 210px) 3px minmax(430px, 1fr) 3px min(var(--right-width), 350px); }
}
@media (max-width: 1000px) {
  .workspace { grid-template-columns: min(var(--left-width), 170px) 3px minmax(320px, 1fr) 3px min(var(--right-width), 300px); }
  .brand { min-width: 150px; }
  /* Keep the new greeting visible in compact windows; only the verbose task
     summary needs to yield space to the header action buttons. */
  .current-chat .task-copy,.current-chat .welcome-divider { display: none; }
}
@media (max-width: 1080px) {
  .app-header-actions :deep(.header-button) { width: 30px; min-width: 30px; padding: 0; justify-content: center; }
  .app-header-actions :deep(.header-button span) { display: none; }
  .app-header-actions { gap: 4px; }
}
</style>
