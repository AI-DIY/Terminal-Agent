<script setup lang="ts">
import { ref } from 'vue'
import WorkbenchView from './views/WorkbenchView.vue'
import SettingsView from './views/SettingsView.vue'
const settingsOpen = ref(false)
</script>

<template><SettingsView v-if="settingsOpen" @close="settingsOpen=false"/><WorkbenchView v-else @show-settings="settingsOpen=true" /></template>
