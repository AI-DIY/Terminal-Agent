<script setup lang="ts">
import { Bot, Check, CircleAlert, PanelRightClose, Send, Square, Trash2, UserRound, X } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { ChatWorkspace } from '../../../../shared/contracts'
import { createGlobalChatStore, hasVisibleAssistantError } from '../../stores/global-chat'
import { chatContentText } from '../../../../shared/chat-content'
import { hostnameDisplayLabels } from '../../../../shared/shell-display-label'

const props = defineProps<{ chat: ChatWorkspace | null; readOnly?: boolean; shellCount?: number }>()
const emit = defineEmits<{ collapse: [] }>()
const store = createGlobalChatStore(window.terminalAgent.chat)
const modelContextLimit = ref(12_000)
const chatId = computed(() => props.chat?.id ?? '')
const assertiveError = ref<{ id: number; content: string } | null>(null)
const assistantResponse = ref<{ id: number; content: string } | null>(null)
let assertiveErrorId = 0
let assistantResponseId = 0
function announceAssertiveError(content: string): void {
  assertiveError.value = { id: ++assertiveErrorId, content }
}
function announceAssistantResponse(content: string): void {
  assistantResponse.value = { id: ++assistantResponseId, content }
}
const disposeErrorAnnouncement = store.onErrorAnnouncement(announcement => {
  if (announcement.chatId !== chatId.value) return
  announceAssertiveError(announcement.content)
})
const disposeAssistantAnnouncement = store.onAssistantAnnouncement(announcement => {
  if (announcement.chatId !== chatId.value) return
  announceAssistantResponse(assistantReply(announcement.content))
})
watch(() => props.chat, value => {
  if (value && !store.state.runs[value.id]) store.hydrate(value.id, value.messages, Boolean(props.readOnly))
}, { immediate: true })
watch(chatId, () => { assertiveError.value = null; assistantResponse.value = null })
const messages = computed(() => chatId.value ? store.state.messages[chatId.value] ?? [] : [])
const draft = computed(() => chatId.value ? store.draft(chatId.value) : '')
const running = computed(() => chatId.value ? Boolean(store.state.runs[chatId.value]) : false)
const progress = computed(() => chatId.value ? store.state.progress[chatId.value] ?? null : null)
const standaloneError = computed(() => {
  const error = chatId.value ? store.state.errors[chatId.value] ?? '' : ''
  if (!error || hasVisibleAssistantError(messages.value, error)) return ''
  return error
})
const actionErrors = reactive<Record<string, string>>({})
const actionError = computed(() => chatId.value ? actionErrors[chatId.value] ?? '' : '')
const stepDrafts = reactive<Record<string, string>>({})
const contextUsed = computed(() => messages.value.reduce((total, message) => total + Math.ceil(chatContentText(message.content).length / 4) + 4, 0))
const contextPercent = computed(() => Math.min(100, Math.round((contextUsed.value / modelContextLimit.value) * 100)))
function updateDraft(event: Event): void { if (chatId.value) store.setDraft(chatId.value, (event.target as HTMLTextAreaElement).value) }
function send(): void { if (chatId.value) { const content = store.composeUserContent(chatId.value); if (content) void store.send(chatId.value, content) } }
function cancel(): void { if (chatId.value) void store.cancel(chatId.value).catch(() => undefined) }
function onKeydown(event: KeyboardEvent): void { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); send() } }
function formatTokens(value: number): string { return new Intl.NumberFormat('zh-CN').format(value) }
function progressLabel(stage: typeof progress.value): string {
  return stage === 'thinking' ? '正在思考' : stage === 'executing' ? '正在执行' : stage === 'observing' ? '正在整理观察结果' : stage === 'repairing' ? '正在修正计划' : ''
}
function assistantReply(content: unknown): string {
  if (typeof content !== 'string') return chatContentText(content as any)
  try {
    const parsed = JSON.parse(content) as { version?: number; reply?: unknown }
    if (parsed && parsed.version === 1 && typeof parsed.reply === 'string') return parsed.reply
  } catch { /* legacy plain text */ }
  return content
}
function planStatusLabel(status: string): string {
  return status === 'pending_review' ? '待确认' : status === 'executing' ? '执行中' : status === 'executed' ? '已执行' : status === 'partially_executed' ? '部分执行' : status === 'execution_failed' ? '执行失败' : '已取消'
}
function stepCommand(step: { finalCommand?: string; originalCommand: string }): string { return step.finalCommand ?? step.originalCommand }
function planTargetLabel(target: string): string {
  const allShells = props.chat?.shells ?? []
  const liveShells = allShells.filter(shell => shell.status === 'open')
  const shells = liveShells.length > 0 ? liveShells : allShells
  const index = shells.findIndex(shell => shell.hostname === target)
  if (index < 0) return target
  return hostnameDisplayLabels(shells.map(shell => ({ hostname: shell.hostname, displayName: shell.title })))[index]?.displayLabel ?? target
}
function stepDraftKey(messageId: string, stepId: string): string { return `${messageId}:${stepId}` }
function setStepDraft(messageId: string, stepId: string, event: Event): void { stepDrafts[stepDraftKey(messageId, stepId)] = (event.target as HTMLInputElement).value }
function stepDraftValue(messageId: string, stepId: string, step: { finalCommand?: string; originalCommand: string }): string {
  return stepDrafts[stepDraftKey(messageId, stepId)] ?? stepCommand(step)
}
function reportActionError(actionChatId: string, error: unknown, fallback: string): void {
  actionErrors[actionChatId] = error instanceof Error ? error.message : fallback
  if (actionChatId !== chatId.value) return
  announceAssertiveError(actionErrors[actionChatId])
}
async function saveStep(messageId: string, stepId: string, fallbackCommand: string): Promise<void> {
  const key = stepDraftKey(messageId, stepId)
  const command = (stepDrafts[key] ?? fallbackCommand).trim()
  if (command) stepDrafts[key] = command
  await editStep(messageId, stepId, command)
}
async function editStep(messageId: string, stepId: string, command: string): Promise<void> {
  const actionChatId = chatId.value
  if (!actionChatId || props.readOnly || !command.trim()) return
  actionErrors[actionChatId] = ''
  try { await store.editPlanStep(actionChatId, messageId, stepId, command.trim()) } catch (error) { reportActionError(actionChatId, error, '计划更新失败') }
}
async function removeStep(messageId: string, stepId: string): Promise<void> {
  const actionChatId = chatId.value
  if (!actionChatId || props.readOnly) return
  actionErrors[actionChatId] = ''
  try { await store.removePlanStep(actionChatId, messageId, stepId) } catch (error) { reportActionError(actionChatId, error, '计划更新失败') }
}
async function cancelPlan(messageId: string): Promise<void> {
  const actionChatId = chatId.value
  if (!actionChatId || props.readOnly) return
  actionErrors[actionChatId] = ''
  try { await store.cancelPlan(actionChatId, messageId) } catch (error) { reportActionError(actionChatId, error, '计划取消失败') }
}
async function executePlan(messageId: string): Promise<void> {
  const actionChatId = chatId.value
  if (!actionChatId || props.readOnly) return
  actionErrors[actionChatId] = ''
  try { await store.executePlan(actionChatId, messageId) } catch (error) { reportActionError(actionChatId, error, '计划执行失败') }
}
onMounted(() => {
  void window.terminalAgent.settings.getModel()
    .then(model => { if (model?.contextLimit) modelContextLimit.value = model.contextLimit })
    .catch(() => undefined)
})
onBeforeUnmount(() => { disposeErrorAnnouncement(); disposeAssistantAnnouncement(); store.dispose() })
</script>

<template>
  <section class="global-chat-panel" aria-label="AI工作区">
    <header class="ai-head">
      <span class="ai-avatar" aria-hidden="true">AI</span>
      <div class="ai-head-copy"><h3>{{ readOnly ? 'AI工作区 · 历史' : 'AI工作区' }}</h3><span v-if="running" role="status">正在生成回复</span><span v-else>{{ readOnly ? '只读聊天与执行记录' : '当前任务的全局协作助手' }}</span></div>
      <button type="button" class="collapse-button" aria-label="收起 AI工作区" title="收起 AI工作区" @click="emit('collapse')"><span>收起</span><PanelRightClose :size="14" aria-hidden="true" /></button>
      <div class="ai-safety-badge"><Check :size="12" aria-hidden="true" /><span>计划需手动确认</span></div>
      <section class="context-meter" aria-label="AI 上下文用量">
        <div class="context-meter-head"><strong>上下文</strong><span>{{ formatTokens(contextUsed) }} / {{ formatTokens(modelContextLimit) }} tokens</span><b>{{ contextPercent }}%</b></div>
        <div class="context-progress" role="progressbar" aria-label="上下文使用比例" :aria-valuenow="contextPercent" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${contextPercent}%` }" /></div>
        <div class="context-meter-foot"><span>根据当前消息和模型上限估算</span></div>
      </section>
    </header>

    <div class="messages">
      <section v-if="progress" class="progress-item" role="status" aria-live="polite"><CircleAlert :size="14" aria-hidden="true" /><span>{{ progressLabel(progress) }}</span><span class="progress-dots" aria-hidden="true">...</span></section>
      <article v-for="message in messages" :key="message.id" :class="['message', message.role, { audit: message.messageType === 'execution_audit' }]">
        <span class="message-avatar" aria-hidden="true"><UserRound v-if="message.role === 'user'" :size="14" /><Bot v-else :size="14" /></span>
        <div class="message-content">
          <div class="message-meta"><strong>{{ message.messageType === 'execution_audit' ? '执行审计' : message.role === 'user' ? '你' : 'Terminal-Agent' }}</strong><span v-if="message.state === 'streaming'">生成中</span><span v-else-if="message.state === 'error'">未完成</span></div>
          <p>{{ message.messageType === 'execution_audit' ? String(message.content) : message.role === 'assistant' ? assistantReply(message.content) : (typeof message.content === 'string' ? message.content : chatContentText(message.content)) }}</p>
          <section v-if="message.executionPlan" class="execution-plan" :data-status="message.executionPlan.status">
            <header class="plan-head"><div><strong>{{ message.executionPlan.title }}</strong><span>{{ message.executionPlan.steps.length }} 步 · {{ planStatusLabel(message.executionPlan.status) }}</span></div><span class="plan-badge">{{ planStatusLabel(message.executionPlan.status) }}</span></header>
            <div v-for="step in message.executionPlan.steps" :key="step.id" class="plan-step">
               <div class="plan-step-head"><strong>{{ planTargetLabel(step.target) }}</strong><span>{{ step.sendState }}</span></div>
               <p>{{ step.explanation }}</p>
               <div v-if="step.fence" class="plan-risk"><CircleAlert :size="12" aria-hidden="true" /><span>安全围栏：{{ step.fence.ruleName }}（{{ step.fence.ruleId }}）</span></div>
               <label class="plan-command"><span>原始命令</span><code>{{ step.originalCommand }}</code></label>
               <label v-if="step.finalCommand" class="plan-command"><span>确认命令</span><code>{{ step.finalCommand }}</code></label>
               <div v-if="message.executionPlan.status === 'pending_review' && !readOnly" class="plan-step-actions">
                 <input class="plan-edit-input" :value="stepDraftValue(message.id, step.id, step)" :aria-label="`编辑 ${planTargetLabel(step.target)} 命令`" @input="setStepDraft(message.id, step.id, $event)">
                 <button type="button" class="icon-button" :aria-label="`保存 ${planTargetLabel(step.target)} 命令`" title="保存命令" @click="saveStep(message.id, step.id, stepCommand(step))"><Check :size="13" aria-hidden="true" /></button>
                <button type="button" class="icon-button" :aria-label="`删除 ${planTargetLabel(step.target)} 步骤`" title="删除步骤" @click="removeStep(message.id, step.id)"><Trash2 :size="13" aria-hidden="true" /></button>
              </div>
            </div>
            <footer v-if="message.executionPlan.status === 'pending_review' && !readOnly" class="plan-actions">
              <button type="button" class="secondary-action" @click="cancelPlan(message.id)"><X :size="13" aria-hidden="true" />取消计划</button>
              <button type="button" class="primary-action" @click="executePlan(message.id)"><Send :size="13" aria-hidden="true" />确认并执行 {{ message.executionPlan.steps.length }} 步</button>
            </footer>
          </section>
        </div>
      </article>
      <section v-if="!messages.length" class="empty"><Bot :size="24" aria-hidden="true" /><strong>{{ readOnly ? '此任务没有 AI 记录' : '开始协作' }}</strong><span>{{ readOnly ? 'Shell 历史仍可在中间工作区查看' : '输入目标，AI 会结合当前任务中的 Shell 信息回答' }}</span></section>
      <p v-if="standaloneError" class="error">{{ standaloneError }}</p>
      <p v-if="actionError" class="error">{{ actionError }}</p>
    </div>
    <p class="visually-hidden-alert" role="status" aria-live="polite" aria-atomic="true"><span :key="assistantResponse?.id">{{ assistantResponse?.content ?? '' }}</span></p>
    <p class="visually-hidden-alert" role="alert" aria-atomic="true"><span :key="assertiveError?.id">{{ assertiveError?.content ?? '' }}</span></p>

    <footer class="composer">
      <div class="composer-shell">
        <textarea :value="draft" :disabled="readOnly || !chatId" aria-label="聊天输入" placeholder="告诉 AI 要完成什么；AI 会根据当前任务的 Shell 信息回答。" @input="updateDraft" @keydown="onKeydown" />
        <div class="composer-foot"><span>{{ readOnly ? '历史聊天只读' : `${props.shellCount ?? chat?.shellCount ?? 0} 个在线 Shell` }}</span><button v-if="running" type="button" class="cancel-button" @click="cancel"><Square :size="12" fill="currentColor" aria-hidden="true" />取消</button><button type="button" class="send-button" :disabled="readOnly || !chatId || !draft.trim()" @click="send"><Send :size="13" aria-hidden="true" />发送</button></div>
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
.ai-safety-badge { grid-column: 1 / -1; display: inline-flex; align-items: center; gap: 5px; min-width: 0; color: var(--accent); font-size: 10px; font-weight: 650; }
.context-meter { grid-column: 1 / -1; min-width: 0; padding-top: 7px; border-top: 1px solid var(--line-soft); }.context-meter-head { display: flex; align-items: baseline; gap: 6px; }.context-meter-head strong { color: var(--text-strong); font-size: 10px; }.context-meter-head span { color: var(--muted); font-size: 9px; font-variant-numeric: tabular-nums; }.context-meter-head b { margin-left: auto; color: var(--text-strong); font-size: 9px; }.context-progress { height: 5px; margin-top: 6px; overflow: hidden; border-radius: 3px; background: var(--line); }.context-progress span { display: block; height: 100%; border-radius: inherit; background: var(--accent); }.context-meter-foot { margin-top: 6px; color: var(--muted); font-size: 8.5px; }
.messages { min-width: 0; min-height: 0; overflow-x: hidden; overflow-y: auto; padding: 12px 12px 16px; scrollbar-gutter: stable; }
.visually-hidden-alert { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.progress-item { display: flex; align-items: center; gap: 7px; min-height: 32px; margin-bottom: 8px; padding: 8px 10px; border-left: 2px solid var(--accent); background: var(--surface-soft); color: var(--muted); font-size: 10px; }.progress-item svg { color: var(--accent); }.progress-dots { letter-spacing: 2px; color: var(--accent); }
.message { display: grid; grid-template-columns: 29px minmax(0, 1fr); align-items: start; gap: 8px; min-width: 0; padding: 8px 0; }.message-avatar { display: grid; place-items: center; width: 29px; height: 29px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--muted); }.message.assistant .message-avatar { border-color: var(--text-strong); background: var(--text-strong); color: var(--surface); }.message-content { position: relative; min-width: 0; max-width: 100%; padding: 10px 11px 11px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); overflow-wrap: anywhere; }.message.assistant .message-content::before { position: absolute; top: 10px; bottom: 10px; left: -1px; width: 2px; border-radius: 0 2px 2px 0; background: var(--accent); content: ""; }.message.user { grid-template-columns: minmax(0, 1fr) 29px; padding-left: 38px; }.message.user .message-avatar { grid-column: 2; grid-row: 1; background: var(--panel); color: var(--text-strong); }.message.user .message-content { grid-column: 1; grid-row: 1; background: var(--surface-soft); }.message-meta { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; color: var(--faint); font-size: 9px; }.message-meta strong { color: var(--text-strong); font-size: 10px; }.message.assistant .message-meta strong { color: var(--accent); }.message-meta span { margin-left: auto; }.message p { margin: 0; color: var(--text); font-size: 11px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }.message.audit .message-content { border-color: var(--amber-line); background: var(--amber-soft); }.message.audit .message-avatar { color: var(--amber); }
.execution-plan { display: grid; gap: 8px; margin-top: 11px; padding: 10px; border: 1px solid var(--line); border-radius: 5px; background: var(--panel); }.plan-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; min-width: 0; padding-bottom: 7px; border-bottom: 1px solid var(--line-soft); }.plan-head > div { display: grid; gap: 3px; min-width: 0; }.plan-head strong { color: var(--text-strong); font-size: 11px; overflow-wrap: anywhere; }.plan-head span { color: var(--muted); font-size: 9px; }.plan-badge { flex: 0 0 auto; padding: 3px 6px; border: 1px solid var(--accent); border-radius: 4px; color: var(--accent) !important; font-weight: 650; }.plan-step { display: grid; gap: 5px; min-width: 0; padding: 8px 0; border-bottom: 1px solid var(--line-soft); }.plan-step:last-of-type { border-bottom: 0; }.plan-step-head { display: flex; align-items: center; justify-content: space-between; gap: 7px; }.plan-step-head strong { color: var(--text-strong); font-size: 10px; }.plan-step-head span { color: var(--muted); font-size: 9px; }.plan-step p { color: var(--muted); font-size: 9px; line-height: 1.45; }.plan-risk { display: flex; align-items: flex-start; gap: 5px; color: var(--amber); font-size: 9px; line-height: 1.45; }.plan-risk svg { flex: 0 0 auto; margin-top: 1px; }.plan-command { display: grid; gap: 3px; min-width: 0; }.plan-command span { color: var(--faint); font-size: 8px; }.plan-command code { display: block; min-width: 0; overflow: auto; padding: 5px 6px; border: 1px solid var(--line-soft); background: var(--surface-soft); color: var(--text); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 9px; white-space: pre-wrap; overflow-wrap: anywhere; }.plan-step-actions,.plan-actions { display: flex; align-items: center; gap: 6px; min-width: 0; }.plan-step-actions { margin-top: 2px; }.plan-edit-input { min-width: 0; flex: 1; height: 27px; padding: 0 7px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--text); font-size: 9px; }.icon-button,.secondary-action,.primary-action { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-height: 27px; padding: 0 7px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--text); font-size: 9px; white-space: nowrap; }.icon-button { width: 27px; padding: 0; }.icon-button:hover,.secondary-action:hover { border-color: var(--focus); color: var(--text-strong); }.primary-action { border-color: var(--accent); background: var(--accent); color: #fff; }.plan-actions { justify-content: flex-end; padding-top: 2px; }.plan-actions button:disabled { cursor: not-allowed; opacity: .55; }
.empty { display: grid; justify-items: center; gap: 6px; padding: 34px 18px; color: var(--muted); text-align: center; }.empty strong { color: var(--text-strong); font-size: 12px; }.empty span { max-width: 270px; font-size: 10px; line-height: 1.55; }
.error { display: flex; align-items: flex-start; gap: 8px; margin: 8px 0 0 37px; padding: 9px 10px; border-left: 2px solid var(--red); background: var(--surface); color: var(--red); font-size: 10px; line-height: 1.5; }.error span { min-width: 0; flex: 1; overflow-wrap: anywhere; }.error button { display: inline-flex; align-items: center; gap: 4px; min-height: 26px; padding: 0 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--text); }
.composer { min-width: 0; padding: 10px; border-top: 1px solid var(--line); background: var(--surface); }.composer-shell { overflow: hidden; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-soft); }.composer:focus-within .composer-shell { border-color: var(--focus); box-shadow: 0 0 0 2px var(--accent-soft); }.composer textarea { display: block; width: 100%; height: 64px; resize: none; padding: 10px 11px 7px; border: 0; background: transparent; color: var(--text-strong); font-size: 11px; line-height: 1.5; }.composer textarea::placeholder { color: var(--faint); }.composer-foot { display: flex; align-items: center; justify-content: flex-end; gap: 7px; min-height: 39px; padding: 6px 7px 7px 10px; border-top: 1px solid var(--line-soft); }.composer-foot > span { min-width: 0; margin-right: auto; overflow: hidden; color: var(--muted); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }.composer-foot button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 29px; padding: 0 11px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text); font-size: 10px; font-weight: 650; }.composer-foot .send-button { border-color: var(--accent); background: var(--accent); color: #fff; }.composer-foot .cancel-button:hover { border-color: var(--red); color: var(--red); }
@media (max-width: 1180px) { .global-chat-panel { grid-template-rows: 176px minmax(0,1fr) auto; }.collapse-button span { display: none; }.collapse-button { width: 30px; padding: 0; }.ai-head-copy span { display: none; } }
</style>
