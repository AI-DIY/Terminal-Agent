<script setup lang="ts">
import { Plus } from '@lucide/vue'
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
    <header class="settings-lead"><h2 :id="`${kind}-profiles-title`">{{ kind === 'llm' ? '大语言模型配置' : '视觉语言模型配置' }}</h2><p>{{ kind === 'llm' ? '维护文本理解、任务规划与 Shell 调度连接。大语言模型列表独立于视觉语言模型，当前同时只能激活一项。' : '维护截图和图像附件理解连接。视觉语言模型列表独立于大语言模型，当前同时只能激活一项。' }}</p></header>
    <div class="profile-layout">
      <section class="profile-list-pane">
        <div class="profile-list-head"><strong>{{ kind === 'llm' ? '大语言模型连接' : '视觉语言模型连接' }}</strong><button type="button" class="primary-button" @click="reset"><Plus :size="14" aria-hidden="true" /><span>新建连接</span></button></div>
        <nav class="profile-list" :aria-label="`${kind} 配置列表`">
          <p v-if="store.state.loading" class="list-empty">正在加载...</p><p v-else-if="profiles.length === 0" class="list-empty">暂无配置</p>
          <article v-for="profile in profiles" :key="profile.id" class="profile-item" :class="{ active: profile.active }">
            <button type="button" class="profile-select" @click="edit(profile)"><strong>{{ profile.name }}</strong><span>{{ profile.provider }} · {{ profile.model }}</span><small>{{ profile.hasApiKey ? '已配置密钥' : '未配置密钥' }}</small></button>
            <span class="activation-state" :class="{ active: profile.active }">{{ profile.active ? '已激活' : '未激活' }}</span>
            <div class="profile-actions"><button type="button" @click="edit(profile)">编辑</button><button type="button" :disabled="profile.active" @click="activate(profile.id)">{{ profile.active ? '已激活' : '激活' }}</button><button type="button" @click="importKey(profile.id)">导入密钥</button><select v-if="profile.active && profiles.length > 1" v-model="replacements[profile.id]" aria-label="删除时选择替代配置"><option value="">选择替代配置</option><template v-for="alternative in profiles" :key="alternative.id"><option v-if="alternative.id !== profile.id" :value="alternative.id">替代为 {{ alternative.name }}</option></template></select><button type="button" class="danger" @click="remove(profile)">删除</button></div>
          </article>
        </nav>
      </section>
      <form class="profile-editor" @submit.prevent="save">
        <div class="editor-head"><h3>{{ editingId ? `编辑${kind === 'llm' ? '大语言模型' : '视觉语言模型'}连接` : `新建${kind === 'llm' ? '大语言模型' : '视觉语言模型'}连接` }}</h3><span>新保存配置默认未激活</span></div>
        <label class="span-2">连接名称<input v-model="form.name" required maxlength="255"></label>
        <label>接口类型<select v-model="form.provider"><option value="ollama">Ollama</option><option value="openai">OpenAI / chat/completions</option><option value="llama-cpp">llama.cpp</option></select></label>
        <label>模型<input v-model="form.model" required maxlength="255"></label>
        <label class="span-2">接口地址<input v-model="form.endpoint" required type="url"></label>
        <label v-if="!isVlm">上下文长度<input v-model.number="form.contextLimit" required type="number" min="1024" max="1000000"></label>
        <label v-else>最大图像数<input v-model.number="form.maxImages" required type="number" min="1" max="128"></label>
        <label v-if="isVlm">LLM 密钥引用<select v-model="form.apiKeyProfileId"><option :value="undefined">不引用（使用本配置密钥）</option><option v-for="profile in llmProfiles" :key="profile.id" :value="profile.id">{{ profile.name }}</option></select></label>
        <label>API Key<input type="password" :placeholder="keyPlaceholder" readonly aria-describedby="api-key-note" /></label><p id="api-key-note" class="key-note span-2">密钥只通过主进程导入，绝不回填到页面或 renderer DTO。</p>
        <div class="form-actions span-2"><button type="button" :disabled="busy" @click="test">测试连接</button><button type="submit" class="primary-button" :disabled="busy">保存{{ kind === 'llm' ? '大语言模型' : '视觉语言模型' }}配置</button><button type="button" @click="reset">取消</button></div>
        <p v-if="message" class="form-message span-2" role="status">{{ message }}</p><p v-if="store.state.error" class="error span-2" role="alert">{{ store.state.error }}</p>
      </form>
    </div>
  </section>
</template>

<style scoped>
.profile-manager { display: grid; align-content: start; gap: 18px; min-width: 0; }.profile-manager h2,.profile-manager h3,.profile-manager p { margin: 0; }
.settings-lead { display: grid; gap: 6px; }.settings-lead h2 { color: var(--text-strong); font-size: 19px; }.settings-lead p { color: var(--muted); font-size: 11px; line-height: 1.6; }
.profile-layout { display: grid; grid-template-columns: minmax(260px,.9fr) minmax(380px,1.35fr); min-width: 0; }.profile-list-pane { min-width: 0; padding-right: 18px; }.profile-list-head,.editor-head,.profile-actions,.form-actions { display: flex; align-items: center; gap: 8px; }.profile-list-head { justify-content: space-between; min-height: 33px; margin-bottom: 9px; }.profile-list-head > strong { color: var(--text-strong); font-size: 11px; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 28px; padding: 0 9px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text); font-size: 10px; }button:hover:not(:disabled) { border-color: var(--focus); background: var(--hover); color: var(--text-strong); }button:disabled { opacity: .55; }.primary-button { border-color: var(--accent); background: var(--accent); color: #fff; font-weight: 650; }.primary-button:hover:not(:disabled) { background: color-mix(in srgb,var(--accent) 88%,#000); color: #fff; }.danger { color: var(--red); }
.profile-list { display: grid; align-content: start; gap: 7px; }.list-empty { padding: 18px 0; color: var(--muted); font-size: 11px; text-align: center; }.profile-item { position: relative; display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 7px; min-width: 0; padding: 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); }.profile-item.active { border-color: var(--accent); box-shadow: inset 2px 0 0 var(--accent); }.profile-select { display: grid; gap: 3px; min-width: 0; padding: 0; border: 0; background: transparent; text-align: left; }.profile-select:hover { border: 0; background: transparent; }.profile-select strong { overflow: hidden; color: var(--text-strong); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.profile-select span,.profile-select small { overflow: hidden; color: var(--muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.activation-state { align-self: start; color: var(--muted); font-size: 9px; }.activation-state.active { color: var(--green); }.profile-actions { grid-column: 1 / -1; justify-content: flex-end; flex-wrap: wrap; }.profile-actions select { height: 28px; max-width: 150px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface-soft); color: var(--text); font-size: 10px; }
.profile-editor { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); align-content: start; gap: 10px 16px; min-width: 0; padding-left: 18px; border-left: 1px solid var(--line); }.editor-head { grid-column: 1 / -1; min-height: 33px; }.editor-head h3 { color: var(--text-strong); font-size: 12px; }.editor-head span { color: var(--muted); font-size: 9px; }.profile-editor label { display: grid; gap: 5px; min-width: 0; color: var(--text-strong); font-size: 10px; font-weight: 650; }.profile-editor input,.profile-editor select { box-sizing: border-box; width: 100%; min-width: 0; height: 36px; padding: 0 9px; border: 1px solid var(--line); border-radius: 5px; outline: 0; background: var(--surface-soft); color: var(--text); font: 11px Inter,"Segoe UI",sans-serif; }.profile-editor input:focus,.profile-editor select:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }.profile-editor input[readonly] { color: var(--muted); }.span-2 { grid-column: 1 / -1; }.key-note { color: var(--green); font-size: 9px; line-height: 1.5; }.form-actions { flex-wrap: wrap; }.form-actions button { min-height: 32px; font-size: 11px; }.form-message { color: var(--accent); font-size: 10px; }.error { color: var(--red); font-size: 10px; }
@media (max-width: 900px) { .profile-layout { grid-template-columns: 1fr; gap: 18px; }.profile-list-pane { padding-right: 0; }.profile-editor { padding-left: 0; padding-top: 18px; border-top: 1px solid var(--line); border-left: 0; } }
@media (max-width: 600px) { .profile-editor { grid-template-columns: 1fr; }.span-2,.editor-head { grid-column: 1; } }
</style>
