<script setup lang="ts">
import { ArrowLeft, BrainCircuit, Bot, Braces, Database, Eye, Palette } from '@lucide/vue'
import { ref } from 'vue'
import ModelRoutingSettings from '../components/settings/ModelRoutingSettings.vue'
import ModelProfileManager from '../components/settings/ModelProfileManager.vue'
import RegexFenceRules from '../components/settings/RegexFenceRules.vue'
import AppearanceSettings from '../components/settings/AppearanceSettings.vue'
import HostMemorySettings from '../components/settings/HostMemorySettings.vue'
import { SETTINGS_TABS, type SettingsTabId } from './settings-tabs'

defineEmits<{ close: [] }>()
const tab = ref<SettingsTabId>('routing')
const tabIcons = { routing: BrainCircuit, llm: Bot, vlm: Eye, fence: Braces, memory: Database, appearance: Palette }
</script>

<template>
  <main class="settings">
    <header class="settings-top"><button type="button" class="back-button" @click="$emit('close')"><ArrowLeft :size="15" aria-hidden="true" /><span>返回工作台</span></button><h1>设置</h1></header>
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="设置面板">
        <button v-for="item in SETTINGS_TABS" :key="item.id" type="button" :class="{ active: tab === item.id }" :aria-current="tab === item.id ? 'page' : undefined" @click="tab = item.id"><component :is="tabIcons[item.id]" :size="15" aria-hidden="true" /><span>{{ item.label }}</span></button>
      </nav>
      <section class="settings-content">
        <ModelRoutingSettings v-if="tab === 'routing'" />
        <ModelProfileManager v-else-if="tab === 'llm'" kind="llm" />
        <ModelProfileManager v-else-if="tab === 'vlm'" kind="vlm" />
        <RegexFenceRules v-else-if="tab === 'fence'" />
        <HostMemorySettings v-else-if="tab === 'memory'" />
        <AppearanceSettings v-else />
      </section>
    </div>
  </main>
</template>

<style scoped>
.settings { display: grid; grid-template-rows: 56px minmax(0, 1fr); width: calc(100vw - 16px); min-width: 0; height: calc(100vh - 16px); min-height: 604px; margin: 8px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--line) 86%, var(--text)); border-radius: 8px; background: var(--surface); color: var(--text); box-shadow: 0 10px 30px rgb(35 44 55 / 12%), 0 1px 4px rgb(35 44 55 / 8%); }
:global(:root[data-theme="graphite"]) .settings { box-shadow: 0 12px 34px rgb(0 0 0 / 36%), 0 1px 4px rgb(0 0 0 / 30%); }
.settings-top { display: flex; align-items: center; gap: 12px; min-width: 0; padding: 0 16px; border-bottom: 1px solid var(--line); background: var(--chrome); }.settings-top h1 { margin: 0; color: var(--text-strong); font-size: 17px; font-weight: 700; }.back-button { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 9px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text); font-size: 11px; font-weight: 600; }.back-button:hover { border-color: var(--focus); background: var(--hover); color: var(--text-strong); }
.settings-layout { display: grid; grid-template-columns: 216px minmax(0, 1fr); min-width: 0; min-height: 0; }
.settings-nav { display: grid; align-content: start; gap: 3px; min-width: 0; padding: 14px 8px; overflow-y: auto; border-right: 1px solid var(--line); background: var(--panel); }.settings-nav button { display: flex; align-items: center; gap: 9px; width: 100%; height: 38px; padding: 0 10px; border: 0; border-radius: 5px; background: transparent; color: var(--text); font-size: 11px; font-weight: 550; text-align: left; }.settings-nav button svg { flex: 0 0 auto; color: var(--muted); }.settings-nav button:hover { background: var(--hover); color: var(--text-strong); }.settings-nav button.active { background: var(--selected); color: var(--text-strong); font-weight: 680; box-shadow: inset 3px 0 0 var(--accent); }.settings-nav button.active svg { color: var(--accent); }
.settings-content { min-width: 0; min-height: 0; overflow-y: auto; padding: 28px 34px 38px; background: var(--surface); }
.settings-content :deep(.settings-panel) { display: grid; gap: 12px; width: 100%; max-width: 1120px; padding: 0; overflow: visible; border: 0; border-radius: 0; background: transparent; }
.settings-content :deep(.settings-panel > h2),.settings-content :deep(.settings-panel header h2) { color: var(--text-strong); font-size: 19px; font-weight: 700; }
.settings-content :deep(input),.settings-content :deep(select),.settings-content :deep(textarea) { border-radius: 5px; }
.settings-content :deep(button) { border-radius: 5px; }
@media (max-width: 1060px) { .settings-layout { grid-template-columns: 190px minmax(0,1fr); }.settings-content { padding: 24px 26px 34px; } }
</style>
