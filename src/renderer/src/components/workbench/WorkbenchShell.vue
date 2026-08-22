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
        <div v-show="!layout.state.leftCollapsed" class="side-content"><slot name="sidebar" :collapse="() => toggleSidebar('left')" /></div>
        <button v-show="layout.state.leftCollapsed" type="button" class="restore-button" aria-label="展开聊天会话" title="展开聊天会话" @click="toggleSidebar('left')"><PanelLeftOpen :size="16" aria-hidden="true" /><span>展开聊天</span></button>
      </div>
      <div class="separator" role="separator" aria-label="调整聊天会话栏宽度" aria-orientation="vertical" aria-valuemin="210" aria-valuemax="360" :aria-valuenow="layout.state.leftWidth" tabindex="0" @pointerdown="startResize('left', $event)" @keydown="resizeWithKeyboard('left', $event)" />
      <section class="shell-region">
        <slot name="shell" />
      </section>
      <div class="separator" role="separator" aria-label="调整 AI 工作区宽度" aria-orientation="vertical" aria-valuemin="340" aria-valuemax="520" :aria-valuenow="layout.state.rightWidth" tabindex="0" @pointerdown="startResize('right', $event)" @keydown="resizeWithKeyboard('right', $event)" />
      <div class="side-region right-region">
        <div v-show="!layout.state.rightCollapsed" class="side-content"><slot name="agent" :collapse="() => toggleSidebar('right')" /></div>
        <button v-show="layout.state.rightCollapsed" type="button" class="restore-button" aria-label="展开 AI 聊天" title="展开 AI 聊天" @click="toggleSidebar('right')"><PanelRightOpen :size="16" aria-hidden="true" /><span>展开 AI</span></button>
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
  width: calc(100vw - 16px);
  min-width: 0;
  height: calc(100vh - 16px);
  min-height: 604px;
  margin: 8px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--line) 86%, var(--text));
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 10px 30px rgb(35 44 55 / 12%), 0 1px 4px rgb(35 44 55 / 8%);
  font-family: Inter, "Segoe UI", "Microsoft YaHei", sans-serif;
}
.workbench-shell.theme-graphite {
  color-scheme: dark;
  box-shadow: 0 12px 34px rgb(0 0 0 / 36%), 0 1px 4px rgb(0 0 0 / 30%);
}
.app-header { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 0 14px; border-bottom: 1px solid var(--line); background: var(--chrome); }
.brand { display: flex; align-items: center; gap: 9px; min-width: 176px; flex: 0 0 auto; }.brand strong { color: var(--text-strong); font-size: 13px; font-weight: 700; }.brand-mark { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 6px; background: var(--text-strong); color: var(--surface); font-size: 10px; font-weight: 800; }
.current-chat { min-width: 0; flex: 1; overflow: hidden; color: var(--muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.current-chat b { color: var(--text-strong); font-size: 11px; font-weight: 680; }
.current-chat span { margin-left: 9px; color: var(--faint); }
.app-header-actions { display: flex; align-items: center; gap: 6px; min-width: 0; }
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
  .current-chat span { display: none; }
}
</style>
