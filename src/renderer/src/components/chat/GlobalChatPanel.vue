<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import type { ChatWorkspace } from '../../../../shared/contracts'
import { createGlobalChatStore } from '../../stores/global-chat'

const props = defineProps<{ chat: ChatWorkspace | null; readOnly?: boolean; canUpgrade?: boolean }>()
const emit = defineEmits<{ upgrade: [] }>()
const store = createGlobalChatStore(window.terminalAgent.chat)
const chatId = computed(() => props.chat?.id ?? '')
watch(() => props.chat, value => {
  if (value && !store.state.runs[value.id]) store.hydrate(value.id, value.messages, Boolean(props.readOnly))
}, { immediate: true })
const messages = computed(() => chatId.value ? store.state.messages[chatId.value] ?? [] : [])
const draft = computed(() => chatId.value ? store.draft(chatId.value) : '')
const running = computed(() => chatId.value ? Boolean(store.state.runs[chatId.value]) : false)
const retryable = computed(() => chatId.value ? store.canRetry(chatId.value) : false)
function updateDraft(event: Event): void { if (chatId.value) store.setDraft(chatId.value, (event.target as HTMLTextAreaElement).value) }
function send(): void { if (chatId.value) void store.send(chatId.value, draft.value) }
function retry(): void { if (chatId.value) void store.retry(chatId.value) }
function cancel(): void { if (chatId.value) void store.cancel(chatId.value).catch(() => undefined) }
function onKeydown(event: KeyboardEvent): void { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); send() } }
onBeforeUnmount(() => store.dispose())
</script>

<template>
  <section class="global-chat-panel" aria-label="AI 工作区">
    <header><div><span class="ai-mark" aria-hidden="true">AI</span><strong>AI 工作区</strong></div><span v-if="readOnly">只读历史</span><span v-else-if="running" role="status">生成中</span><button v-if="canUpgrade && !readOnly" type="button" class="upgrade-button" @click="emit('upgrade')">升级自动驾驶</button></header>
    <div class="messages" aria-live="polite">
      <article v-for="message in messages" :key="message.id" :class="['message', message.role]"><span>{{ message.content }}</span></article>
      <p v-if="!messages.length" class="empty">输入问题开始对话</p>
    </div>
    <p v-if="chatId && store.state.errors[chatId]" class="error" role="alert">{{ store.state.errors[chatId] }} <button v-if="retryable" type="button" @click="retry">重试</button></p>
    <footer><textarea :value="draft" :disabled="readOnly || !chatId" aria-label="聊天输入" @input="updateDraft" @keydown="onKeydown" /><button type="button" :disabled="readOnly || !chatId || !draft.trim()" @click="send">发送</button><button v-if="running" type="button" @click="cancel">取消</button></footer>
  </section>
</template>

<style scoped>
.global-chat-panel { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; width: 100%; min-width: 0; min-height: 0; height: 100%; overflow: hidden; background: var(--surface); color: var(--text); }
header, footer { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 10px; border-bottom: 1px solid var(--line); } footer { border-top: 1px solid var(--line); border-bottom: 0; } header > div { display: flex; align-items: center; gap: 8px; min-width: 0; } header > div strong { white-space: nowrap; } header > span { margin-left: auto; } header span, .empty { color: var(--muted); font-size: 11px; }.ai-mark { display: grid; flex: 0 0 auto; place-items: center; width: 26px; height: 26px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface-soft); color: var(--accent); font-size: 9px; font-weight: 800; }.upgrade-button { flex: 0 0 auto; margin-left: auto; border-color: var(--green); color: var(--green); font-weight: 650; white-space: nowrap; }
.messages { min-height: 0; overflow: auto; padding: 10px; } .message { margin: 0 0 8px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.5; } .message.user { color: var(--text-strong); } .message.assistant { color: var(--muted); }
textarea { flex: 1 1 0; width: 0; min-width: 0; min-height: 56px; resize: vertical; border: 1px solid var(--line); background: var(--surface-soft); color: var(--text); padding: 6px; font: inherit; } button { flex: 0 0 auto; min-height: 30px; padding: 0 10px; border: 1px solid var(--line); background: var(--surface-soft); color: var(--text); }
.error { margin: 0; padding: 6px 10px; color: var(--red); font-size: 11px; }
</style>
