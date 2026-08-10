<script setup lang="ts">
import { ref } from 'vue'
import type { RendererSessionRequest, SavedDirectSessionInput } from '../../../shared/contracts'

export type ConnectionDialogRequest = { connection: RendererSessionRequest; profile?: SavedDirectSessionInput }

const emit = defineEmits<{ connect: [request: ConnectionDialogRequest] }>()
const host = ref('')
const port = ref(22)
const username = ref('')
const authKind = ref<'password' | 'privateKey'>('password')
const password = ref('')
const privateKey = ref<{ id: string; fileName: string; filePath: string } | null>(null)
const passphrase = ref('')
const saveProfile = ref(false)
const profileName = ref('')
const error = ref('')

async function selectPrivateKey(): Promise<void> {
  privateKey.value = await window.terminalAgent.sessions.selectPrivateKey()
}

function submit(): void {
  error.value = ''
  if (!host.value.trim() || !username.value.trim()) {
    error.value = '请填写主机地址和用户名。'
    return
  }
  if (authKind.value === 'privateKey' && !privateKey.value) {
    error.value = '请选择私钥文件。'
    return
  }
  if (saveProfile.value && !profileName.value.trim()) {
    error.value = '请为保存的会话填写名称。'
    return
  }
  const common = { host: host.value.trim(), port: Number(port.value), username: username.value.trim() }
  const connection: RendererSessionRequest = authKind.value === 'password'
    ? { ...common, auth: { kind: 'password', password: password.value } }
    : { ...common, auth: { kind: 'privateKey', keyReference: privateKey.value!.id, passphrase: passphrase.value || undefined } }
  const profile: SavedDirectSessionInput | undefined = !saveProfile.value ? undefined : authKind.value === 'password'
    ? { id: globalThis.crypto.randomUUID(), name: profileName.value.trim(), ...common, auth: { kind: 'password', password: password.value } }
    : {
        id: globalThis.crypto.randomUUID(), name: profileName.value.trim(), ...common,
        auth: { kind: 'privateKey', privateKeyPath: privateKey.value!.filePath, passphrase: passphrase.value || undefined },
      }
  emit('connect', { connection, ...(profile ? { profile } : {}) })
}
</script>

<template>
  <form class="connection-dialog" @submit.prevent="submit">
    <label>主机地址 <input v-model="host" autocomplete="off" placeholder="server.example.com" /></label>
    <label>端口 <input v-model.number="port" type="number" min="1" max="65535" /></label>
    <label>用户名 <input v-model="username" autocomplete="username" /></label>
    <fieldset>
      <legend>认证方式</legend>
      <label><input v-model="authKind" type="radio" value="password" /> 用户名 + 密码</label>
      <label><input v-model="authKind" type="radio" value="privateKey" /> 私钥 + 密码短语</label>
    </fieldset>
    <label v-if="authKind === 'password'">密码 <input v-model="password" type="password" autocomplete="current-password" /></label>
    <template v-else>
      <label>私钥文件 <button type="button" @click="selectPrivateKey">{{ privateKey?.fileName ?? '选择私钥文件' }}</button></label>
      <label>私钥密码短语 <input v-model="passphrase" type="password" autocomplete="off" /></label>
    </template>
    <label class="save-profile"><input v-model="saveProfile" type="checkbox" /> 保存到会话簿</label>
    <label v-if="saveProfile">会话名称 <input v-model="profileName" maxlength="255" placeholder="例如：生产 API" /></label>
    <p v-if="error" class="error">{{ error }}</p>
    <button type="submit">连接</button>
  </form>
</template>

<style scoped>
.connection-dialog { display: grid; gap: 10px; max-width: 360px; margin: 0 auto; padding: 20px; color: #e2e8f0; }
label { display: grid; gap: 4px; } input { min-height: 32px; border-radius: 4px; border: 1px solid #475569; background: #0f172a; color: inherit; padding: 4px 8px; }
fieldset { display: grid; gap: 5px; border-color: #475569; } fieldset label { display: block; } .save-profile { display: flex; align-items: center; gap: 8px; } .save-profile input { min-height: auto; } .error { color: #fda4af; }
button { border: 0; border-radius: 5px; background: #0284c7; color: white; padding: 9px; }
</style>
