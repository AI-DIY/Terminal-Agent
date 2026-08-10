<script setup lang="ts">
import { computed, ref } from 'vue'
import { candidateState, type CandidateDisposition } from './command-candidate-state'
const props = defineProps<{ candidate: { id: string; sessionId: string; command: string; explanation?: string }; disposition: CandidateDisposition }>()
const confirmationId = ref<string | null>(null)
const error = ref('')
const result = ref('')
const state = computed(() => candidateState({ disposition: props.disposition, confirmationId: confirmationId.value }))
async function execute(): Promise<void> {
  if (!state.value.canExecute) return
  error.value = ''; result.value = ''
  try {
    let marker = confirmationId.value
    if (!marker) {
      marker = (await window.terminalAgent.agent.confirmCandidate({ sessionId: props.candidate.sessionId, candidateId: props.candidate.id })).id
      confirmationId.value = marker
    }
    const response = await window.terminalAgent.agent.executeCommand({ sessionId: props.candidate.sessionId, command: props.candidate.command, ...(marker ? { confirmationId: marker } : {}) })
    if (response.kind === 'intercepted') error.value = `已被安全围栏拦截：${response.ruleName}`
    else result.value = '已发送到当前终端'
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '无法执行候选命令。' }
}
</script>
<template><section class="candidate"><header><strong>命令候选</strong><span>{{ state.label }}</span></header><code>{{ candidate.command }}</code><p v-if="candidate.explanation">{{ candidate.explanation }}</p><button v-if="state.canExecute" :disabled="confirmationId !== null" type="button" @click="execute">确认并执行</button><p v-if="error" role="alert">{{ error }}</p><p v-if="result">{{ result }}</p></section></template>
<style scoped>.candidate{display:grid;gap:8px;border:1px solid #cbd5e1;border-radius:6px;padding:12px}.candidate header{display:flex;justify-content:space-between}.candidate code{overflow:auto;background:#0f172a;color:#e2e8f0;padding:8px}.candidate button{justify-self:start}.candidate [role=alert]{color:#b91c1c}</style>
