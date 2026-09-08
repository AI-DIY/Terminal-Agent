<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import WorkbenchView from './views/WorkbenchView.vue'
import SettingsView from './views/SettingsView.vue'
import SkillsView from './views/SkillsView.vue'
import LoginView from './views/LoginView.vue'
import { getSsoStore } from './stores/sso'
import { initializeSsoFailClosed, resolveRootSurface } from './sso-login-controller'
import { clearWorkbenchNavigationHandoff, setWorkbenchNavigationHandoff } from './stores/workbench-navigation-handoff'
const settingsOpen = ref(false)
const skillsOpen = ref(false)
const ready = ref(false)
const sso = getSsoStore()
const authState = computed(() => sso.state.state)
const rootSurface = computed(() => resolveRootSurface(authState.value))

function openSettings(selectedChatId: string | null): void {
  if (rootSurface.value !== 'workbench') return
  setWorkbenchNavigationHandoff(selectedChatId)
  skillsOpen.value = false
  settingsOpen.value = true
}

function openSkills(selectedChatId: string | null): void {
  if (rootSurface.value !== 'workbench') return
  if (!sso.skillsAvailable.value) return
  setWorkbenchNavigationHandoff(selectedChatId)
  settingsOpen.value = false
  skillsOpen.value = true
}

function closeSettings(): void { settingsOpen.value = false }
function closeSkills(): void { skillsOpen.value = false }

onMounted(() => { void initializeSsoFailClosed(sso, () => { ready.value = true }) })

watch(rootSurface, surface => {
  if (surface !== 'workbench') clearWorkbenchNavigationHandoff()
}, { immediate: true })
</script>

<template>
  <div v-if="!ready" class="app-loading" aria-live="polite">正在加载</div>
  <SettingsView v-else-if="rootSurface === 'configuration'" initial-tab="sso" :lock-navigation="true" />
  <LoginView v-else-if="rootSurface === 'login'" />
  <template v-else-if="rootSurface === 'workbench'">
    <!-- Keep the authenticated workbench mounted while secondary surfaces are open.
         SSH panes own live xterm buffers, so replacing this component would lose
         the terminal's current output and scrollback on every settings visit. -->
    <WorkbenchView v-show="!settingsOpen && !skillsOpen" @show-settings="openSettings" @show-skills="openSkills" />
    <SettingsView v-if="settingsOpen" @close="closeSettings" />
    <SkillsView v-if="skillsOpen" @close="closeSkills" />
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
:root[data-theme="noble-purple"] {
  --chrome: #302044;
  --panel: #271a39;
  --surface: #1d132d;
  --surface-soft: #241735;
  --hover: #3a2751;
  --selected: #432d61;
  --text-strong: #f7f0ff;
  --text: #e4d9f1;
  --muted: #b9a9ca;
  --faint: #9582aa;
  --line: #4d3865;
  --line-soft: #39284f;
  --accent: #c092ff;
  --accent-soft: #3c2857;
  --focus: #d0aaff;
  --green: #83d5b1;
  --green-soft: #1d3a31;
  --amber: #edc875;
  --amber-soft: #453620;
  --amber-line: #735a2e;
  --red: #ff9da8;
  --terminal: #160e22;
  --terminal-head: #241735;
  --terminal-text: #eee7f7;
  color-scheme: dark;
}
:root[data-theme="imperial-gold"] {
  --chrome: #242019;
  --panel: #191714;
  --surface: #12110f;
  --surface-soft: #1d1a15;
  --hover: #2b261d;
  --selected: #39311e;
  --text-strong: #fff4d4;
  --text: #e6d7b8;
  --muted: #b6a57f;
  --faint: #8e7e5c;
  --line: #5d4d2c;
  --line-soft: #322a1d;
  --accent: #d8ae54;
  --accent-soft: #3c3019;
  --focus: #f2cf7a;
  --green: #81c99a;
  --green-soft: #1d3325;
  --amber: #e9c064;
  --amber-soft: #3d3018;
  --amber-line: #735b2f;
  --red: #ef998b;
  --terminal: #0d0c0a;
  --terminal-head: #211d16;
  --terminal-text: #f3e5c5;
  color-scheme: dark;
}
:root[data-theme="sakura-pink"] {
  --chrome: #f8dfe8;
  --panel: #fff0f4;
  --surface: #fff8fa;
  --surface-soft: #fff1f5;
  --hover: #fbe4ec;
  --selected: #f7d7e3;
  --text-strong: #4c2635;
  --text: #633d4b;
  --muted: #8d6573;
  --faint: #b08d99;
  --line: #e8c3cf;
  --line-soft: #f1dce3;
  --accent: #c85178;
  --accent-soft: #f7d8e4;
  --focus: #d9688e;
  --green: #36856a;
  --green-soft: #e0f1ea;
  --amber: #a36d1d;
  --amber-soft: #fff1d6;
  --amber-line: #e2bf7c;
  --red: #b54259;
  --terminal: #24151d;
  --terminal-head: #3b222e;
  --terminal-text: #f8eaf0;
  color-scheme: light;
}
*, *::before, *::after { box-sizing: border-box; letter-spacing: 0; }
html, body, #app { width: 100%; min-width: 0; height: 100%; margin: 0; overflow: hidden; }
body { background: #e7ebf0; color: var(--text); }
:root[data-theme="graphite"] body { background: #121416; }
:root[data-theme="noble-purple"] body { background: #120b1b; }
:root[data-theme="imperial-gold"] body { background: #0c0b09; }
:root[data-theme="sakura-pink"] body { background: #fff4f7; }
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
