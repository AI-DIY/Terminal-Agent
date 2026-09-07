<script setup lang="ts">
import type { DirectSessionSummary } from '../../../main/ssh/direct-session-repository'

defineProps<{ profiles: DirectSessionSummary[] }>()
const emit = defineEmits<{ close: []; create: []; connect: [id: string]; edit: [profile: DirectSessionSummary]; remove: [id: string] }>()
</script>

<template>
  <section class="saved-sessions" aria-label="已保存会话">
    <header><h2>已保存会话</h2><button type="button" @click="emit('close')">关闭</button></header>
    <p v-if="!profiles.length" class="empty">还没有保存的直连 SSH 会话。</p>
    <ul v-else>
      <li v-for="profile in profiles" :key="profile.id">
        <div><strong>{{ profile.name }}</strong><span>{{ profile.username }}@{{ profile.host }}:{{ profile.port }} · {{ profile.authKind === 'password' ? '密码' : '私钥' }}</span></div>
        <div class="actions"><button type="button" @click="emit('connect', profile.id)">连接</button><button type="button" @click="emit('edit', profile)">编辑</button><button type="button" class="delete" @click="emit('remove', profile.id)">删除</button></div>
      </li>
    </ul>
    <footer><button type="button" @click="emit('create')">新建 SSH 连接</button></footer>
  </section>
</template>

<style scoped>
.saved-sessions { display: grid; gap: 14px; width: min(680px, calc(100vw - 32px)); max-height: min(640px, calc(100vh - 48px)); padding: 20px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--text); }.saved-sessions header,.saved-sessions footer,.saved-sessions li,.actions{display:flex;align-items:center;justify-content:space-between;gap:10px}.saved-sessions h2{margin:0;color:var(--text-strong)}.saved-sessions ul{display:grid;gap:8px;margin:0;padding:0;list-style:none}.saved-sessions li{padding:10px;border:1px solid var(--line);border-radius:6px;background:var(--surface-soft)}.saved-sessions li>div:first-child{display:grid;gap:4px;min-width:0}.saved-sessions span{overflow:hidden;color:var(--muted);text-overflow:ellipsis;white-space:nowrap}.saved-sessions button{border:0;border-radius:5px;background:var(--accent);color:#fff;padding:8px 10px}.saved-sessions button:hover{background:var(--focus)}.saved-sessions .delete{background:var(--red)}.empty{margin:0;color:var(--muted)}
</style>
