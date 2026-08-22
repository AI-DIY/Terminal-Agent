<script setup lang="ts">
import { PanelLeftClose, Plus, Trash2 } from '@lucide/vue'
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
  collapse: []
  select: [chatId: string]
  remove: [chatId: string]
}>()

function createdLabel(chat: ChatSummary): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(chat.createdAt))
}
</script>

<template>
  <aside class="session-sidebar" aria-label="聊天会话">
    <header class="sidebar-header">
      <div class="panel-title"><strong>聊天会话</strong><span>标题由 AI 自动生成</span></div>
      <button type="button" class="collapse-button" aria-label="收起聊天会话" title="收起聊天会话" @click="emit('collapse')"><PanelLeftClose :size="14" aria-hidden="true" /><span>收起</span></button>
    </header>
    <button type="button" class="new-chat" aria-label="新建聊天" @click="emit('create')"><Plus :size="14" aria-hidden="true" /><span>新建聊天</span></button>
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
          <button type="button" class="chat-remove" :aria-label="`删除聊天 ${chat.title}`" title="删除聊天" @click="emit('remove', chat.id)"><Trash2 :size="13" aria-hidden="true" /></button>
        </div>
      </section>
    </nav>
  </aside>
</template>

<style scoped>
.session-sidebar { display: grid; grid-template-rows: 58px 46px auto minmax(0, 1fr); min-width: 0; height: 100%; overflow: hidden; background: var(--panel); color: var(--text); }
.sidebar-header { display: flex; align-items: center; gap: 8px; padding: 0 11px 0 13px; border-bottom: 1px solid var(--line-soft); }
.panel-title { min-width: 0; }.panel-title strong { display: block; overflow: hidden; color: var(--text-strong); font-size: 14px; font-weight: 720; text-overflow: ellipsis; white-space: nowrap; }.panel-title span { display: block; margin-top: 3px; overflow: hidden; color: var(--faint); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.collapse-button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-width: 66px; height: 30px; margin-left: auto; padding: 0 8px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text-strong); font-size: 10px; font-weight: 650; white-space: nowrap; }.collapse-button:hover { border-color: var(--focus); background: var(--hover); }
.new-chat { display: flex; align-items: center; gap: 7px; height: 32px; margin: 7px 9px; padding: 0 10px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text-strong); font-size: 11px; font-weight: 650; text-align: left; }.new-chat:hover { border-color: var(--focus); background: var(--hover); }
nav { min-height: 0; overflow-y: auto; padding: 6px 7px 14px; }
.status,.empty { grid-row: 3 / -1; margin: 0; padding: 16px 12px; color: var(--muted); font-size: 11px; line-height: 1.5; }
.error { color: var(--red); }
.chat-group + .chat-group { margin-top: 11px; }
.chat-group h2 { margin: 0 0 5px; padding: 11px 9px 0; color: var(--muted); font-size: 10px; font-weight: 650; }
.history-item { position: relative; display: flex; border-radius: 5px; }
.history-item:hover { background: var(--hover); }
.history-item.active { background: var(--selected); box-shadow: inset 3px 0 0 var(--accent); }
.chat-select { min-width: 0; flex: 1; padding: 9px 30px 10px 10px; border: 0; background: transparent; color: var(--text); text-align: left; }
.chat-select strong { display: block; overflow: hidden; color: var(--text-strong); font-size: 11px; font-weight: 690; text-overflow: ellipsis; white-space: nowrap; }
.chat-select span { display: flex; justify-content: space-between; gap: 10px; margin-top: 5px; color: var(--faint); font-size: 10px; font-variant-numeric: tabular-nums; }
.chat-select b { color: var(--muted); font-weight: 550; white-space: nowrap; }
.chat-remove { position: absolute; top: 7px; right: 4px; display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--faint); opacity: 0; }
.history-item:hover .chat-remove,.chat-remove:focus-visible { opacity: 1; }
.chat-remove:hover { background: var(--surface); color: var(--red); }
</style>
