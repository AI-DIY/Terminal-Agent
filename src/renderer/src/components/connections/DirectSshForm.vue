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
  <form class="direct-ssh-form" :class="`auth-${mode}`" @submit.prevent="submit">
    <div class="direct-fields">
      <label class="field field-host"><span>主机地址</span><input v-model="host" autocomplete="off" placeholder="server.example.com" /></label>
      <label class="field field-port"><span>端口</span><input v-model.number="port" type="number" min="1" max="65535" /></label>
      <label class="field field-username"><span>用户名</span><input v-model="username" autocomplete="username" /></label>
      <label v-if="mode === 'password'" class="field field-password"><span>密码{{ isEditing ? '（留空则保留）' : '' }}</span><input v-model="password" type="password" autocomplete="current-password" /></label>
      <div v-else class="field-group field-key"><span>私钥文件</span><button type="button" class="key-button" aria-label="选择私钥文件" :title="visiblePrivateKeyName ?? '选择私钥文件'" @click="selectPrivateKey"><span class="key-button-label">{{ visiblePrivateKeyName ?? '选择私钥文件' }}</span></button></div>
      <label v-if="mode === 'privateKey'" class="field field-passphrase"><span>私钥密码短语{{ isEditing ? '（留空则保留）' : '' }}</span><input v-model="passphrase" type="password" autocomplete="off" /></label>
    </div>
    <div class="profile-options">
      <label v-if="!isEditing" class="save-profile"><input v-model="saveProfile" type="checkbox" /><span>保存到会话簿</span></label>
      <label v-if="saveProfile" class="field profile-name"><span>会话名称</span><input v-model="profileName" maxlength="255" placeholder="例如：生产 API" /></label>
    </div>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <button type="submit" class="submit-button">{{ isEditing ? '保存更改' : '连接' }}</button>
  </form>
</template>

<style scoped>
.direct-ssh-form {
  container-type: inline-size;
  display: grid;
  gap: 14px;
  box-sizing: border-box;
  width: 100%;
  max-width: 680px;
  margin: 0 auto;
  padding: clamp(16px, 3vw, 24px);
  color: var(--text);
}
.direct-fields { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(120px, .65fr); gap: 12px; min-width: 0; }
.field, .field-group { display: grid; gap: 5px; min-width: 0; color: var(--text-strong); font-size: 11px; font-weight: 650; line-height: 1.3; }
.field-host, .field-password, .field-key, .field-passphrase { grid-column: 1 / -1; }
.field > span, .field-group > span { min-width: 0; overflow-wrap: anywhere; }
input, .key-button { box-sizing: border-box; width: 100%; min-width: 0; min-height: 35px; padding: 7px 9px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface-soft); color: var(--text); font-size: 11px; line-height: 1.3; transition: border-color .15s ease, background .15s ease, box-shadow .15s ease; }
input::placeholder { color: var(--faint); }
input:hover, .key-button:hover { border-color: color-mix(in srgb, var(--accent) 48%, var(--line)); background: var(--surface); }
input:focus, .key-button:focus-visible { border-color: var(--focus); background: var(--surface); box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus) 20%, transparent); }
input[type='number'] { appearance: textfield; }
input[type='number']::-webkit-inner-spin-button, input[type='number']::-webkit-outer-spin-button { margin: 0; appearance: none; }
.key-button { display: flex; align-items: center; justify-content: flex-start; min-height: 35px; border-color: color-mix(in srgb, var(--accent) 42%, var(--line)); background: var(--accent-soft); color: var(--accent); font-weight: 680; text-align: left; cursor: pointer; }
.key-button-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.profile-options { display: grid; gap: 12px; min-width: 0; }
.save-profile { display: inline-flex; align-items: center; gap: 8px; min-height: 24px; color: var(--text); font-size: 11px; font-weight: 550; cursor: pointer; }
.save-profile input { width: 14px; min-width: 14px; height: 14px; min-height: 14px; margin: 0; padding: 0; accent-color: var(--accent); }
.error { box-sizing: border-box; margin: 0; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--red) 42%, var(--line)); border-radius: 5px; background: color-mix(in srgb, var(--red) 10%, var(--surface)); color: var(--red); font-size: 10px; line-height: 1.5; overflow-wrap: anywhere; }
.submit-button { width: 100%; min-height: 36px; padding: 0 14px; border: 1px solid var(--accent); border-radius: 5px; background: var(--accent); color: #fff; font-size: 11px; font-weight: 700; transition: background .15s ease, border-color .15s ease; }
.submit-button:hover { border-color: var(--focus); background: var(--focus); }
.submit-button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
@container (max-width: 430px) {
  .direct-fields { grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .field-port, .field-username { grid-column: 1; }
}
@container (max-width: 300px) {
  .direct-ssh-form { padding: 13px; }
  .direct-fields, .profile-options { gap: 9px; }
}
</style>
