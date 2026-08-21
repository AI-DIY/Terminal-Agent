<script setup lang="ts">
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
      <div>
        <p class="eyebrow">SSH 工作台</p>
        <h2 id="ssh-launcher-title">新建 SSH 连接</h2>
        <p class="mode-description">{{ activeLabel }}</p>
      </div>
      <button v-if="appearance === 'dialog'" type="button" class="close-button" aria-label="关闭新建 SSH 连接" @click="emit('close')">×</button>
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
.ssh-launcher { width: min(100%, 620px); color: var(--text, #3b3e45); }
.appearance-dialog { padding: 24px; border: 1px solid var(--line, #d9dce3); border-radius: 8px; background: var(--surface, #fff); box-shadow: 0 18px 48px rgb(16 24 40 / 18%); }
.appearance-embedded { margin: auto; padding: clamp(18px, 4vw, 42px); }
.launcher-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.eyebrow, .mode-description, h2 { margin: 0; }
.eyebrow { color: var(--muted, #747983); font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
h2 { margin-top: 5px; color: var(--text-strong, #202228); font-size: clamp(20px, 3vw, 28px); }
.mode-description { margin-top: 8px; color: var(--muted, #747983); font-size: 13px; }
.close-button { width: 32px; height: 32px; border: 1px solid var(--line, #d9dce3); border-radius: 5px; background: var(--surface-soft, #fafbfc); color: var(--muted, #747983); font-size: 22px; line-height: 1; }
.mode-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; margin-top: 22px; }
.mode-tabs button { min-height: 42px; padding: 7px 9px; border: 1px solid var(--line, #d9dce3); border-radius: 5px; background: var(--surface-soft, #fafbfc); color: var(--text, #3b3e45); font-size: 12px; font-weight: 650; text-align: left; }
.mode-tabs button.active { border-color: var(--accent, #315fca); background: var(--accent-soft, #dce7ff); color: var(--accent, #315fca); }
.mode-panel { margin-top: 17px; }
@media (max-width: 520px) { .mode-tabs { grid-template-columns: 1fr; } .appearance-dialog { padding: 17px; } }
</style>
