<script setup lang="ts">
import { CheckCircle2, SquareTerminal, X } from '@lucide/vue'
import { computed, nextTick, ref, type ComponentPublicInstance } from 'vue'
import type { BastionCatalogSnapshot, BastionHostSummary, BastionLaunchRequest, SavedDirectSessionInput } from '../../../../shared/contracts'
import type { DirectSessionSummary } from '../../../../main/ssh/direct-session-repository'
import BastionCmdbForm from './BastionCmdbForm.vue'
import BastionHostForm from './BastionHostForm.vue'
import DirectSshForm, { type DirectSshConnectRequest, type DirectSshSharedFields, type PrivateKeySelection } from './DirectSshForm.vue'
import { nextConnectionEntryState } from './connection-entry-state'

const modes = [
  { id: 'cmdb', label: '堡垒机 CMDB 唤起' },
  { id: 'bastionHost', label: '堡垒机主机唤起' },
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
  bastionLaunch: [request: BastionLaunchRequest]
  saveProfile: [profile: SavedDirectSessionInput]
  selectPrivateKey: [accept: (selection: PrivateKeySelection | null) => void]
  systemChange: [systemId: string]
  close: []
}>()

const mode = ref<SshConnectionLauncherMode>(props.editingProfile?.authKind ?? 'cmdb')
const fields = ref<DirectSshSharedFields>({ host: '', port: 22, username: '' })
const target = ref('')
const systemId = ref('')
const hostId = ref('')
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
  if (nextMode === 'bastionHost') target.value = fields.value.host
  if (nextMode === 'password' || nextMode === 'privateKey') fields.value = { ...fields.value, host: target.value || fields.value.host }
}

function onKeydown(event: KeyboardEvent): void {
  const index = modes.findIndex(item => item.id === mode.value)
  const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % modes.length : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index - 1 + modes.length) % modes.length : -1
  if (next < 0) return
  event.preventDefault()
  selectMode(modes[next].id)
  void nextTick(() => tabRefs.value[next]?.focus())
}

function directConnect(request: DirectSshConnectRequest): void {
  emit('directConnect', request)
}

function launch(request: BastionLaunchRequest): void {
  emit('bastionLaunch', request)
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
        <p v-if="appearance === 'embedded'" class="launcher-copy">统一选择堡垒机或直连方式：可从 CMDB 选择、精确唤起主机，或使用用户名密码、私钥直接连接。</p>
        <p v-else class="mode-description">{{ activeLabel }}</p>
        <p v-if="appearance === 'embedded'" class="plugin-status"><CheckCircle2 :size="13" aria-hidden="true" /><span>请选择连接方式</span></p>
      </div>
      <button v-if="appearance === 'dialog'" type="button" class="close-button" aria-label="关闭新建 SSH 连接" title="关闭" @click="emit('close')"><X :size="17" aria-hidden="true" /></button>
    </header>
    <div class="mode-tabs" role="tablist" aria-label="SSH 连接方式">
      <button
        v-for="item in modes"
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
      <BastionCmdbForm v-if="mode === 'cmdb'" v-model:system-id="systemId" v-model:host-id="hostId" :catalog="catalog" :hosts="hosts" :open-host-ids="openHostIds" :loading="loading" :error="error" @system-change="emit('systemChange', $event)" @launch="launch" />
      <BastionHostForm v-else-if="mode === 'bastionHost'" :initial-target="target" :loading="loading" :error="error" @target-change="target = $event" @launch="launch" />
      <DirectSshForm v-else :key="mode" :mode="mode" :editing-profile="editingProfile" :initial-fields="fields" @fields-change="updateFields" @connect="directConnect" @save-profile="emit('saveProfile', $event)" @select-private-key="emit('selectPrivateKey', $event)" />
    </div>
  </section>
</template>

<style scoped>
.ssh-launcher { width: min(100%, 620px); color: var(--text); }
.appearance-dialog { padding: 22px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); box-shadow: 0 18px 46px rgb(24 31 40 / 22%), 0 3px 10px rgb(24 31 40 / 10%); }
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
@media (max-width: 520px) { .mode-tabs { grid-template-columns: 1fr; } .appearance-dialog { padding: 17px; } }
</style>
