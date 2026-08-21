<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import type { ChatWorkspace } from '../../../../shared/contracts'
import { createGlobalChatStore } from '../../stores/global-chat'

const props = defineProps<{ chat: ChatWorkspace | null; readOnly?: boolean }>()
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
  <section class="global-chat-panel" aria-label="全局 AI 聊天">
    <header><strong>全局 AI</strong><span v-if="readOnly">只读历史</span><span v-else-if="running" role="status">生成中</span></header>
    <div class="messages" aria-live="polite">
      <article v-for="message in messages" :key="message.id" :class="['message', message.role]"><span>{{ message.content }}</span></article>
      <p v-if="!messages.length" class="empty">输入问题开始对话</p>
    </div>
    <p v-if="chatId && store.state.errors[chatId]" class="error" role="alert">{{ store.state.errors[chatId] }} <button v-if="retryable" type="button" @click="retry">重试</button></p>
    <footer><textarea :value="draft" :disabled="readOnly || !chatId" aria-label="聊天输入" @input="updateDraft" @keydown="onKeydown" /><button type="button" :disabled="readOnly || !chatId || !draft.trim()" @click="send">发送</button><button v-if="running" type="button" @click="cancel">取消</button></footer>
  </section>
</template>

<style scoped>
.global-chat-panel { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; min-height: 0; height: 100%; background: var(--surface); color: var(--text); }
header, footer { display: flex; align-items: center; gap: 8px; padding: 10px; border-bottom: 1px solid var(--line); } footer { border-top: 1px solid var(--line); border-bottom: 0; } header span, .empty { color: var(--muted); font-size: 11px; }
.messages { min-height: 0; overflow: auto; padding: 10px; } .message { margin: 0 0 8px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.5; } .message.user { color: var(--text-strong); } .message.assistant { color: var(--muted); }
textarea { flex: 1; min-height: 56px; resize: vertical; border: 1px solid var(--line); background: var(--surface-soft); color: var(--text); padding: 6px; font: inherit; } button { min-height: 30px; padding: 0 10px; border: 1px solid var(--line); background: var(--surface-soft); color: var(--text); }
.error { margin: 0; padding: 6px 10px; color: var(--red); font-size: 11px; }
</style>
