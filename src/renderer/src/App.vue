<script setup lang="ts">
import { ref } from 'vue'
import WorkbenchView from './views/WorkbenchView.vue'
import SettingsView from './views/SettingsView.vue'
const settingsOpen = ref(false)
</script>

<template><SettingsView v-show="settingsOpen" @close="settingsOpen=false"/><WorkbenchView v-show="!settingsOpen" @show-settings="settingsOpen=true" /></template>

<style>
:root { font-family: Inter, "Segoe UI", sans-serif; color-scheme: light; }
* { box-sizing: border-box; }
html, body, #app { width: 100%; min-width: 0; height: 100%; margin: 0; overflow: hidden; }
button, input, select, textarea { font: inherit; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; }
</style>
