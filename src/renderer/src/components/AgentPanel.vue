<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { SessionMode } from '../../../shared/contracts'
import CommandCandidate from './CommandCandidate.vue'
import { createAgentPanelStore } from '../stores/agent-panel'

const props = defineProps<{ session: { id: string; mode: SessionMode } }>()
const goal = ref('')
const panel = createAgentPanelStore()
const state = panel.state
let unsubscribeDelta: (() => void) | undefined
let unsubscribeProposal: (() => void) | undefined
let unsubscribeError: (() => void) | undefined

watch(() => props.session.id, sessionId => panel.activate(sessionId), { immediate: true })

async function start(): Promise<void> {
  const value = goal.value.trim()
  if (!value || state.streaming) return
  const runId = globalThis.crypto.randomUUID()
  panel.start(props.session.id, value, runId)
  try {
    await window.terminalAgent.agent.start({ sessionId: props.session.id, runId, goal: value })
  } catch {
    panel.apply({
      sessionId: props.session.id,
      runId,
      kind: 'error',
      message: 'AI 分析暂时不可用。请检查模型连接后重试。',
    })
  }
}

onMounted(() => {
  unsubscribeDelta = window.terminalAgent.agent.onDelta(event => panel.apply({ ...event, kind: 'delta' }))
  unsubscribeProposal = window.terminalAgent.agent.onProposal(event => panel.apply({ ...event, kind: 'proposal' }))
  unsubscribeError = window.terminalAgent.agent.onError(event => panel.apply({ ...event, kind: 'error' }))
})

onBeforeUnmount(() => {
  unsubscribeDelta?.()
  unsubscribeProposal?.()
  unsubscribeError?.()
})
</script>

<template>
  <aside class="agent-panel" aria-label="AI 运维分析">
    <header><strong>AI 运维分析</strong><span v-if="state.streaming">分析中</span></header>
    <form @submit.prevent="start">
      <label for="agent-goal">目标</label>
      <textarea id="agent-goal" v-model="goal" :disabled="state.streaming" maxlength="8192" placeholder="例如：检查 nginx 服务状态并给出下一步建议" />
      <button type="submit" :disabled="state.streaming || !goal.trim()">开始分析</button>
    </form>
    <p v-if="state.error" class="agent-error" role="alert">{{ state.error }}</p>
    <pre v-if="state.strategy" class="streaming-strategy">{{ state.strategy }}</pre>
    <section v-if="state.proposal" class="analysis-result" aria-label="分析结果">
      <p>{{ state.proposal.analysis }}</p>
      <ul v-if="state.proposal.evidenceStrategy.length">
        <li v-for="item in state.proposal.evidenceStrategy" :key="item">{{ item }}</li>
      </ul>
      <CommandCandidate
        v-if="state.proposal.candidate && !state.proposal.autonomousExecution"
        :candidate="state.proposal.candidate"
        disposition="pending"
      />
      <section v-else-if="state.proposal.candidate && state.proposal.autonomousExecution" class="autonomous-sent" aria-label="全自动驾驶执行结果">
        <strong>全自动驾驶已将候选命令发送至当前终端</strong>
        <code>{{ state.proposal.candidate.command }}</code>
      </section>
    </section>
  </aside>
</template>

<style scoped>
.agent-panel { display: grid; gap: 10px; padding: 12px; border-bottom: 1px solid #334155; background: #0f172a; color: #e2e8f0; }
.agent-panel header { display: flex; align-items: center; justify-content: space-between; color: #f8fafc; }
.agent-panel header span { color: #7dd3fc; font-size: 13px; }
.agent-panel form { display: grid; gap: 6px; grid-template-columns: minmax(0, 1fr) auto; align-items: end; }
.agent-panel label { grid-column: 1 / -1; font-size: 13px; }
.agent-panel textarea { min-height: 58px; resize: vertical; padding: 8px; border: 1px solid #475569; border-radius: 4px; background: #020617; color: #e2e8f0; font: inherit; }
.agent-panel button { min-width: 88px; height: 36px; border: 0; border-radius: 4px; background: #0284c7; color: #fff; }
.agent-panel button:disabled { opacity: .6; cursor: not-allowed; }
.agent-error { margin: 0; color: #fda4af; }
.streaming-strategy { max-height: 120px; margin: 0; overflow: auto; padding: 8px; border: 1px solid #334155; background: #020617; color: #bae6fd; white-space: pre-wrap; }
.analysis-result { display: grid; gap: 8px; }
.analysis-result p, .analysis-result ul { margin: 0; }
.analysis-result ul { padding-left: 20px; }
.autonomous-sent { display: grid; gap: 6px; padding: 8px; border: 1px solid #166534; background: #052e16; color: #dcfce7; }
.autonomous-sent code { overflow: auto; padding: 6px; background: #020617; color: #e2e8f0; }
@media (max-width: 640px) { .agent-panel form { grid-template-columns: 1fr; }.agent-panel button { width: 100%; } }
</style>
