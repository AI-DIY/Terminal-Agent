<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { getModelProfilesStore } from '../../stores/model-profiles'

const store = getModelProfilesStore()
const message = ref('')
onMounted(() => { void store.loadAll() })
async function save(): Promise<void> {
  message.value = ''
  try { await store.setRouting(store.state.routing); message.value = '路由已保存' }
  catch (error) { message.value = error instanceof Error ? error.message : '路由保存失败' }
}
</script>

<template>
  <section class="settings-panel model-routing" aria-labelledby="model-routing-title">
    <header class="settings-lead">
      <h2 id="model-routing-title">模型选择</h2>
      <p>选择全局 AI 的模型调用方式。该设置应用于聊天理解、任务规划、Shell 调度和图像处理，不随单个 Shell 切换。</p>
    </header>

    <fieldset class="model-routing-options">
      <legend>模型路由方式</legend>
      <label :class="{ selected: store.state.routing === 'combined' }">
        <input v-model="store.state.routing" type="radio" value="combined">
        <span>
          <strong>大语言模型 + 视觉语言模型</strong>
          <small>大语言模型负责聊天、规划和 Shell 调度；遇到截图或图像附件时调用视觉语言模型协同理解。</small>
        </span>
      </label>
      <label :class="{ selected: store.state.routing === 'vision-only' }">
        <input v-model="store.state.routing" type="radio" value="vision-only">
        <span>
          <strong>纯视觉语言模型</strong>
          <small>聊天、规划、Shell 调度和图像理解全部由视觉语言模型完成，不再调用独立的大语言模型。</small>
        </span>
      </label>
    </fieldset>

    <p class="routing-note"><strong>当前模式：</strong>{{ store.state.routing === 'combined' ? '大语言模型负责全局统筹，视觉语言模型仅在需要识图时参与。' : '视觉语言模型负责全部 AI 请求。' }}</p>
    <div class="settings-actions">
      <button type="button" class="primary-button" @click="save">保存模型选择</button>
      <span v-if="message" role="status">{{ message }}</span>
    </div>
    <p v-if="store.state.error" class="error" role="alert">{{ store.state.error }}</p>
  </section>
</template>

<style scoped>
.model-routing { display: grid; align-content: start; gap: 14px; max-width: 720px; }
.model-routing h2,.model-routing p { margin: 0; }
.settings-lead { display: grid; gap: 6px; }.settings-lead h2 { color: var(--text-strong); font-size: 19px; }.settings-lead p { color: var(--muted); font-size: 11px; line-height: 1.6; }
.model-routing-options { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; margin: 8px 0 0; padding: 0; border: 0; }.model-routing-options legend { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.model-routing-options label { display: grid; grid-template-columns: 18px minmax(0,1fr); align-content: start; gap: 9px; min-height: 112px; padding: 15px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); cursor: pointer; }.model-routing-options label:hover { border-color: var(--focus); }.model-routing-options label.selected { border-color: var(--accent); background: var(--selected); }
.model-routing-options input { width: 15px; height: 15px; margin: 2px 0 0; accent-color: var(--accent); }.model-routing-options span { display: grid; align-content: start; gap: 6px; }.model-routing-options strong { color: var(--text-strong); font-size: 12px; line-height: 1.35; }.model-routing-options small { color: var(--muted); font-size: 11px; line-height: 1.55; }
.routing-note { padding: 10px 12px; border-left: 2px solid var(--accent); background: var(--surface-soft); color: var(--muted); font-size: 11px; line-height: 1.6; }.routing-note strong { color: var(--text-strong); }
.settings-actions { display: flex; align-items: center; gap: 12px; }.settings-actions span { color: var(--accent); font-size: 11px; }.primary-button { min-height: 33px; padding: 0 13px; border: 1px solid var(--accent); border-radius: 5px; background: var(--accent); color: #fff; font-size: 11px; font-weight: 650; }.primary-button:hover { background: color-mix(in srgb,var(--accent) 88%,#000); }.error { color: var(--red); font-size: 11px; }
@media (max-width: 760px) { .model-routing-options { grid-template-columns: 1fr; } }
</style>
