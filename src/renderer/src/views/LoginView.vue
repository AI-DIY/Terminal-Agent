<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { getSsoStore } from '../stores/sso'

const emit = defineEmits<{ openSettings: [] }>()
const sso = getSsoStore()
const retrying = ref(false)
const retryError = ref('')
const displayError = computed(() => {
  if (retryError.value) return retryError.value
  const message = sso.error.value
  if (!message) return ''
  if (/closed|window/i.test(message)) return '登录窗口已关闭'
  return `登录失败：${message.slice(0, 240)}`
})
const status = computed(() => {
  if (sso.state.state === 'authenticating') return '等待平台加载用户信息'
  if (sso.state.state === 'login-required') return '正在打开登录页'
  return ''
})

async function retry(): Promise<void> {
  retrying.value = true
  retryError.value = ''
  try { await sso.retry() } catch (error) { retryError.value = error instanceof Error ? `登录失败：${error.message.slice(0, 240)}` : '登录失败，请重试' } finally { retrying.value = false }
}

onMounted(() => { if (sso.state.state === 'login-required') void retry() })
</script>

<template>
  <main class="login-view" aria-labelledby="login-title"><section class="login-panel"><h1 id="login-title">需要登录</h1><p v-if="status" aria-live="polite">{{ status }}</p><p v-if="sso.state.state === 'error' && !displayError" role="alert">登录失败，请重试</p><p v-if="displayError" class="error" role="alert">{{ displayError }}</p><div class="actions"><button type="button" :disabled="retrying" @click="retry">重试</button><button type="button" @click="emit('openSettings')">打开单点登录设置</button></div></section></main>
</template>

<style scoped>
.login-view { display: grid; place-items: center; width: 100vw; height: 100vh; background: var(--surface); color: var(--text); }.login-panel { display: grid; gap: 14px; width: min(420px, calc(100vw - 40px)); padding: 28px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); text-align: center; }.login-panel h1,.login-panel p { margin: 0; }.login-panel h1 { color: var(--text-strong); font-size: 20px; }.login-panel p { color: var(--muted); font-size: 12px; }.login-panel .error { color: var(--red); }.actions { display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; }.actions button { min-height: 34px; padding: 0 12px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text); font-size: 11px; }.actions button:first-child { border-color: var(--accent); background: var(--accent); color: white; }
</style>
