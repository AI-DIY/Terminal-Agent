<script setup lang="ts">
import { ref } from 'vue'
import ModelRoutingSettings from '../components/settings/ModelRoutingSettings.vue'
import ModelProfileManager from '../components/settings/ModelProfileManager.vue'
import RegexFenceRules from '../components/settings/RegexFenceRules.vue'
import AppearanceSettings from '../components/settings/AppearanceSettings.vue'
import HostMemorySettings from '../components/settings/HostMemorySettings.vue'
import { SETTINGS_TABS, type SettingsTabId } from './settings-tabs'

defineEmits<{ close: [] }>()
const tab = ref<SettingsTabId>('routing')
</script>

<template>
  <main class="settings">
    <header><div><p class="eyebrow">工作台设置</p><h1>设置</h1></div><button type="button" @click="$emit('close')">返回工作台</button></header>
    <nav class="settings-nav" aria-label="设置面板">
      <button v-for="item in SETTINGS_TABS" :key="item.id" type="button" :class="{ active: tab === item.id }" :aria-current="tab === item.id ? 'page' : undefined" @click="tab = item.id">{{ item.label }}</button>
    </nav>
    <section class="settings-content">
      <ModelRoutingSettings v-if="tab === 'routing'" />
      <ModelProfileManager v-else-if="tab === 'llm'" kind="llm" />
      <ModelProfileManager v-else-if="tab === 'vlm'" kind="vlm" />
      <RegexFenceRules v-else-if="tab === 'fence'" />
      <HostMemorySettings v-else-if="tab === 'memory'" />
      <AppearanceSettings v-else />
    </section>
  </main>
</template>

<style scoped>
.settings { --surface: #fff; --surface-soft: #f5f7f9; --text-strong: #1d242c; --text: #39424c; --muted: #68737f; --line: #d9dfe6; --accent: #2f6fc4; --accent-soft: #dfeafa; --red: #b0444b; --green: #18794e; width: 100%; height: 100%; padding: 24px; overflow: auto; background: var(--surface); color: var(--text); }
:global(:root[data-theme="graphite"]) .settings { --surface: #22272e; --surface-soft: #292f36; --text-strong: #f2f4f6; --text: #d4d9df; --muted: #a8b0ba; --line: #414951; --accent: #6da7e8; --accent-soft: #27496d; --red: #e27b82; --green: #64c492; }
.settings > * { width: min(100%, 1080px); margin-right: auto; margin-left: auto; }
.settings header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.settings h1,.settings h2,.settings p { margin: 0; }.settings h1 { color: var(--text-strong); }.eyebrow { margin-bottom: 4px !important; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0; }
.settings button { min-height: 34px; padding: 0 10px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface-soft); color: var(--text); }.settings-nav { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 6px; margin-bottom: 20px; }.settings-nav button { min-height: 42px; font-size: 12px; }.settings-nav .active { border-color: var(--accent); color: var(--accent); font-weight: 700; }.settings-content { min-width: 0; }.settings-panel { display: grid; gap: 12px; padding: 16px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-soft); }
@media (max-width: 760px) { .settings { padding: 16px; }.settings-nav { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
