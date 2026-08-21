<script setup lang="ts">
import type { ChatSummary } from '../../../../shared/contracts'
import type { ChatGroup } from '../../stores/chat-workspaces'

defineProps<{
  groups: ChatGroup[]
  currentChatId: string | null
  loading: boolean
  error: string
}>()
const emit = defineEmits<{
  create: []
  select: [chatId: string]
  remove: [chatId: string]
}>()

function createdLabel(chat: ChatSummary): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(chat.createdAt))
}
</script>

<template>
  <aside class="session-sidebar" aria-label="任务历史">
    <header>
      <strong>任务历史</strong>
      <button type="button" aria-label="新建聊天" title="新建聊天" @click="emit('create')">＋</button>
    </header>
    <p v-if="error" class="status error" role="alert">{{ error }}</p>
    <p v-else-if="loading" class="status">正在读取聊天…</p>
    <nav v-else aria-label="聊天列表">
      <p v-if="!groups.length" class="empty">暂无聊天</p>
      <section v-for="group in groups" :key="group.label" class="chat-group" :aria-label="group.label">
        <h2>{{ group.label }}</h2>
        <div v-for="chat in group.chats" :key="chat.id" class="history-item" :class="{ active: chat.id === currentChatId }">
          <button type="button" class="chat-select" :aria-label="`选择聊天 ${chat.title}`" :aria-current="chat.id === currentChatId ? 'page' : undefined" @click="emit('select', chat.id)">
            <strong>{{ chat.title }}</strong>
            <span>{{ createdLabel(chat) }} 新建 <b>{{ chat.shellCount }} 个 Shell</b></span>
          </button>
          <button type="button" class="chat-remove" :aria-label="`删除聊天 ${chat.title}`" title="删除聊天" @click="emit('remove', chat.id)">×</button>
        </div>
      </section>
    </nav>
  </aside>
</template>

<style scoped>
.session-sidebar { display: grid; grid-template-rows: auto auto minmax(0, 1fr); min-width: 0; height: 100%; background: var(--panel); color: var(--text); }
header { display: flex; align-items: center; justify-content: space-between; min-height: 48px; padding: 0 11px; border-bottom: 1px solid var(--line); }
header strong { color: var(--text-strong); font-size: 12px; }
header button { width: 27px; height: 27px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text); font-size: 17px; }
nav { min-height: 0; overflow-y: auto; padding: 8px; }
.status,.empty { margin: 0; padding: 16px 10px; color: var(--muted); font-size: 11px; line-height: 1.5; }
.error { color: var(--red); }
.chat-group + .chat-group { margin-top: 11px; }
.chat-group h2 { margin: 0 0 5px; padding: 0 4px; color: var(--faint); font-size: 10px; font-weight: 650; }
.history-item { position: relative; display: flex; border-radius: 5px; }
.history-item:hover { background: var(--hover); }
.history-item.active { background: var(--selected); box-shadow: inset 3px 0 0 var(--accent); }
.chat-select { min-width: 0; flex: 1; padding: 9px 28px 10px 10px; border: 0; background: transparent; color: var(--text); text-align: left; }
.chat-select strong { display: block; overflow: hidden; color: var(--text-strong); font-size: 11px; font-weight: 690; text-overflow: ellipsis; white-space: nowrap; }
.chat-select span { display: flex; justify-content: space-between; gap: 7px; margin-top: 5px; color: var(--faint); font-size: 10px; }
.chat-select b { color: var(--muted); font-weight: 550; white-space: nowrap; }
.chat-remove { position: absolute; top: 7px; right: 4px; width: 23px; height: 23px; border: 0; border-radius: 4px; background: transparent; color: var(--faint); opacity: 0; }
.history-item:hover .chat-remove,.chat-remove:focus-visible { opacity: 1; }
.chat-remove:hover { background: var(--surface); color: var(--red); }
</style>
