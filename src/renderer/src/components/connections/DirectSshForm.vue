<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { SavedDirectSessionInput } from '../../../../shared/contracts'
import type { DirectSessionSummary } from '../../../../main/ssh/direct-session-repository'
import { formFromSavedProfile, savedProfileFromForm } from '../direct-session-profile-form'
import { toDirectConnectionRequest, type DirectSshFormInput } from './direct-ssh-form-state'

export type DirectSshMode = 'password' | 'privateKey'
export type DirectSshSharedFields = { host: string; port: number; username: string }
export type PrivateKeySelection = { id: string; fileName: string; filePath: string }
export type DirectSshConnectRequest = {
  connection: Exclude<ReturnType<typeof toDirectConnectionRequest>, { error: string }>
  profile?: SavedDirectSessionInput
}

const props = defineProps<{
  mode: DirectSshMode
  editingProfile?: DirectSessionSummary | null
  initialFields?: DirectSshSharedFields
}>()
const emit = defineEmits<{
  connect: [request: DirectSshConnectRequest]
  saveProfile: [profile: SavedDirectSessionInput]
  fieldsChange: [fields: DirectSshSharedFields]
  selectPrivateKey: [accept: (selection: PrivateKeySelection | null) => void]
}>()

const host = ref('')
const port = ref(22)
const username = ref('')
const password = ref('')
const privateKey = ref<PrivateKeySelection | null>(null)
const existingPrivateKeyPath = ref<string | undefined>()
const passphrase = ref('')
const saveProfile = ref(false)
const profileName = ref('')
const error = ref('')
const isEditing = computed(() => props.editingProfile !== undefined && props.editingProfile !== null)
const visiblePrivateKeyName = computed(() => privateKey.value?.fileName ?? existingPrivateKeyPath.value?.split(/[\\/]/).at(-1))

watch(() => props.editingProfile, profile => {
  error.value = ''
  password.value = ''
  passphrase.value = ''
  privateKey.value = null
  existingPrivateKeyPath.value = undefined
  if (!profile) {
    host.value = props.initialFields?.host ?? ''
    port.value = props.initialFields?.port ?? 22
    username.value = props.initialFields?.username ?? ''
    saveProfile.value = false
    profileName.value = ''
    return
  }
  const form = formFromSavedProfile(profile)
  host.value = form.host
  port.value = form.port
  username.value = form.username
  existingPrivateKeyPath.value = form.privateKeyPath
  saveProfile.value = true
  profileName.value = form.name
}, { immediate: true })

watch([host, port, username], () => {
  emit('fieldsChange', { host: host.value, port: Number(port.value), username: username.value })
})

function selectPrivateKey(): void {
  emit('selectPrivateKey', selection => { privateKey.value = selection })
}

function profileForSave(): SavedDirectSessionInput {
  return savedProfileFromForm({
    id: props.editingProfile?.id ?? globalThis.crypto.randomUUID(),
    name: profileName.value,
    host: host.value,
    port: Number(port.value),
    username: username.value,
    authKind: props.mode,
    privateKeyPath: privateKey.value?.filePath ?? existingPrivateKeyPath.value,
  }, {
    password: isEditing.value && password.value === '' ? undefined : password.value,
    passphrase: isEditing.value && passphrase.value === '' ? undefined : passphrase.value || undefined,
  })
}

function submit(): void {
  error.value = ''
  if ((saveProfile.value || isEditing.value) && !profileName.value.trim()) {
    error.value = '请为保存的会话填写名称。'
    return
  }
  if (isEditing.value) {
    try {
      emit('saveProfile', profileForSave())
    } catch (profileError) {
      error.value = profileError instanceof Error ? profileError.message : '无法保存 SSH 会话。'
    }
    return
  }
  const input: DirectSshFormInput = props.mode === 'password'
    ? { mode: 'password', host: host.value, port: Number(port.value), username: username.value, password: password.value }
    : { mode: 'privateKey', host: host.value, port: Number(port.value), username: username.value, keyReference: privateKey.value?.id ?? null, passphrase: passphrase.value }
  const connection = toDirectConnectionRequest(input)
  if ('error' in connection) {
    error.value = connection.error
    return
  }
  let profile: SavedDirectSessionInput | undefined
  try {
    profile = (saveProfile.value || isEditing.value) ? profileForSave() : undefined
  } catch (profileError) {
    error.value = profileError instanceof Error ? profileError.message : '无法保存 SSH 会话。'
    return
  }
  emit('connect', { connection, ...(profile ? { profile } : {}) })
}
</script>

<template>
  <form class="direct-ssh-form" @submit.prevent="submit">
    <label>主机地址 <input v-model="host" autocomplete="off" placeholder="server.example.com" /></label>
    <label>端口 <input v-model.number="port" type="number" min="1" max="65535" /></label>
    <label>用户名 <input v-model="username" autocomplete="username" /></label>
    <label v-if="mode === 'password'">密码{{ isEditing ? '（留空则保留）' : '' }} <input v-model="password" type="password" autocomplete="current-password" /></label>
    <template v-else>
      <div class="field-group"><span>私钥文件</span><button type="button" aria-label="选择私钥文件" @click="selectPrivateKey">{{ visiblePrivateKeyName ?? '选择私钥文件' }}</button></div>
      <label>私钥密码短语{{ isEditing ? '（留空则保留）' : '' }} <input v-model="passphrase" type="password" autocomplete="off" /></label>
    </template>
    <label v-if="!isEditing" class="save-profile"><input v-model="saveProfile" type="checkbox" /> 保存到会话簿</label>
    <label v-if="saveProfile">会话名称 <input v-model="profileName" maxlength="255" placeholder="例如：生产 API" /></label>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <button type="submit">{{ isEditing ? '保存更改' : '连接' }}</button>
  </form>
</template>

<style scoped>
.direct-ssh-form { display: grid; gap: 10px; max-width: 360px; margin: 0 auto; padding: 20px; color: var(--text, #e2e8f0); }
label, .field-group { display: grid; gap: 4px; } input { min-height: 32px; border-radius: 4px; border: 1px solid var(--border, #475569); background: var(--canvas, #0f172a); color: inherit; padding: 4px 8px; }
.save-profile { display: flex; align-items: center; gap: 8px; } .save-profile input { min-height: auto; } .error { color: var(--danger, #fda4af); }
button { border: 0; border-radius: 5px; background: var(--accent, #0284c7); color: white; padding: 9px; }
</style>
