<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{ hostIdentity: string; submitting: boolean }>()
const emit = defineEmits<{ acknowledge: []; close: [] }>()
const dialog = ref<HTMLElement | null>(null)
let previous: HTMLElement | null = null
function focusable(): HTMLElement[] { return dialog.value ? [...dialog.value.querySelectorAll<HTMLElement>('button,[href],input,[tabindex]:not([tabindex="-1"])')].filter(item => !item.hasAttribute('disabled')) : [] }
function trap(event: KeyboardEvent): void { if (event.key === 'Escape') { if (props.submitting) return; event.preventDefault(); emit('close'); return }; if (event.key !== 'Tab') return; const elements = focusable(); if (!elements.length) return; const first = elements[0]!; const last = elements.at(-1)!; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() } }
onMounted(() => { previous = document.activeElement instanceof HTMLElement ? document.activeElement : null; void nextTick(() => focusable()[0]?.focus()) })
onBeforeUnmount(() => previous?.focus())
</script>

<template>
  <div ref="dialog" class="consent" role="dialog" aria-modal="true" aria-labelledby="host-memory-consent-title" @keydown.capture="trap">
    <section :aria-busy="props.submitting"><h2 id="host-memory-consent-title">允许本地主机记忆？</h2><p>已发现主机 <strong>{{ props.hostIdentity }}</strong>。确认后，应用只会收集已启用范围内的只读结构化事实；不会保存密码、私钥、令牌、原始命令行或终端输出。</p><div><button type="button" :disabled="props.submitting" @click="emit('acknowledge')">{{ props.submitting ? '正在确认...' : '我已知道' }}</button><button type="button" :disabled="props.submitting" @click="emit('close')">暂不允许</button></div></section>
  </div>
</template>

<style scoped>
.consent { position:fixed; inset:0; z-index:30; display:grid; place-items:center; padding:24px; background:rgb(15 23 35 / 48%); }.consent section { display:grid; gap:14px; width:min(100%,520px); padding:20px; border:1px solid var(--line); border-radius:8px; background:var(--surface); color:var(--text); }.consent h2,.consent p { margin:0; }.consent section>div { display:flex; justify-content:flex-end; gap:8px; }
</style>
