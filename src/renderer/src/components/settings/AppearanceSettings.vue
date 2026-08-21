<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { ShellRowHeightPercent, WorkbenchLayoutPatch, WorkbenchTheme } from '../../../../shared/contracts'
import { getLayoutPreferencesStore, SHELL_ROW_HEIGHT_PRESETS } from '../../stores/layout-preferences'

const layout = getLayoutPreferencesStore()
const message = ref('')

onMounted(() => { void layout.load() })

async function saveTheme(theme: WorkbenchTheme): Promise<void> {
  try {
    await layout.saveTheme(theme)
    document.documentElement.dataset.theme = theme
    message.value = '外观已保存'
  } catch (error) {
    message.value = error instanceof Error ? error.message : '外观保存失败'
  }
}

async function saveLayout(patch: WorkbenchLayoutPatch): Promise<void> {
  message.value = ''
  try {
    if (Object.keys(patch).length > 0) await layout.saveLayout(patch)
    message.value = '布局已保存'
  } catch (error) {
    message.value = error instanceof Error ? error.message : '布局保存失败'
  }
}

function selectedNumber(event: Event): number {
  return Number((event.target as HTMLSelectElement).value)
}
</script>

<template>
  <section class="settings-panel appearance" aria-labelledby="appearance-title">
    <header class="panel-head">
      <div>
        <h2 id="appearance-title">外观</h2>
        <p>主题和 Shell 布局会在工作台与历史回放中保持一致。</p>
      </div>
      <span class="save-state" role="status">{{ message }}</span>
    </header>

    <section class="settings-band" aria-labelledby="theme-title">
      <div class="section-copy"><h3 id="theme-title">工作台主题</h3><p>两个主题使用相同的信息层级和交互状态。</p></div>
      <div class="theme-options" role="group" aria-label="工作台主题">
        <button type="button" :class="{ selected: layout.state.theme === 'pearl' }" :aria-pressed="layout.state.theme === 'pearl'" @click="saveTheme('pearl')"><span class="theme-swatch pearl" aria-hidden="true"><i /><i /></span><span><strong>珍珠白</strong><small>明亮、清晰</small></span></button>
        <button type="button" :class="{ selected: layout.state.theme === 'graphite' }" :aria-pressed="layout.state.theme === 'graphite'" @click="saveTheme('graphite')"><span class="theme-swatch graphite" aria-hidden="true"><i /><i /></span><span><strong>石墨黑</strong><small>低光、专注</small></span></button>
      </div>
    </section>

    <section class="settings-band layout-band" aria-labelledby="layout-title">
      <div class="section-copy"><h3 id="layout-title">Shell 工作区布局</h3><p>以下设置与工作台“布局”菜单共用同一份偏好。</p></div>
      <div class="layout-fields">
        <label><span>Shell 展示数量</span><select :value="layout.state.visibleCount" @change="saveLayout({ visibleCount: selectedNumber($event) as 1|2|3|4 })"><option v-for="value in [1,2,3,4]" :key="value" :value="value">{{ value }} 个</option></select></label>
        <label><span>每行数量</span><select :value="layout.state.columns" @change="saveLayout({ columns: selectedNumber($event) as 1|2|3|4 })"><option v-for="value in [1,2,3,4]" :key="value" :value="value">{{ value }} 个</option></select></label>
        <label><span>单行高度（占工作区）</span><select :value="layout.state.rowHeightPercent" @change="saveLayout({ rowHeightPercent: selectedNumber($event) as ShellRowHeightPercent })"><option v-for="preset in SHELL_ROW_HEIGHT_PRESETS" :key="preset.value" :value="preset.value">{{ preset.label }} · {{ preset.value }}%</option></select></label>
      </div>
      <div class="layout-preview" aria-label="当前 Shell 布局摘要"><strong>{{ layout.state.visibleCount }} 个 Shell</strong><span>{{ layout.state.columns }} 列 · 单行 {{ layout.state.rowHeightPercent }}%</span></div>
    </section>

    <p v-if="layout.state.error" class="error" role="alert">{{ layout.state.error }}</p>
  </section>
</template>

<style scoped>
.appearance { display: grid; gap: 0; max-width: 860px; overflow: hidden; }
.appearance h2,.appearance h3,.appearance p { margin: 0; }
.panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 3px 2px 18px; }
.panel-head > div,.section-copy { display: grid; gap: 5px; }
.panel-head p,.section-copy p { color: var(--muted); font-size: 11px; line-height: 1.5; }
.save-state { min-width: 84px; color: var(--accent); font-size: 11px; text-align: right; }
.settings-band { display: grid; grid-template-columns: minmax(180px, .65fr) minmax(320px, 1.35fr); gap: 24px; padding: 20px 2px; border-top: 1px solid var(--line); }
.section-copy h3 { color: var(--text-strong); font-size: 13px; }
.theme-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.theme-options button { display: flex; align-items: center; gap: 11px; min-width: 0; min-height: 62px; padding: 8px 11px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--text); text-align: left; }
.theme-options button.selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.theme-options button > span:last-child { display: grid; gap: 3px; min-width: 0; }.theme-options strong { color: var(--text-strong); font-size: 11px; }.theme-options small { color: var(--muted); font-size: 10px; }
.theme-swatch { display: grid; grid-template-columns: 9px 1fr; flex: 0 0 42px; height: 34px; overflow: hidden; border: 1px solid #c7ced7; border-radius: 4px; background: #fff; }.theme-swatch i:first-child { background: #eef1f4; }.theme-swatch i:last-child { border-left: 1px solid #d9dfe6; background: #fff; }.theme-swatch.graphite { border-color: #4a535d; background: #22272e; }.theme-swatch.graphite i:first-child { background: #171a1e; }.theme-swatch.graphite i:last-child { border-left-color: #414951; background: #22272e; }
.layout-band { align-items: start; }.layout-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.layout-fields label { display: grid; gap: 6px; min-width: 0; color: var(--muted); font-size: 10px; }.layout-fields select { width: 100%; min-height: 34px; padding: 4px 8px; border: 1px solid var(--line); border-radius: 5px; outline: 0; background: var(--surface); color: var(--text); }.layout-fields select:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.layout-preview { grid-column: 2; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border-left: 3px solid var(--accent); background: var(--surface); }.layout-preview strong { color: var(--text-strong); font-size: 11px; }.layout-preview span { color: var(--muted); font-size: 10px; }
.error { padding-top: 12px; color: var(--red); font-size: 11px; }
@media (max-width: 760px) { .settings-band { grid-template-columns: 1fr; gap: 14px; }.layout-preview { grid-column: 1; }.layout-fields { grid-template-columns: 1fr; }.theme-options { grid-template-columns: 1fr; } }
</style>
