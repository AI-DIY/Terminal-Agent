<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { getLayoutPreferencesStore } from '../../stores/layout-preferences'
import type { WorkbenchLayoutPatch, WorkbenchTheme } from '../../../../shared/contracts'
const layout = getLayoutPreferencesStore()
const message = ref('')
onMounted(() => { void layout.load() })
async function saveTheme(theme: WorkbenchTheme): Promise<void> {
  try { await layout.saveTheme(theme); document.documentElement.dataset.theme = theme; message.value = '外观已保存' }
  catch (error) { message.value = error instanceof Error ? error.message : '外观保存失败' }
}
async function saveLayout(patch: WorkbenchLayoutPatch): Promise<void> {
  message.value = ''
  try { if (Object.keys(patch).length > 0) await layout.saveLayout(patch); message.value = '布局已保存' }
  catch (error) { message.value = error instanceof Error ? error.message : '布局保存失败' }
}
</script>
<template>
  <section class="settings-panel" aria-labelledby="appearance-title">
    <h2 id="appearance-title">外观</h2>
    <p>选择工作台主题并保存布局偏好。</p>
    <div class="theme-options"><button type="button" :class="{selected: layout.state.theme === 'pearl'}" @click="saveTheme('pearl')">珍珠白</button><button type="button" :class="{selected: layout.state.theme === 'graphite'}" @click="saveTheme('graphite')">石墨黑</button></div>
    <label>Shell 展示数量<select :value="layout.state.visibleCount" @change="saveLayout({ visibleCount: Number(($event.target as HTMLSelectElement).value) as 1|2|3|4 })"><option v-for="value in [1,2,3,4]" :key="value" :value="value">{{ value }}</option></select></label>
    <label>每行数量<select :value="layout.state.columns" @change="saveLayout({ columns: Number(($event.target as HTMLSelectElement).value) as 1|2|3|4 })"><option v-for="value in [1,2,3,4]" :key="value" :value="value">{{ value }}</option></select></label>
    <label>单行高度<select :value="layout.state.rowHeight" @change="saveLayout({ rowHeight: Number(($event.target as HTMLSelectElement).value) as 260|330|410 })"><option :value="260">260</option><option :value="330">330</option><option :value="410">410</option></select></label>
    <p v-if="message" role="status">{{ message }}</p><p v-if="layout.state.error" role="alert">{{ layout.state.error }}</p>
  </section>
</template>
<style scoped>
.settings-panel { display: grid; gap: 12px; max-width: 720px; }.settings-panel h2,.settings-panel p { margin: 0; }.settings-panel label { display: grid; gap: 5px; max-width: 280px; }.settings-panel select { min-height: 34px; padding: 4px 8px; }.theme-options { display: flex; gap: 10px; }.theme-options button { min-height: 42px; min-width: 120px; padding: 0 14px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: #28313b; }.theme-options button:last-child { background: #222a33; color: #f1f3f5; }.theme-options .selected { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
