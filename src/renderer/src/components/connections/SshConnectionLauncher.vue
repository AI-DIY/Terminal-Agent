<script setup lang="ts">
import { CheckCircle2, SquareTerminal, X } from '@lucide/vue'
import { computed, nextTick, ref, type ComponentPublicInstance } from 'vue'
import type { BastionCatalogSnapshot, BastionHostSummary, SavedDirectSessionInput } from '../../../../shared/contracts'
import type { DirectSessionSummary } from '../../../../main/ssh/direct-session-repository'
import sessionConfigImage from '../../../../../docs/images/quickstart/06-select-global-putty.png'
import bastionUsageImage from '../../../../../docs/images/quickstart/07-launch-bastion.png'
import DirectSshForm, { type DirectSshConnectRequest, type DirectSshSharedFields, type PrivateKeySelection } from './DirectSshForm.vue'
import { nextConnectionEntryState } from './connection-entry-state'

const modes = [
  { id: 'password', label: '主机用户名 + 密码连接' },
  { id: 'privateKey', label: '主机私钥连接' },
] as const
export type SshConnectionLauncherMode = typeof modes[number]['id']

const props = withDefaults(defineProps<{
  appearance?: 'embedded' | 'dialog'
  catalog: BastionCatalogSnapshot | null
  hosts?: BastionHostSummary[]
  openHostIds?: ReadonlySet<string>
  loading?: boolean
  error?: string
  editingProfile?: DirectSessionSummary | null
}>(), { appearance: 'dialog', hosts: () => [], openHostIds: () => new Set(), loading: false, error: '' })
const emit = defineEmits<{
  directConnect: [request: DirectSshConnectRequest]
  saveProfile: [profile: SavedDirectSessionInput]
  selectPrivateKey: [accept: (selection: PrivateKeySelection | null) => void]
  close: []
}>()

// The embedded empty state and the modal opened from the Shell toolbar use this
// exact component. AccessClient/bastion launches remain supported by the main
// process, but are initiated by AccessClient rather than by a manual address
// field in this page.
const visibleModes = computed(() => modes)
const initialMode = props.editingProfile?.authKind ?? 'password'
const mode = ref<SshConnectionLauncherMode>(initialMode)
const fields = ref<DirectSshSharedFields>({ host: '', port: 22, username: '' })
const tabRefs = ref<HTMLButtonElement[]>([])
const activeLabel = computed(() => modes.find(item => item.id === mode.value)?.label ?? '')

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
  <section class="ssh-launcher" :class="`appearance-${appearance}`" aria-labelledby="ssh-launcher-title">
    <header class="launcher-header">
      <span v-if="appearance === 'embedded'" class="launcher-visual" aria-hidden="true"><SquareTerminal :size="25" /></span>
      <div>
        <p v-if="appearance === 'dialog'" class="eyebrow">SSH 工作台</p>
        <h2 id="ssh-launcher-title">新建 SSH 连接</h2>
        <p v-if="appearance === 'embedded'" class="launcher-copy">统一选择直连方式：可使用用户名密码或私钥连接主机。</p>
        <p v-else class="mode-description">{{ activeLabel }}</p>
        <p v-if="appearance === 'embedded'" class="plugin-status"><CheckCircle2 :size="13" aria-hidden="true" /><span>请选择连接方式</span></p>
      </div>
      <button v-if="appearance === 'dialog'" type="button" class="close-button" aria-label="关闭新建 SSH 连接" title="关闭" @click="emit('close')"><X :size="17" aria-hidden="true" /></button>
    </header>
    <div class="mode-tabs" role="tablist" aria-label="SSH 连接方式">
      <button
        v-for="item in visibleModes"
        :key="item.id"
        :ref="setTabRef"
        type="button"
        role="tab"
        :aria-selected="mode === item.id"
        :aria-controls="`ssh-panel-${item.id}`"
        :tabindex="mode === item.id ? 0 : -1"
        :class="{ active: mode === item.id }"
        @click="selectMode(item.id)"
        @keydown="onKeydown"
      >{{ item.label }}</button>
    </div>
    <div class="mode-panel" role="tabpanel" :id="`ssh-panel-${mode}`">
      <DirectSshForm :key="mode" :mode="mode" :editing-profile="editingProfile" :initial-fields="fields" @fields-change="updateFields" @connect="directConnect" @save-profile="emit('saveProfile', $event)" @select-private-key="emit('selectPrivateKey', $event)" />
    </div>
    <section class="connection-notices" aria-label="堡垒机连接须知">
      <figure class="connection-notice">
        <figcaption><strong>【配置须知】</strong>AccessClient“会话配置”的“会话访问方式”必须使用“使用全局设置(putty)”。</figcaption>
        <img :src="sessionConfigImage" alt="AccessClient 会话配置：使用全局设置(putty)" />
      </figure>
      <figure class="connection-notice">
        <figcaption><strong>【使用须知】</strong>使用集团堡垒机正常指定主机 SSH 连接即可。</figcaption>
        <img :src="bastionUsageImage" alt="集团堡垒机正常指定主机 SSH 连接" />
      </figure>
    </section>
  </section>
</template>

<style scoped>
.ssh-launcher { width: min(100%, 620px); color: var(--text); }
.appearance-dialog { max-height: calc(100vh - 32px); overflow-y: auto; padding: 22px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); box-shadow: 0 18px 46px rgb(24 31 40 / 22%), 0 3px 10px rgb(24 31 40 / 10%); }
.appearance-embedded { width: min(460px, 100%); margin: 0 auto; padding: clamp(42px, 8vh, 72px) 0 30px; }
.launcher-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.appearance-embedded .launcher-header { display: grid; justify-items: center; gap: 0; text-align: center; }
.launcher-visual { display: grid; place-items: center; width: 54px; height: 54px; margin-bottom: 16px; border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--text-strong); }
.eyebrow, .mode-description, h2 { margin: 0; }
.eyebrow { color: var(--muted); font-size: 10px; font-weight: 700; text-transform: uppercase; }
h2 { margin-top: 5px; color: var(--text-strong); font-size: 18px; font-weight: 720; }.appearance-embedded h2 { margin: 0; font-size: 17px; }
.mode-description,.launcher-copy { margin: 8px 0 0; color: var(--muted); font-size: 11px; line-height: 1.65; }.launcher-copy { max-width: 410px; }
.plugin-status { display: inline-flex; align-items: center; justify-content: center; gap: 6px; margin: 12px 0 0; color: var(--green); font-size: 10px; font-weight: 650; }
.close-button { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 1px solid var(--line); border-radius: 5px; background: var(--surface-soft); color: var(--muted); }.close-button:hover { border-color: var(--focus); background: var(--hover); color: var(--text-strong); }
.mode-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3px; margin-top: 16px; padding: 3px; border: 1px solid var(--line-soft); border-radius: 6px; background: var(--surface-soft); }
.mode-tabs button { min-height: 30px; padding: 5px 8px; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--muted); font-size: 10px; font-weight: 650; text-align: center; }
.mode-tabs button:hover { color: var(--text-strong); }.mode-tabs button.active { border-color: var(--line); background: var(--surface); color: var(--accent); box-shadow: 0 1px 2px rgb(35 44 55 / 12%); }
.mode-panel { margin-top: 12px; text-align: left; }
.connection-notices { display: grid; gap: 12px; margin-top: 14px; padding: 10px 11px; border-left: 3px solid var(--accent); border-radius: 4px; background: var(--surface-soft); color: var(--muted); font-size: 10px; line-height: 1.55; }.connection-notice { display: grid; gap: 7px; margin: 0; }.connection-notice figcaption { margin: 0; }.connection-notice strong { margin-right: 4px; color: var(--text-strong); font-weight: 700; }.connection-notice img { display: block; width: 100%; max-width: 100%; height: auto; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); }.appearance-dialog .connection-notices { grid-template-columns: repeat(2, minmax(0, 1fr)); }.appearance-dialog .connection-notice img { max-height: 120px; object-fit: contain; object-position: top left; }
@media (max-width: 520px) { .mode-tabs { grid-template-columns: 1fr; } .appearance-dialog { padding: 17px; }.appearance-dialog .connection-notices { grid-template-columns: 1fr; }.appearance-dialog .connection-notice img { max-height: 180px; } }
</style>
