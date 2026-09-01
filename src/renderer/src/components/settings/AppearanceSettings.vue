<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { ShellFontSize, ShellRowHeightPercent, WorkbenchLayoutPatch, WorkbenchTheme } from '../../../../shared/contracts'
import { getLayoutPreferencesStore, SHELL_FONT_SIZE_PRESETS, SHELL_ROW_HEIGHT_PRESETS } from '../../stores/layout-preferences'

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
        <p>选择工作台主题。布局、侧栏宽度和 Shell 展示方式会自动记忆。</p>
      </div>
      <span class="save-state" role="status">{{ message }}</span>
    </header>

    <section class="theme-band" aria-label="工作台主题">
      <div class="theme-options" role="group" aria-label="工作台主题">
        <button type="button" :class="{ selected: layout.state.theme === 'pearl' }" :aria-pressed="layout.state.theme === 'pearl'" @click="saveTheme('pearl')"><span class="theme-swatch pearl" aria-hidden="true"><i /><i /></span><span><strong>珍珠白</strong><small>接近 IDEA Light 的冷白层次</small></span></button>
        <button type="button" :class="{ selected: layout.state.theme === 'graphite' }" :aria-pressed="layout.state.theme === 'graphite'" @click="saveTheme('graphite')"><span class="theme-swatch graphite" aria-hidden="true"><i /><i /></span><span><strong>石墨黑</strong><small>接近 IDEA Darcula 的深灰层次</small></span></button>
      </div>
    </section>

    <section class="settings-band layout-band" aria-labelledby="layout-title">
      <div class="section-copy"><h3 id="layout-title">Shell 工作区布局</h3><p>以下设置与工作台“布局”菜单共用同一份偏好。</p></div>
      <div class="layout-fields">
        <label><span>Shell 展示数量</span><select :value="layout.state.visibleCount" @change="saveLayout({ visibleCount: selectedNumber($event) as 1|2|3|4 })"><option v-for="value in [1,2,3,4]" :key="value" :value="value">{{ value }} 个</option></select></label>
        <label><span>每行数量</span><select :value="layout.state.columns" @change="saveLayout({ columns: selectedNumber($event) as 1|2|3|4 })"><option v-for="value in [1,2,3,4]" :key="value" :value="value">{{ value }} 个</option></select></label>
        <label><span>Shell 字体大小</span><select :value="layout.state.fontSize" @change="saveLayout({ fontSize: selectedNumber($event) as ShellFontSize })"><option v-for="preset in SHELL_FONT_SIZE_PRESETS" :key="preset.value" :value="preset.value">{{ preset.label }} · {{ preset.value }}px</option></select></label>
        <label><span>单行高度（占工作区）</span><select :value="layout.state.rowHeightPercent" @change="saveLayout({ rowHeightPercent: selectedNumber($event) as ShellRowHeightPercent })"><option v-for="preset in SHELL_ROW_HEIGHT_PRESETS" :key="preset.value" :value="preset.value">{{ preset.label }} · {{ preset.value }}%</option></select></label>
      </div>
      <div class="layout-preview" aria-label="当前 Shell 布局摘要"><strong>{{ layout.state.visibleCount }} 个 Shell</strong><span>{{ layout.state.columns }} 列 · {{ layout.state.fontSize }}px · 单行 {{ layout.state.rowHeightPercent }}%</span></div>
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
.theme-band { padding: 8px 2px 20px; }.theme-options { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 14px; max-width: 640px; }
.theme-options button { display: grid; gap: 11px; min-width: 0; min-height: 174px; padding: 13px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--text); text-align: left; }.theme-options button:hover { border-color: var(--focus); }.theme-options button.selected { border-color: var(--accent); background: var(--selected); box-shadow: inset 0 0 0 1px var(--accent-soft); }
.theme-options button > span:last-child { display: grid; align-content: start; gap: 4px; min-width: 0; }.theme-options strong { color: var(--text-strong); font-size: 12px; }.theme-options small { color: var(--muted); font-size: 10px; }
.theme-swatch { position: relative; display: grid; grid-template-columns: 24% 1fr; width: 100%; height: 92px; overflow: hidden; border: 1px solid #d6dce4; border-radius: 5px; background: #f7f9fb; }.theme-swatch::before { content: ""; position: absolute; z-index: 2; top: 0; right: 0; left: 0; height: 14px; border-bottom: 1px solid #dce2e9; background: #eef2f6; }.theme-swatch::after { content: ""; position: absolute; z-index: 3; top: 30px; right: 18%; bottom: 13px; left: 30%; border: 1px solid #d5dce5; border-radius: 3px; background: #fff; box-shadow: inset 0 12px 0 #f2f5f8; }.theme-swatch i:first-child { border-right: 1px solid #dce2e9; background: #f0f3f6; }.theme-swatch i:last-child { background: #fff; }.theme-swatch.graphite { border-color: #414a54; background: #1d2228; }.theme-swatch.graphite::before { border-color: #3a424c; background: #242a31; }.theme-swatch.graphite::after { border-color: #414a54; background: #151a20; box-shadow: inset 0 12px 0 #252b32; }.theme-swatch.graphite i:first-child { border-color: #353d46; background: #171b20; }.theme-swatch.graphite i:last-child { background: #20252b; }
.layout-band { align-items: start; }.layout-fields { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.layout-fields label { display: grid; gap: 6px; min-width: 0; color: var(--muted); font-size: 10px; }.layout-fields select { width: 100%; min-height: 34px; padding: 4px 8px; border: 1px solid var(--line); border-radius: 5px; outline: 0; background: var(--surface); color: var(--text); }.layout-fields select:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.layout-preview { grid-column: 2; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border-left: 3px solid var(--accent); background: var(--surface); }.layout-preview strong { color: var(--text-strong); font-size: 11px; }.layout-preview span { color: var(--muted); font-size: 10px; }
.error { padding-top: 12px; color: var(--red); font-size: 11px; }
@media (max-width: 760px) { .settings-band { grid-template-columns: 1fr; gap: 14px; }.layout-preview { grid-column: 1; }.layout-fields { grid-template-columns: 1fr; }.theme-options { grid-template-columns: 1fr; } }
</style>
