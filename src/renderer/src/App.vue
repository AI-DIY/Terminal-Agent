<script setup lang="ts">
import { ref } from 'vue'
import WorkbenchView from './views/WorkbenchView.vue'
import SettingsView from './views/SettingsView.vue'
const settingsOpen = ref(false)
</script>

<template><SettingsView v-show="settingsOpen" @close="settingsOpen=false"/><WorkbenchView v-show="!settingsOpen" @show-settings="settingsOpen=true" /></template>
