<script setup lang="ts">
import { Bot, Circle, PanelRightClose, RefreshCw, Send, Square, UserRound } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ChatWorkspace } from '../../../../shared/contracts'
import { createGlobalChatStore } from '../../stores/global-chat'

const props = defineProps<{ chat: ChatWorkspace | null; readOnly?: boolean; canUpgrade?: boolean }>()
const emit = defineEmits<{ upgrade: []; collapse: [] }>()
const store = createGlobalChatStore(window.terminalAgent.chat)
const modelContextLimit = ref(12_000)
const chatId = computed(() => props.chat?.id ?? '')
watch(() => props.chat, value => {
  if (value && !store.state.runs[value.id]) store.hydrate(value.id, value.messages, Boolean(props.readOnly))
}, { immediate: true })
const messages = computed(() => chatId.value ? store.state.messages[chatId.value] ?? [] : [])
const draft = computed(() => chatId.value ? store.draft(chatId.value) : '')
const running = computed(() => chatId.value ? Boolean(store.state.runs[chatId.value]) : false)
const retryable = computed(() => chatId.value ? store.canRetry(chatId.value) : false)
const mode = computed(() => props.chat?.mode ?? 'copilot')
const contextUsed = computed(() => messages.value.reduce((total, message) => total + Math.ceil(message.content.length / 4) + 4, 0))
const contextPercent = computed(() => Math.min(100, Math.round((contextUsed.value / modelContextLimit.value) * 100)))
function updateDraft(event: Event): void { if (chatId.value) store.setDraft(chatId.value, (event.target as HTMLTextAreaElement).value) }
function send(): void { if (chatId.value) void store.send(chatId.value, draft.value) }
function retry(): void { if (chatId.value) void store.retry(chatId.value) }
function cancel(): void { if (chatId.value) void store.cancel(chatId.value).catch(() => undefined) }
function onKeydown(event: KeyboardEvent): void { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); send() } }
function formatTokens(value: number): string { return new Intl.NumberFormat('zh-CN').format(value) }
onMounted(() => {
  void window.terminalAgent.settings.getModel()
    .then(model => { if (model?.contextLimit) modelContextLimit.value = model.contextLimit })
    .catch(() => undefined)
})
onBeforeUnmount(() => store.dispose())
</script>

<template>
  <section class="global-chat-panel" aria-label="AI工作区">
    <header class="ai-head">
      <span class="ai-avatar" aria-hidden="true">AI</span>
      <div class="ai-head-copy"><h3>{{ readOnly ? 'AI工作区 · 历史' : 'AI工作区' }}</h3><span v-if="running" role="status">正在生成回复</span><span v-else>{{ readOnly ? '只读聊天与执行记录' : '当前任务的全局协作助手' }}</span></div>
      <button type="button" class="collapse-button" aria-label="收起 AI工作区" title="收起 AI工作区" @click="emit('collapse')"><span>收起</span><PanelRightClose :size="14" aria-hidden="true" /></button>
      <fieldset class="ai-mode-group" :disabled="readOnly">
        <legend>AI 执行模式</legend>
        <label class="ai-mode-option copilot" :class="{ selected: mode === 'copilot' }"><input type="radio" name="driving-mode" value="copilot" :checked="mode === 'copilot'" :disabled="mode === 'autonomous' || readOnly"><Circle :size="11" :stroke-width="mode === 'copilot' ? 4 : 1.5" aria-hidden="true" /><span>辅助驾驶</span></label>
        <label class="ai-mode-option autonomous" :class="{ selected: mode === 'autonomous' }"><input type="radio" name="driving-mode" value="autonomous" :checked="mode === 'autonomous'" :disabled="!canUpgrade || readOnly" @change="emit('upgrade')"><Circle :size="11" :stroke-width="mode === 'autonomous' ? 4 : 1.5" aria-hidden="true" /><span>全自动驾驶</span></label>
      </fieldset>
      <section class="context-meter" aria-label="AI 上下文用量">
        <div class="context-meter-head"><strong>上下文</strong><span>{{ formatTokens(contextUsed) }} / {{ formatTokens(modelContextLimit) }} tokens</span><b>{{ contextPercent }}%</b></div>
        <div class="context-progress" role="progressbar" aria-label="上下文使用比例" :aria-valuenow="contextPercent" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${contextPercent}%` }" /></div>
        <div class="context-meter-foot"><span>根据当前消息和模型上限估算</span></div>
      </section>
    </header>

    <div class="messages" aria-live="polite">
      <article v-for="message in messages" :key="message.id" :class="['message', message.role]">
        <span class="message-avatar" aria-hidden="true"><UserRound v-if="message.role === 'user'" :size="14" /><Bot v-else :size="14" /></span>
        <div class="message-content">
          <div class="message-meta"><strong>{{ message.role === 'user' ? '你' : 'Terminal-Agent' }}</strong><span v-if="message.state === 'streaming'">生成中</span><span v-else-if="message.state === 'error'">未完成</span></div>
          <p>{{ message.content }}</p>
        </div>
      </article>
      <section v-if="!messages.length" class="empty"><Bot :size="24" aria-hidden="true" /><strong>{{ readOnly ? '此聊天没有 AI 记录' : '开始协作' }}</strong><span>{{ readOnly ? 'Shell 历史仍可在中间工作区查看' : '输入目标，AI 会结合当前聊天中的 Shell 信息回答' }}</span></section>
      <p v-if="chatId && store.state.errors[chatId]" class="error" role="alert"><span>{{ store.state.errors[chatId] }}</span><button v-if="retryable" type="button" @click="retry"><RefreshCw :size="13" aria-hidden="true" />重试</button></p>
    </div>

    <footer class="composer">
      <div class="composer-shell">
        <textarea :value="draft" :disabled="readOnly || !chatId" aria-label="聊天输入" placeholder="告诉 AI 要完成什么；AI 会根据当前聊天判断所需信息和 Shell。" @input="updateDraft" @keydown="onKeydown" />
        <div class="composer-foot"><span>{{ readOnly ? '历史聊天只读' : `${chat?.shellCount ?? 0} 个关联 Shell` }}</span><button v-if="running" type="button" class="cancel-button" @click="cancel"><Square :size="12" fill="currentColor" aria-hidden="true" />取消</button><button type="button" class="send-button" :disabled="readOnly || !chatId || !draft.trim()" @click="send"><Send :size="13" aria-hidden="true" />发送</button></div>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.global-chat-panel { display: grid; grid-template-rows: 176px minmax(0, 1fr) auto; width: 100%; min-width: 0; min-height: 0; height: 100%; overflow: hidden; background: var(--panel); color: var(--text); }
.ai-head { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; grid-template-rows: auto auto auto; align-content: start; gap: 7px 9px; min-width: 0; min-height: 0; padding: 10px 11px; overflow: hidden; border-bottom: 1px solid var(--line); background: var(--surface); }
.ai-avatar { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 6px; background: var(--text-strong); color: var(--surface); font-size: 10px; font-weight: 800; }
.ai-head-copy { min-width: 0; }.ai-head-copy h3 { margin: 0; overflow: hidden; color: var(--text-strong); font-size: 15px; font-weight: 720; text-overflow: ellipsis; white-space: nowrap; }.ai-head-copy span { display: block; margin-top: 2px; overflow: hidden; color: var(--muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
.collapse-button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 30px; padding: 0 8px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text-strong); font-size: 10px; font-weight: 650; white-space: nowrap; }.collapse-button:hover { border-color: var(--focus); background: var(--hover); }
.ai-mode-group { grid-column: 1 / -1; display: flex; align-items: center; gap: 6px; min-width: 0; padding: 0; border: 0; }.ai-mode-group legend { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }.ai-mode-option { position: relative; display: flex; align-items: center; gap: 6px; min-height: 28px; padding: 5px 8px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--muted); font-size: 10px; font-weight: 650; cursor: pointer; }.ai-mode-option input { position: absolute; opacity: 0; pointer-events: none; }.ai-mode-option.copilot { color: var(--accent); }.ai-mode-option.autonomous { border-color: var(--amber-line); background: var(--amber-soft); color: var(--amber); }.ai-mode-option.selected { border-color: currentColor; box-shadow: inset 0 0 0 1px currentColor; }.ai-mode-option:has(input:disabled) { cursor: not-allowed; opacity: .62; }.ai-mode-option.selected:has(input:disabled) { opacity: 1; }
.context-meter { grid-column: 1 / -1; min-width: 0; padding-top: 7px; border-top: 1px solid var(--line-soft); }.context-meter-head { display: flex; align-items: baseline; gap: 6px; }.context-meter-head strong { color: var(--text-strong); font-size: 10px; }.context-meter-head span { color: var(--muted); font-size: 9px; font-variant-numeric: tabular-nums; }.context-meter-head b { margin-left: auto; color: var(--text-strong); font-size: 9px; }.context-progress { height: 5px; margin-top: 6px; overflow: hidden; border-radius: 3px; background: var(--line); }.context-progress span { display: block; height: 100%; border-radius: inherit; background: var(--accent); }.context-meter-foot { margin-top: 6px; color: var(--muted); font-size: 8.5px; }
.messages { min-width: 0; min-height: 0; overflow-x: hidden; overflow-y: auto; padding: 12px 12px 16px; scrollbar-gutter: stable; }
.message { display: grid; grid-template-columns: 29px minmax(0, 1fr); align-items: start; gap: 8px; min-width: 0; padding: 8px 0; }.message-avatar { display: grid; place-items: center; width: 29px; height: 29px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--muted); }.message.assistant .message-avatar { border-color: var(--text-strong); background: var(--text-strong); color: var(--surface); }.message-content { position: relative; min-width: 0; max-width: 100%; padding: 10px 11px 11px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); overflow-wrap: anywhere; }.message.assistant .message-content::before { position: absolute; top: 10px; bottom: 10px; left: -1px; width: 2px; border-radius: 0 2px 2px 0; background: var(--accent); content: ""; }.message.user { grid-template-columns: minmax(0, 1fr) 29px; padding-left: 38px; }.message.user .message-avatar { grid-column: 2; grid-row: 1; background: var(--panel); color: var(--text-strong); }.message.user .message-content { grid-column: 1; grid-row: 1; background: var(--surface-soft); }.message-meta { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; color: var(--faint); font-size: 9px; }.message-meta strong { color: var(--text-strong); font-size: 10px; }.message.assistant .message-meta strong { color: var(--accent); }.message-meta span { margin-left: auto; }.message p { margin: 0; color: var(--text); font-size: 11px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
.empty { display: grid; justify-items: center; gap: 6px; padding: 34px 18px; color: var(--muted); text-align: center; }.empty strong { color: var(--text-strong); font-size: 12px; }.empty span { max-width: 270px; font-size: 10px; line-height: 1.55; }
.error { display: flex; align-items: flex-start; gap: 8px; margin: 8px 0 0 37px; padding: 9px 10px; border-left: 2px solid var(--red); background: var(--surface); color: var(--red); font-size: 10px; line-height: 1.5; }.error span { min-width: 0; flex: 1; overflow-wrap: anywhere; }.error button { display: inline-flex; align-items: center; gap: 4px; min-height: 26px; padding: 0 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--text); }
.composer { min-width: 0; padding: 10px; border-top: 1px solid var(--line); background: var(--surface); }.composer-shell { overflow: hidden; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-soft); }.composer:focus-within .composer-shell { border-color: var(--focus); box-shadow: 0 0 0 2px var(--accent-soft); }.composer textarea { display: block; width: 100%; height: 64px; resize: none; padding: 10px 11px 7px; border: 0; background: transparent; color: var(--text-strong); font-size: 11px; line-height: 1.5; }.composer textarea::placeholder { color: var(--faint); }.composer-foot { display: flex; align-items: center; justify-content: flex-end; gap: 7px; min-height: 39px; padding: 6px 7px 7px 10px; border-top: 1px solid var(--line-soft); }.composer-foot > span { min-width: 0; margin-right: auto; overflow: hidden; color: var(--muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.composer-foot button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 29px; padding: 0 11px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text); font-size: 10px; font-weight: 650; }.composer-foot .send-button { border-color: var(--accent); background: var(--accent); color: #fff; }.composer-foot .cancel-button:hover { border-color: var(--red); color: var(--red); }
@media (max-width: 1180px) { .global-chat-panel { grid-template-rows: 176px minmax(0,1fr) auto; }.collapse-button span { display: none; }.collapse-button { width: 30px; padding: 0; }.ai-head-copy span { display: none; } }
</style>
