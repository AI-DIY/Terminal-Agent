<script setup lang="ts">
import { ArrowLeft, Bot, Braces, Database, KeyRound, Palette } from '@lucide/vue'
import { ref, watch } from 'vue'
import ModelProfileManager from '../components/settings/ModelProfileManager.vue'
import RegexFenceRules from '../components/settings/RegexFenceRules.vue'
import AppearanceSettings from '../components/settings/AppearanceSettings.vue'
import HostMemorySettings from '../components/settings/HostMemorySettings.vue'
import SsoSettings from '../components/settings/SsoSettings.vue'
import { SETTINGS_NAV_TABS, type SettingsTabId } from './settings-tabs'

const props = withDefaults(defineProps<{ initialTab?: SettingsTabId; lockNavigation?: boolean }>(), { lockNavigation: false })
const emit = defineEmits<{ close: [] }>()
const tab = ref<SettingsTabId>(props.lockNavigation ? 'sso' : normalizeTab(props.initialTab))
const tabIcons = { llm: Bot, fence: Braces, memory: Database, appearance: Palette, sso: KeyRound }
const modelProfileManager = ref<{ clearTransientKeyForSettingsClose(): void } | null>(null)

function closeSettings(): void {
  if (!props.lockNavigation) {
    modelProfileManager.value?.clearTransientKeyForSettingsClose()
    emit('close')
  }
}

watch([() => props.initialTab, () => props.lockNavigation], ([value, locked]) => { tab.value = locked ? 'sso' : normalizeTab(value) })

function normalizeTab(value: SettingsTabId | undefined): SettingsTabId {
  return value === 'routing' || value === 'vlm' || value === 'memory' || value === undefined ? 'llm' : value
}
</script>

<template>
  <main class="settings">
    <header class="settings-top"><button type="button" class="back-button" :disabled="lockNavigation" @click="closeSettings"><ArrowLeft :size="15" aria-hidden="true" /><span>返回工作台</span></button><h1>设置</h1></header>
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="设置面板">
        <button v-for="item in SETTINGS_NAV_TABS" :key="item.id" type="button" :disabled="lockNavigation" :class="{ active: tab === item.id }" :aria-current="tab === item.id ? 'page' : undefined" @click="tab = item.id"><component :is="tabIcons[item.id]" :size="15" aria-hidden="true" /><span>{{ item.label }}</span></button>
      </nav>
      <section class="settings-content">
        <ModelProfileManager v-if="tab === 'llm'" ref="modelProfileManager" kind="llm" />
        <RegexFenceRules v-else-if="tab === 'fence'" />
        <HostMemorySettings v-else-if="tab === 'memory'" />
        <AppearanceSettings v-else-if="tab === 'appearance'" />
        <SsoSettings v-else @continue="$emit('close')" @workbench="$emit('close')" />
      </section>
    </div>
  </main>
</template>

<style scoped>
.settings { display: grid; grid-template-rows: 56px minmax(0, 1fr); --window-controls-inset: max(138px, calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 138px)))); width: 100vw; min-width: 0; height: 100vh; min-height: 0; margin: 0; overflow: hidden; border: 0; border-radius: 0; background: var(--surface); color: var(--text); box-shadow: none; }
.settings-top { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 0 calc(16px + var(--window-controls-inset)) 0 16px; border-bottom: 1px solid var(--line); background: var(--chrome); -webkit-app-region: drag; }.settings-top h1 { margin: 0; color: var(--text-strong); font-size: 17px; font-weight: 700; }.back-button { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 9px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text); font-size: 11px; font-weight: 600; -webkit-app-region: no-drag; }.back-button:hover { border-color: var(--focus); background: var(--hover); color: var(--text-strong); }
.settings-layout { display: grid; grid-template-columns: 216px minmax(0, 1fr); min-width: 0; min-height: 0; }
.settings-nav { display: grid; align-content: start; gap: 3px; min-width: 0; padding: 14px 8px; overflow-y: auto; border-right: 1px solid var(--line); background: var(--panel); }.settings-nav button { display: flex; align-items: center; gap: 9px; width: 100%; height: 38px; padding: 0 10px; border: 0; border-radius: 5px; background: transparent; color: var(--text); font-size: 11px; font-weight: 550; text-align: left; }.settings-nav button svg { flex: 0 0 auto; color: var(--muted); }.settings-nav button:hover { background: var(--hover); color: var(--text-strong); }.settings-nav button.active { background: var(--selected); color: var(--text-strong); font-weight: 680; box-shadow: inset 3px 0 0 var(--accent); }.settings-nav button.active svg { color: var(--accent); }
.settings-content { min-width: 0; min-height: 0; overflow-y: auto; padding: 28px 34px 38px; background: var(--surface); }
.settings-content :deep(.settings-panel) { display: grid; gap: 12px; width: 100%; max-width: 1120px; padding: 0; overflow: visible; border: 0; border-radius: 0; background: transparent; }
.settings-content :deep(.settings-panel > h2),.settings-content :deep(.settings-panel header h2) { color: var(--text-strong); font-size: 19px; font-weight: 700; }
.settings-content :deep(input),.settings-content :deep(select),.settings-content :deep(textarea) { border-radius: 5px; }
.settings-content :deep(button) { border-radius: 5px; }
@media (max-width: 1060px) { .settings-layout { grid-template-columns: 190px minmax(0,1fr); }.settings-content { padding: 24px 26px 34px; } }
</style>
