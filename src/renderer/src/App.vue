<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import WorkbenchView from './views/WorkbenchView.vue'
import SettingsView from './views/SettingsView.vue'
import SkillsView from './views/SkillsView.vue'
import LoginView from './views/LoginView.vue'
import { getSsoStore } from './stores/sso'
import { initializeSsoFailClosed, resolveRootSurface } from './sso-login-controller'
const settingsOpen = ref(false)
const skillsOpen = ref(false)
const ready = ref(false)
const sso = getSsoStore()
const authState = computed(() => sso.state.state)
const rootSurface = computed(() => resolveRootSurface(authState.value))

function openSettings(): void {
  skillsOpen.value = false
  settingsOpen.value = true
}

function openSkills(): void {
  if (!sso.skillsAvailable.value) return
  settingsOpen.value = false
  skillsOpen.value = true
}

function closeSettings(): void { settingsOpen.value = false }
function closeSkills(): void { skillsOpen.value = false }

onMounted(() => { void initializeSsoFailClosed(sso, () => { ready.value = true }) })
</script>

<template>
  <div v-if="!ready" class="app-loading" aria-live="polite">正在加载</div>
  <SettingsView v-else-if="rootSurface === 'configuration'" initial-tab="sso" :lock-navigation="true" />
  <LoginView v-else-if="rootSurface === 'login'" />
  <template v-else-if="rootSurface === 'workbench'">
    <SettingsView v-if="settingsOpen" @close="closeSettings" />
    <SkillsView v-else-if="skillsOpen" @close="closeSkills" />
    <WorkbenchView v-else @show-settings="openSettings" @show-skills="openSkills" />
  </template>
</template>

<style>
:root {
  --chrome: #f0f3f6;
  --panel: #f7f8fa;
  --surface: #ffffff;
  --surface-soft: #f5f7f9;
  --hover: #edf1f5;
  --selected: #e7effa;
  --text-strong: #1d242c;
  --text: #39424c;
  --muted: #68737f;
  --faint: #8d97a2;
  --line: #d9dfe6;
  --line-soft: #e8ecf1;
  --accent: #2f6fc4;
  --accent-soft: #dfeafa;
  --focus: #3d7dca;
  --green: #18794e;
  --green-soft: #e3f2ea;
  --amber: #8c5b12;
  --amber-soft: #fff5dc;
  --amber-line: #dec176;
  --red: #b0444b;
  --terminal: #151a20;
  --terminal-head: #20262d;
  --terminal-text: #d8dade;
  color-scheme: light;
  font-family: Inter, "Segoe UI", "Microsoft YaHei", sans-serif;
}
:root[data-theme="graphite"] {
  --chrome: #25292e;
  --panel: #202429;
  --surface: #191d21;
  --surface-soft: #1d2227;
  --hover: #2a3036;
  --selected: #2a3542;
  --text-strong: #f0f3f6;
  --text: #d5dae0;
  --muted: #a4adb7;
  --faint: #7d8792;
  --line: #394048;
  --line-soft: #2c3238;
  --accent: #75a7e6;
  --accent-soft: #26394e;
  --focus: #84b2ec;
  --green: #6fc69a;
  --green-soft: #1e392d;
  --amber: #e0b45e;
  --amber-soft: #3b3120;
  --amber-line: #6e5a32;
  --red: #ef8b91;
  --terminal: #11151a;
  --terminal-head: #20262d;
  --terminal-text: #d8dade;
  color-scheme: dark;
}
*, *::before, *::after { box-sizing: border-box; letter-spacing: 0; }
html, body, #app { width: 100%; min-width: 0; height: 100%; margin: 0; overflow: hidden; }
body { background: #e7ebf0; color: var(--text); }
:root[data-theme="graphite"] body { background: #121416; }
button, input, select, textarea { font: inherit; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .58; }
button:focus, input:focus, select:focus, textarea:focus { outline: none; }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, [tabindex]:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
* { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--muted) 58%, transparent) transparent; }
*::-webkit-scrollbar { width: 8px; height: 8px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 999px; background: color-mix(in srgb, var(--muted) 58%, transparent); background-clip: padding-box; }
</style>
