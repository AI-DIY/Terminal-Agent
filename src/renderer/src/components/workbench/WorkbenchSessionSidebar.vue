<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { MoreHorizontal, PanelLeftClose, Pencil, Pin, PinOff, Plus, Trash2 } from '@lucide/vue'
import type { ChatSummary } from '../../../../shared/contracts'
import type { ChatGroup } from '../../stores/chat-workspaces'

const props = defineProps<{
  groups: ChatGroup[]
  currentChatId: string | null
  loading: boolean
  error: string
  renameTask(chatId: string, title: string): Promise<boolean>
  pinTask(chatId: string): Promise<boolean>
  unpinTask(chatId: string): Promise<boolean>
}>()
const emit = defineEmits<{
  create: []
  collapse: []
  select: [chatId: string]
  remove: [chatId: string]
}>()

const openMenuChatId = ref<string | null>(null)
const editingChatId = ref<string | null>(null)
const renameValue = ref('')
const renameError = ref('')
const renameSaving = ref(false)
const renameInputs = new Map<string, HTMLInputElement>()

function createdLabel(chat: ChatSummary): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(chat.createdAt))
}

function setRenameInput(chatId: string, element: unknown): void {
  if (element instanceof HTMLInputElement) renameInputs.set(chatId, element)
  else renameInputs.delete(chatId)
}

function toggleMenu(chatId: string): void {
  openMenuChatId.value = openMenuChatId.value === chatId ? null : chatId
}

function beginRename(chat: ChatSummary): void {
  openMenuChatId.value = null
  editingChatId.value = chat.id
  renameValue.value = chat.title
  renameError.value = ''
  void nextTick(() => {
    const input = renameInputs.get(chat.id)
    input?.focus()
    input?.select()
  })
}

function cancelRename(): void {
  if (renameSaving.value) return
  editingChatId.value = null
  renameValue.value = ''
  renameError.value = ''
}

async function saveRename(chatId: string): Promise<void> {
  if (editingChatId.value !== chatId || renameSaving.value) return
  const title = renameValue.value.trim()
  if (!title) {
    renameError.value = '请输入任务名称。'
    return
  }
  renameSaving.value = true
  renameError.value = ''
  let saved = false
  try {
    saved = await props.renameTask(chatId, title)
  } catch {
    renameError.value = '无法更新任务名称。'
  } finally {
    renameSaving.value = false
  }
  if (saved) cancelRename()
  else if (!renameError.value) renameError.value = '无法更新任务名称。'
}

async function togglePin(chat: ChatSummary): Promise<void> {
  const changed = chat.pinnedAt ? await props.unpinTask(chat.id) : await props.pinTask(chat.id)
  if (changed) openMenuChatId.value = null
}

function removeTask(chatId: string): void {
  openMenuChatId.value = null
  emit('remove', chatId)
}
</script>

<template>
  <aside class="session-sidebar" aria-label="任务历史区">
    <header class="sidebar-header">
      <div class="panel-title"><strong>任务历史区</strong><span>任务与 Shell 记录</span></div>
      <button type="button" class="collapse-button" aria-label="收起任务历史区" title="收起任务历史区" @click="emit('collapse')"><PanelLeftClose :size="14" aria-hidden="true" /><span>收起</span></button>
    </header>
    <button type="button" class="new-chat" aria-label="新建任务" @click="emit('create')"><Plus :size="14" aria-hidden="true" /><span>新建任务</span></button>
    <p v-if="error" class="status error" role="alert">{{ error }}</p>
    <p v-else-if="loading" class="status">正在读取任务...</p>
    <nav v-else aria-label="任务历史列表">
      <p v-if="!groups.length" class="empty">暂无任务</p>
      <section v-for="group in groups" :key="group.label" class="chat-group" :aria-label="group.label">
        <h2>{{ group.label }}</h2>
        <div v-for="chat in group.chats" :key="chat.id" class="history-item" :class="{ active: chat.id === currentChatId }">
          <div v-if="editingChatId === chat.id" class="chat-rename">
            <input
              :ref="element => setRenameInput(chat.id, element)"
              v-model="renameValue"
              aria-label="任务名称"
              maxlength="255"
              :disabled="renameSaving"
              @input="renameError = ''"
              @keydown.enter.prevent="saveRename(chat.id)"
              @keydown.esc.prevent="cancelRename"
              @blur="saveRename(chat.id)"
            />
            <p v-if="renameError" class="rename-error" role="alert">{{ renameError }}</p>
          </div>
          <button v-else type="button" class="chat-select" :aria-label="`选择任务 ${chat.title}`" :aria-current="chat.id === currentChatId ? 'page' : undefined" @click="emit('select', chat.id)">
            <span class="chat-title"><strong>{{ chat.title }}</strong><span v-if="chat.pinnedAt" class="pin-status" role="img" aria-label="已置顶"><Pin :size="12" aria-hidden="true" /></span></span>
            <span class="chat-select-meta">{{ createdLabel(chat) }} 新建 <b>{{ chat.shellCount }} 个 Shell</b></span>
          </button>
          <div class="chat-actions">
            <button type="button" class="chat-menu-toggle" :aria-label="`任务操作 ${chat.title}`" title="任务操作" :aria-expanded="openMenuChatId === chat.id" @click.stop="toggleMenu(chat.id)"><MoreHorizontal :size="15" aria-hidden="true" /></button>
            <div v-if="openMenuChatId === chat.id" class="chat-menu" role="menu" aria-label="任务操作菜单">
              <button type="button" role="menuitem" @click="beginRename(chat)"><Pencil :size="13" aria-hidden="true" /><span>重命名</span></button>
              <button type="button" role="menuitem" @click="togglePin(chat)"><component :is="chat.pinnedAt ? PinOff : Pin" :size="13" aria-hidden="true" /><span>{{ chat.pinnedAt ? '取消置顶' : '置顶' }}</span></button>
              <button type="button" role="menuitem" class="danger" @click="removeTask(chat.id)"><Trash2 :size="13" aria-hidden="true" /><span>删除</span></button>
            </div>
          </div>
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
nav { min-height: 0; overflow-y: auto; padding: 6px 7px 14px; scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: transparent transparent; }
nav:hover,nav:focus-within { scrollbar-color: color-mix(in srgb, var(--muted) 58%, transparent) transparent; }
nav::-webkit-scrollbar { width: 8px; }
nav::-webkit-scrollbar-track { background: transparent; }
nav::-webkit-scrollbar-button { display: none; }
nav::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 4px; background: transparent; background-clip: padding-box; }
nav:hover::-webkit-scrollbar-thumb,nav:focus-within::-webkit-scrollbar-thumb { background-color: color-mix(in srgb, var(--muted) 58%, transparent); }
nav:hover::-webkit-scrollbar-thumb:hover,nav:focus-within::-webkit-scrollbar-thumb:hover { background-color: var(--muted); }
.status,.empty { grid-row: 3 / -1; margin: 0; padding: 16px 12px; color: var(--muted); font-size: 11px; line-height: 1.5; }
.error,.rename-error { color: var(--red); }
.chat-group + .chat-group { margin-top: 11px; }
.chat-group h2 { margin: 0 0 5px; padding: 11px 9px 0; color: var(--muted); font-size: 10px; font-weight: 650; }
.history-item { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) 28px; border-radius: 5px; }
.history-item:hover { background: var(--hover); }
.history-item.active { background: var(--selected); box-shadow: inset 3px 0 0 var(--accent); }
.chat-select,.chat-rename { min-width: 0; padding: 9px 6px 10px 10px; border: 0; background: transparent; color: var(--text); text-align: left; }
.chat-title { display: flex; min-width: 0; align-items: center; gap: 5px; }.chat-title strong { overflow: hidden; color: var(--text-strong); font-size: 11px; font-weight: 690; text-overflow: ellipsis; white-space: nowrap; }.pin-status { display: grid; flex: 0 0 auto; color: var(--accent); }
.chat-select-meta { display: flex; justify-content: space-between; gap: 10px; margin-top: 5px; color: var(--faint); font-size: 10px; font-variant-numeric: tabular-nums; }.chat-select-meta b { color: var(--muted); font-weight: 550; white-space: nowrap; }
.chat-rename { padding-right: 8px; }.chat-rename input { width: 100%; height: 26px; min-width: 0; padding: 0 6px; border: 1px solid var(--focus); border-radius: 4px; background: var(--surface); color: var(--text-strong); font: inherit; }.rename-error { margin: 4px 0 0; font-size: 10px; line-height: 1.3; }
.chat-actions { position: relative; align-self: start; }.chat-menu-toggle { display: grid; place-items: center; width: 24px; height: 24px; margin: 7px 4px 0 0; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--faint); opacity: 0; }.history-item:hover .chat-menu-toggle,.chat-menu-toggle:focus-visible,.chat-menu-toggle[aria-expanded="true"] { opacity: 1; }.chat-menu-toggle:hover { background: var(--surface); color: var(--text-strong); }
.chat-menu { position: absolute; z-index: 2; top: 34px; right: 4px; display: grid; width: 116px; padding: 4px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); box-shadow: 0 8px 18px color-mix(in srgb, #000 18%, transparent); }.chat-menu button { display: flex; align-items: center; gap: 7px; width: 100%; min-height: 28px; padding: 0 7px; border: 0; border-radius: 3px; background: transparent; color: var(--text); font-size: 10px; text-align: left; }.chat-menu button:hover,.chat-menu button:focus-visible { background: var(--hover); }.chat-menu .danger { color: var(--red); }
</style>
