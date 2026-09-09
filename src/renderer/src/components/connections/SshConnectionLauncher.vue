<script setup lang="ts">
import { CheckCircle2, ChevronRight, KeyRound, Server, ShieldCheck, SquareTerminal, X } from '@lucide/vue'
import { computed, nextTick, ref, type ComponentPublicInstance } from 'vue'
import type { SavedDirectSessionInput } from '../../../../shared/contracts'
import type { DirectSessionSummary } from '../../../../main/ssh/direct-session-repository'
import sessionConfigImage from '../../../../../docs/images/quickstart/06-select-global-putty.png'
import bastionUsageImage from '../../../../../docs/images/quickstart/07-launch-bastion.png'
import DirectSshForm, { type DirectSshConnectRequest, type DirectSshSharedFields, type PrivateKeySelection } from './DirectSshForm.vue'
import { nextConnectionEntryState } from './connection-entry-state'

let launcherInstanceCounter = 0

const modes = [
  { id: 'bastionHost', label: '堡垒机跳转连接', description: '通过已配置的堡垒机进入目标主机', icon: ShieldCheck },
  { id: 'password', label: '主机用户名 + 密码连接', description: '使用账户密码直接连接 SSH 主机', icon: Server },
  { id: 'privateKey', label: '主机私钥连接', description: '使用本地私钥与密码短语验证', icon: KeyRound },
] as const
export type SshConnectionLauncherMode = typeof modes[number]['id']

const props = withDefaults(defineProps<{
  appearance?: 'embedded' | 'dialog'
  editingProfile?: DirectSessionSummary | null
}>(), { appearance: 'dialog', editingProfile: null })
const emit = defineEmits<{
  directConnect: [request: DirectSshConnectRequest]
  saveProfile: [profile: SavedDirectSessionInput]
  selectPrivateKey: [accept: (selection: PrivateKeySelection | null) => void]
  close: []
}>()

// The empty state and the modal opened from any SSH entry point intentionally
// render this exact component and expose the same connection choices.
const visibleModes = computed(() => modes)
const launcherInstanceId = `ssh-launcher-${++launcherInstanceCounter}`
const launcherTitleId = `${launcherInstanceId}-title`
const initialMode = props.editingProfile?.authKind ?? 'bastionHost'
const mode = ref<SshConnectionLauncherMode>(initialMode)
const fields = ref<DirectSshSharedFields>({ host: '', port: 22, username: '' })
const tabRefs = ref<HTMLButtonElement[]>([])

function setTabRef(element: Element | ComponentPublicInstance | null): void {
  if (element instanceof HTMLButtonElement && !tabRefs.value.includes(element)) tabRefs.value.push(element)
}

function selectMode(nextMode: SshConnectionLauncherMode): void {
  const nextState = nextConnectionEntryState({
    mode: mode.value,
    host: fields.value.host,
    port: fields.value.port,
    username: fields.value.username,
    password: '',
    passphrase: '',
    keyReference: null,
  }, nextMode)
  mode.value = nextMode
  fields.value = { host: nextState.host, port: nextState.port, username: nextState.username }
}

function onKeydown(event: KeyboardEvent): void {
  const available = visibleModes.value
  const index = available.findIndex(item => item.id === mode.value)
  const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % available.length : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index - 1 + available.length) % available.length : -1
  if (next < 0) return
  event.preventDefault()
  selectMode(available[next]!.id)
  void nextTick(() => tabRefs.value[next]?.focus())
}

function directConnect(request: DirectSshConnectRequest): void {
  emit('directConnect', request)
}

function updateFields(next: DirectSshSharedFields): void {
  fields.value = next
}

</script>

<template>
  <section class="ssh-launcher" :class="`appearance-${appearance}`" :aria-labelledby="launcherTitleId">
    <header class="launcher-header">
      <span class="launcher-visual" aria-hidden="true"><SquareTerminal :size="25" /></span>
      <div class="launcher-title">
        <span class="launcher-eyebrow">SSH CONNECTION</span>
        <h2 :id="launcherTitleId">新建 SSH 连接</h2>
        <p class="mode-description">选择适合当前环境的安全连接方式</p>
        <p v-if="appearance === 'embedded'" class="plugin-status"><CheckCircle2 :size="13" aria-hidden="true" /><span>请选择连接方式，现有 SSH 会话不会受影响</span></p>
      </div>
      <button v-if="appearance === 'dialog'" type="button" class="close-button" aria-label="关闭新建 SSH 连接" title="关闭" @click="emit('close')"><X :size="17" aria-hidden="true" /></button>
    </header>
    <div class="launcher-body">
      <div class="mode-tabs" role="tablist" aria-label="SSH 连接方式" aria-orientation="horizontal">
        <button
          v-for="item in visibleModes"
          :key="item.id"
          :ref="setTabRef"
          :id="`${launcherInstanceId}-tab-${item.id}`"
          type="button"
          role="tab"
          :aria-label="item.label"
          :aria-selected="mode === item.id"
          :aria-controls="`${launcherInstanceId}-panel-${item.id}`"
          :tabindex="mode === item.id ? 0 : -1"
          :class="{ active: mode === item.id }"
          @click="selectMode(item.id)"
          @keydown="onKeydown"
        ><span class="mode-tab-icon" aria-hidden="true"><component :is="item.icon" :size="17" /></span><span class="mode-tab-copy" :data-description="item.description">{{ item.label }}</span><ChevronRight class="mode-tab-arrow" :size="16" aria-hidden="true" /></button>
      </div>
      <div class="launcher-scroll-region">
        <div class="mode-panel" role="tabpanel" :id="`${launcherInstanceId}-panel-${mode}`" :aria-labelledby="`${launcherInstanceId}-tab-${mode}`">
          <template v-if="mode === 'bastionHost'">
            <section class="connection-notices" aria-label="堡垒机连接须知">
              <p class="manual-launch-note"><strong>请手动操作</strong>请在堡垒机客户端中指定目标主机并发起 SSH 连接，Terminal-Agent 不会自动填写或唤起堡垒机。</p>
              <figure class="connection-notice">
                <figcaption><strong>【配置须知】</strong>AccessClient“会话配置”的“会话访问方式”必须使用“使用全局设置(putty)”。</figcaption>
                <img :src="sessionConfigImage" alt="AccessClient 会话配置：使用全局设置(putty)" />
              </figure>
              <figure class="connection-notice">
                <figcaption><strong>【使用须知】</strong>使用集团堡垒机正常指定主机 SSH 连接即可。</figcaption>
                <img :src="bastionUsageImage" alt="集团堡垒机正常指定主机 SSH 连接" />
              </figure>
            </section>
          </template>
          <DirectSshForm v-else :key="mode" :mode="mode" :editing-profile="editingProfile" :initial-fields="fields" @fields-change="updateFields" @connect="directConnect" @save-profile="emit('saveProfile', $event)" @select-private-key="emit('selectPrivateKey', $event)" />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ssh-launcher { display: flex; flex-direction: column; width: min(100%, 1040px); min-width: 0; min-height: 0; color: var(--text); container-type: inline-size; }
.appearance-dialog { box-sizing: border-box; width: min(1040px, calc(100vw - 64px)); height: min(100%, 760px); max-height: 100%; overflow: hidden; padding: clamp(20px, 3vw, 30px); border: 1px solid var(--line); border-radius: 9px; background: var(--surface); box-shadow: 0 20px 54px rgb(24 31 40 / 25%), 0 3px 12px rgb(24 31 40 / 12%); }
.appearance-embedded { align-self: center; justify-self: center; width: min(100%, 1040px); height: clamp(360px, 72vh, 760px); max-height: 100%; }
.launcher-header { position: relative; display: flex; align-items: center; justify-content: center; gap: 12px; min-height: 54px; text-align: left; }
.launcher-title { min-width: 0; }.launcher-eyebrow { display: block; margin-bottom: 3px; color: var(--accent); font-size: 9px; font-weight: 800; letter-spacing: .12em; }
.launcher-visual { display: grid; place-items: center; width: 46px; height: 46px; flex: 0 0 auto; border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--line)); border-radius: 8px; background: color-mix(in srgb, var(--accent-soft) 76%, var(--surface)); color: var(--accent); }
h2, h3, .mode-description { margin: 0; }
h2 { color: var(--text-strong); font-size: 18px; font-weight: 740; }.appearance-embedded h2 { font-size: 19px; }
.mode-description { margin-top: 3px; color: var(--muted); font-size: 11px; line-height: 1.55; }
.plugin-status { display: inline-flex; align-items: center; justify-content: center; gap: 6px; margin: 8px 0 0; color: var(--green); font-size: 10px; font-weight: 650; }
.close-button { position: absolute; top: 0; right: 0; display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 1px solid var(--line); border-radius: 5px; background: var(--surface-soft); color: var(--muted); }.close-button:hover { border-color: var(--focus); background: var(--hover); color: var(--text-strong); }
.launcher-body { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; margin-top: 24px; }
.mode-tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-self: stretch; gap: 8px; margin: 0; padding: 0; border: 0; background: transparent; }
.mode-tabs button { display: grid; grid-template-columns: 32px minmax(0, 1fr) 16px; align-items: center; gap: 9px; min-width: 0; min-height: 56px; padding: 8px 11px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface-soft); color: var(--muted); font-size: 14px; font-weight: 700; line-height: 1.35; text-align: left; }
.mode-tab-icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 6px; background: var(--surface); color: var(--accent); }.mode-tab-copy { display: grid; gap: 2px; min-width: 0; color: var(--text-strong); font-size: 14px; font-weight: 720; line-height: 1.35; overflow-wrap: anywhere; white-space: normal; }.mode-tab-copy::after { color: var(--muted); font-size: 12px; font-weight: 500; line-height: 1.35; overflow-wrap: anywhere; white-space: normal; content: attr(data-description); }.mode-tab-arrow { justify-self: end; color: var(--faint); }
.mode-tabs button:hover { border-color: var(--focus); background: var(--hover); color: var(--text-strong); }.mode-tabs button.active { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); background: var(--selected); box-shadow: inset 3px 0 0 var(--accent); }.mode-tabs button.active .mode-tab-icon { background: var(--accent-soft); }.mode-tabs button.active .mode-tab-copy { color: var(--accent); }.mode-tabs button.active .mode-tab-arrow { color: var(--accent); }
.launcher-scroll-region { display: flex; align-items: safe center; justify-content: center; flex: 1 1 auto; min-width: 0; min-height: 0; margin-top: 18px; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; scrollbar-color: transparent transparent; scrollbar-gutter: stable; }.launcher-scroll-region::-webkit-scrollbar { width: 8px; }.launcher-scroll-region::-webkit-scrollbar-track { background: transparent; }.launcher-scroll-region::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 999px; background: transparent; background-clip: padding-box; }.launcher-scroll-region:hover,.launcher-scroll-region:focus-within { scrollbar-color: color-mix(in srgb, var(--muted) 58%, transparent) transparent; }.launcher-scroll-region:hover::-webkit-scrollbar-thumb,.launcher-scroll-region:focus-within::-webkit-scrollbar-thumb { background-color: color-mix(in srgb, var(--muted) 58%, transparent); }.launcher-scroll-region:hover::-webkit-scrollbar-thumb:hover,.launcher-scroll-region:focus-within::-webkit-scrollbar-thumb:hover { background-color: var(--muted); }
.mode-panel { flex: 0 0 auto; align-self: flex-start; width: 100%; min-width: 0; height: auto; overflow: hidden; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); text-align: left; }
.manual-launch-note { margin: 0 0 2px; padding: 9px 10px; border: 1px solid var(--amber-line); border-radius: 4px; background: var(--amber-soft); color: var(--amber); font-size: 12px; line-height: 1.55; }
.manual-launch-note strong { margin-right: 4px; color: var(--text-strong); font-weight: 700; }
.connection-notices { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; padding: 18px 20px 20px; color: var(--muted); font-size: 12px; line-height: 1.6; }.connection-notice { display: grid; gap: 10px; min-width: 0; margin: 0; padding: 12px; border: 1px solid var(--line-soft); border-radius: 6px; background: var(--surface-soft); }.connection-notice figcaption { margin: 0; }.connection-notice strong { margin-right: 4px; color: var(--text-strong); font-weight: 700; }.connection-notice img { display: block; width: 100%; max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); }.appearance-dialog .connection-notice img { max-height: 300px; object-fit: contain; object-position: top left; }
.mode-panel :deep(.direct-ssh-form) { width: min(100%, 680px); max-width: none; margin: 0 auto; }
@container (max-width: 620px) { .launcher-header { min-height: 46px; }.launcher-visual { width: 40px; height: 40px; }.mode-tabs { gap: 6px; }.mode-tabs button { grid-template-columns: 26px minmax(0, 1fr) 12px; gap: 6px; min-height: 0; padding: 7px; }.mode-tab-icon { width: 26px; height: 26px; }.mode-tab-copy { gap: 1px; font-size: 12px; line-height: 1.25; }.mode-tab-copy::after { font-size: 10px; line-height: 1.25; }.mode-tab-arrow { width: 12px; height: 12px; } }
@container (max-width: 460px) { .mode-tabs { grid-template-columns: repeat(3, minmax(0, 1fr)); }.mode-tabs button { grid-template-columns: 24px minmax(0, 1fr); gap: 4px; min-height: 56px; padding: 6px; }.mode-tab-icon { width: 24px; height: 24px; }.mode-tab-copy { font-size: 12px; line-height: 1.2; }.mode-tab-copy::after,.mode-tab-arrow { display: none; } }
@media (max-width: 520px) { .appearance-dialog { padding: 17px; }.launcher-header { align-items: flex-start; justify-content: flex-start; padding-right: 34px; }.launcher-visual { width: 40px; height: 40px; }.appearance-embedded h2 { font-size: 17px; }.connection-notices { padding-right: 13px; padding-left: 13px; } }
</style>
