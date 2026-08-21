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
async function activate(kind: 'llm' | 'vlm', id: string): Promise<void> {
  try { await store.activate(id); message.value = `${kind === 'llm' ? '大语言模型' : '视觉语言模型'}已激活` }
  catch (error) { message.value = error instanceof Error ? error.message : '模型激活失败' }
}
</script>

<template>
  <section class="settings-panel" aria-labelledby="model-routing-title">
    <h2 id="model-routing-title">模型选择</h2>
    <p>分别选择大语言模型和视觉语言模型，再决定图像请求的路由方式。</p>
    <label>大语言模型
      <select :value="store.state.activeProfileIds.llm ?? ''" @change="activate('llm', ($event.target as HTMLSelectElement).value)">
        <option value="">没有可用配置</option>
        <option v-for="profile in store.state.profilesByKind.llm" :key="profile.id" :value="profile.id">{{ profile.name }}</option>
      </select>
    </label>
    <label>视觉语言模型
      <select :value="store.state.activeProfileIds.vlm ?? ''" @change="activate('vlm', ($event.target as HTMLSelectElement).value)">
        <option value="">没有可用配置</option>
        <option v-for="profile in store.state.profilesByKind.vlm" :key="profile.id" :value="profile.id">{{ profile.name }}</option>
      </select>
    </label>
    <label>路由模式
      <select v-model="store.state.routing">
        <option value="combined">组合模式：有图像时使用视觉模型</option>
        <option value="vision-only">纯视觉模式：始终使用视觉模型</option>
      </select>
    </label>
    <button type="button" @click="save">保存路由</button>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="store.state.error" role="alert">{{ store.state.error }}</p>
  </section>
</template>

<style scoped>
.settings-panel { display: grid; gap: 12px; max-width: 720px; }
.settings-panel h2,.settings-panel p { margin: 0; }
.settings-panel label { display: grid; gap: 6px; }
.settings-panel select { min-height: 36px; padding: 5px 8px; }
.settings-panel button { width: fit-content; min-height: 34px; padding: 0 12px; }
</style>
