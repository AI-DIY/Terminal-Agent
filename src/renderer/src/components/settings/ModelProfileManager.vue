<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import type { ModelProfileKind, RendererModelProfileInput } from '../../../../shared/validation'
import type { RendererModelProfile } from '../../../../shared/contracts'
import { createProfileDraft, getModelProfilesStore, profileDraftInput } from '../../stores/model-profiles'
import { createAsyncTestResultGuard } from './model-connection-test'

const props = defineProps<{ kind: ModelProfileKind }>()
const store = getModelProfilesStore()
const editingId = ref<string | null>(null)
const busy = ref(false)
const message = ref('')
const keyPlaceholder = ref('未配置密钥。请使用导入密钥。')
const llmProfiles = ref<RendererModelProfile[]>([])
const replacements = reactive<Record<string, string>>({})
const testGuard = createAsyncTestResultGuard()
const form = reactive<RendererModelProfileInput>({
  name: '', kind: props.kind, provider: 'ollama', model: '', endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: props.kind === 'llm' ? 12000 : undefined, maxImages: props.kind === 'vlm' ? 4 : undefined,
})
const profiles = computed(() => store.profilesForKind(props.kind))
const isVlm = computed(() => props.kind === 'vlm')
function reset(): void {
  editingId.value = null
  keyPlaceholder.value = '未配置密钥。请使用导入密钥。'
  setForm({ name: '', kind: props.kind, provider: 'ollama', model: '', endpoint: 'http://127.0.0.1:11434/api/chat', contextLimit: isVlm.value ? undefined : 12000, maxImages: isVlm.value ? 4 : undefined })
}
function setForm(input: RendererModelProfileInput): void {
  const target = form as unknown as Record<string, unknown>
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(form, input)
}
function edit(profile: RendererModelProfile): void {
  editingId.value = profile.id
  const draft = createProfileDraft(profile)
  keyPlaceholder.value = draft.apiKeyPlaceholder
  setForm(profileDraftInput(draft))
}
async function save(): Promise<void> {
  busy.value = true; message.value = ''
  try { await store.save({ ...form, ...(editingId.value ? { id: editingId.value } : {}) }); message.value = '配置已保存'; reset() }
  catch (error) { message.value = error instanceof Error ? error.message : '配置保存失败' }
  finally { busy.value = false }
}
async function test(): Promise<void> {
  busy.value = true; message.value = ''
  const input = { ...form, ...(editingId.value ? { id: editingId.value } : {}) }
  const request = testGuard.begin(JSON.stringify(input))
  try {
    const result = await store.test(input)
    if (testGuard.isCurrent(request, JSON.stringify({ ...form, ...(editingId.value ? { id: editingId.value } : {}) }))) message.value = `连接成功：${result.model}`
  }
  catch (error) {
    if (testGuard.isCurrent(request, JSON.stringify({ ...form, ...(editingId.value ? { id: editingId.value } : {}) }))) message.value = error instanceof Error ? error.message : '模型连接测试失败'
  }
  finally { if (testGuard.isLatest(request)) busy.value = false }
}
async function activate(id: string): Promise<void> { try { await store.activate(id); message.value = '配置已激活' } catch (error) { message.value = error instanceof Error ? error.message : '激活失败' } }
async function remove(profile: { id: string; active: boolean }): Promise<void> {
  const alternatives = profiles.value.filter(item => item.id !== profile.id)
  const replacementId = replacements[profile.id] || null
  const allowNoActive = profile.active && alternatives.length === 0
  if (profile.active && alternatives.length > 0 && !replacementId) { message.value = '请选择替代配置，或先激活其他配置。'; return }
  try {
    await store.remove(profile.id, profile.active ? (allowNoActive ? { allowNoActive: true } : { replacementId }) : undefined)
    message.value = '配置已删除'
  } catch (error) { message.value = error instanceof Error ? error.message : '删除失败' }
}
async function importKey(id: string): Promise<void> { try { await store.importApiKey(id); message.value = '密钥状态已更新' } catch (error) { message.value = error instanceof Error ? error.message : '密钥导入失败' } }
onMounted(async () => {
  await store.load(props.kind)
  if (props.kind === 'vlm') llmProfiles.value = await window.terminalAgent.settings.models.list('llm')
})
</script>

<template>
  <section class="profile-manager" :aria-labelledby="`${kind}-profiles-title`">
    <header><div><h2 :id="`${kind}-profiles-title`">{{ kind === 'llm' ? '大语言模型配置' : '视觉语言模型配置' }}</h2><p>配置保存在主进程；API Key 通过安全文件导入，不会进入页面数据。</p></div><button type="button" @click="reset">新建配置</button></header>
    <div class="profile-layout">
      <nav class="profile-list" :aria-label="`${kind} 配置列表`">
        <p v-if="store.state.loading">正在加载...</p><p v-else-if="profiles.length === 0">暂无配置</p>
        <article v-for="profile in profiles" :key="profile.id" class="profile-item" :class="{ active: profile.active }">
          <button type="button" class="profile-select" @click="edit(profile)"><strong>{{ profile.name }}</strong><span>{{ profile.provider }} · {{ profile.model }}</span><small>{{ profile.active ? '已激活' : '未激活' }} · {{ profile.hasApiKey ? '已配置密钥' : '未配置密钥' }}</small></button>
          <div class="profile-actions"><button type="button" :disabled="profile.active" @click="activate(profile.id)">激活</button><button type="button" @click="importKey(profile.id)">导入密钥</button><select v-if="profile.active && profiles.length > 1" v-model="replacements[profile.id]" aria-label="删除时选择替代配置"><option value="">选择替代配置</option><template v-for="alternative in profiles" :key="alternative.id"><option v-if="alternative.id !== profile.id" :value="alternative.id">替代为 {{ alternative.name }}</option></template></select><button type="button" @click="remove(profile)">删除</button></div>
        </article>
      </nav>
      <form class="profile-form" @submit.prevent="save">
        <h3>{{ editingId ? '编辑配置' : '新建配置' }}</h3>
        <label>名称<input v-model="form.name" required maxlength="255"></label>
        <label>供应商<select v-model="form.provider"><option value="ollama">Ollama</option><option value="openai">OpenAI</option><option value="llama-cpp">llama.cpp</option></select></label>
        <label>模型<input v-model="form.model" required maxlength="255"></label>
        <label>接口地址<input v-model="form.endpoint" required type="url"></label>
        <label v-if="!isVlm">上下文长度<input v-model.number="form.contextLimit" required type="number" min="1024" max="1000000"></label>
        <label v-else>最大图像数<input v-model.number="form.maxImages" required type="number" min="1" max="128"></label>
        <label v-if="isVlm">LLM 密钥引用<select v-model="form.apiKeyProfileId"><option :value="undefined">不引用（使用本配置密钥）</option><option v-for="profile in llmProfiles" :key="profile.id" :value="profile.id">{{ profile.name }}</option></select></label>
        <label>API Key<input type="password" :placeholder="keyPlaceholder" readonly aria-describedby="api-key-note" /></label><p id="api-key-note" class="key-note">密钥只通过主进程导入，绝不回填到页面或 renderer DTO。</p>
        <div class="form-actions"><button type="button" :disabled="busy" @click="test">测试连接</button><button type="submit" :disabled="busy">保存</button><button type="button" @click="reset">取消</button></div>
        <p v-if="message" role="status">{{ message }}</p><p v-if="store.state.error" role="alert">{{ store.state.error }}</p>
      </form>
    </div>
  </section>
</template>

<style scoped>
.profile-manager { display: grid; gap: 16px; }
.profile-manager header,.profile-item,.profile-actions,.form-actions { display: flex; align-items: center; gap: 8px; }
.profile-manager header { justify-content: space-between; }
.profile-manager h2,.profile-manager h3,.profile-manager p { margin: 0; }
.profile-layout { display: grid; grid-template-columns: minmax(220px, .8fr) minmax(260px, 1.2fr); gap: 16px; }
.profile-list { display: grid; align-content: start; gap: 8px; }
.profile-item { align-items: stretch; flex-direction: column; padding: 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-soft); }
.profile-item.active { border-color: var(--accent); }
.profile-select { display: grid; gap: 4px; min-width: 0; border: 0; background: none; text-align: left; }
.profile-select span,.profile-select small { color: var(--muted); font-size: 11px; }
.profile-actions button,.profile-manager header button,.form-actions button { min-height: 30px; padding: 0 9px; }
.profile-form { display: grid; gap: 10px; align-content: start; padding: 14px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-soft); }
.profile-form label { display: grid; gap: 5px; }
.profile-form input,.profile-form select { min-height: 34px; padding: 5px 8px; }
.key-note { color: var(--muted); font-size: 11px; }
@media (max-width: 760px) { .profile-layout { grid-template-columns: 1fr; } }
</style>
