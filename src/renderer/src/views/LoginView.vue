<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import SsoSettings from '../components/settings/SsoSettings.vue'
import { getSsoStore } from '../stores/sso'
import { loginErrorCopy, loginStatusCopy, shouldRetryOnMount } from '../sso-login-controller'

const emit = defineEmits<{ openSettings: [] }>()
const sso = getSsoStore()
const retrying = ref(false)
const retryError = ref('')
const settingsOpen = ref(false)
function openSettings(): void { settingsOpen.value = true; emit('openSettings') }
const displayError = computed(() => {
  if (retryError.value) return retryError.value
  const message = sso.error.value
  if (!message) return ''
  return loginErrorCopy(message)
})
const status = computed(() => loginStatusCopy(sso.state.state))

async function retry(): Promise<void> {
  retrying.value = true
  retryError.value = ''
  try { await sso.retry() } catch (error) { retryError.value = error instanceof Error ? loginErrorCopy(error.message) : '登录失败，请重试' } finally { retrying.value = false }
}

onMounted(() => { if (shouldRetryOnMount(sso.state.state)) void retry() })
</script>

<template>
  <main class="login-view" aria-labelledby="login-title">
    <section v-if="!settingsOpen" class="login-panel">
      <div v-if="sso.state.state === 'authenticating'" class="login-progress" role="status" aria-live="polite" aria-busy="true" aria-label="登录进行中">
        <div class="login-progress-visual" aria-hidden="true">
          <span class="login-spinner" />
          <span class="login-progress-dots"><i /><i /><i /></span>
        </div>
        <h1 id="login-title">登录进行中</h1>
        <p>{{ status || '正在安全获取用户信息' }}</p>
      </div>
      <template v-else>
        <h1 id="login-title">需要登录</h1>
        <p v-if="status" aria-live="polite">{{ status }}</p>
        <p v-if="sso.state.state === 'error' && !displayError" role="alert">登录失败，请重试</p>
        <p v-if="displayError" class="error" role="alert">{{ displayError }}</p>
        <div class="actions"><button type="button" :disabled="retrying" @click="retry">重试</button><button type="button" @click="openSettings">打开单点登录设置</button></div>
      </template>
    </section>
    <section v-else class="login-settings"><button type="button" class="back-login" @click="settingsOpen = false">返回登录页</button><SsoSettings @continue="settingsOpen = false" @workbench="settingsOpen = false" /></section>
  </main>
</template>

<style scoped>
.login-view { display: grid; place-items: center; width: 100vw; height: 100vh; background: var(--surface); color: var(--text); }.login-panel { display: grid; gap: 14px; width: min(420px, calc(100vw - 40px)); padding: 28px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); text-align: center; }.login-panel h1,.login-panel p { margin: 0; }.login-panel h1 { color: var(--text-strong); font-size: 20px; }.login-panel p { color: var(--muted); font-size: 12px; }.login-panel .error { color: var(--red); }.actions { display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; }.actions button { min-height: 34px; padding: 0 12px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text); font-size: 11px; }.actions button:first-child { border-color: var(--accent); background: var(--accent); color: white; }
.login-progress { display: grid; justify-items: center; gap: 12px; }
.login-progress h1 { margin: 0; }
.login-progress p { margin: 0; }
.login-progress-visual { position: relative; display: grid; place-items: center; width: 58px; height: 58px; color: var(--accent); }
.login-spinner { display: block; width: 38px; height: 38px; border: 3px solid var(--line); border-top-color: var(--accent); border-right-color: var(--accent); border-radius: 50%; animation: login-spin 1s linear infinite; }
.login-progress-dots { position: absolute; right: 0; bottom: 1px; display: inline-flex; gap: 3px; padding: 3px 5px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); }
.login-progress-dots i { display: block; width: 4px; height: 4px; border-radius: 50%; background: currentColor; opacity: .3; animation: login-dot 1.2s ease-in-out infinite; }.login-progress-dots i:nth-child(2) { animation-delay: .15s; }.login-progress-dots i:nth-child(3) { animation-delay: .3s; }
@keyframes login-spin { to { transform: rotate(360deg); } }
@keyframes login-dot { 0%, 60%, 100% { opacity: .3; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-2px); } }
@media (prefers-reduced-motion: reduce) { .login-spinner,.login-progress-dots i { animation-duration: 0.01ms; animation-iteration-count: 1; } }
</style>
