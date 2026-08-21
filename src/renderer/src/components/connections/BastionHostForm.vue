<script setup lang="ts">
import { ref, watch } from 'vue'
import type { BastionLaunchRequest } from '../../../../shared/contracts'
import { bastionHostRequest } from './bastion-host-state'

const props = defineProps<{ loading?: boolean; error?: string; initialTarget?: string }>()
const emit = defineEmits<{
  launch: [request: Extract<BastionLaunchRequest, { kind: 'host' }>]
  targetChange: [target: string]
}>()
const target = ref(props.initialTarget ?? '')
const localError = ref('')

watch(() => props.initialTarget, value => {
  if (value !== undefined && value !== target.value) target.value = value
})
watch(target, value => emit('targetChange', value))

function submit(): void {
  localError.value = ''
  if (props.loading) return
  const request = bastionHostRequest(target.value)
  if ('error' in request) {
    localError.value = request.error
    return
  }
  emit('launch', request)
}
</script>

<template>
  <form class="bastion-form" @submit.prevent="submit">
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <label>堡垒机主机地址
      <input v-model="target" autocomplete="off" placeholder="10.0.0.8 或 web-01.example.com" />
    </label>
    <p v-if="localError" class="error" role="alert">{{ localError }}</p>
    <button type="submit" :disabled="loading">{{ loading ? '唤起中…' : '唤起终端' }}</button>
  </form>
</template>

<style scoped>
.bastion-form { display: grid; gap: 12px; }
label { display: grid; gap: 5px; color: var(--text-strong, #202228); font-size: 13px; font-weight: 600; }
input { min-height: 36px; padding: 0 9px; border: 1px solid var(--line, #d9dce3); border-radius: 5px; background: var(--surface-soft, #fafbfc); color: var(--text, #3b3e45); }
button { min-height: 36px; border: 1px solid var(--accent, #315fca); border-radius: 5px; background: var(--accent, #315fca); color: #fff; font-weight: 650; }
button:disabled { cursor: not-allowed; opacity: .62; }
.error { margin: 0; color: var(--red, #b04444); line-height: 1.5; }
</style>
