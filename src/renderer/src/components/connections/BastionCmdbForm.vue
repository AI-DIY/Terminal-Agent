<script setup lang="ts">
import { computed, watch } from 'vue'
import type { BastionCatalogSnapshot, BastionHostSummary, BastionLaunchRequest } from '../../../../shared/contracts'
import { availableHosts } from './bastion-cmdb-state'

const props = defineProps<{
  catalog: BastionCatalogSnapshot | null
  hosts: BastionHostSummary[]
  openHostIds?: ReadonlySet<string>
  loading?: boolean
  error?: string
}>()
const emit = defineEmits<{
  launch: [request: Extract<BastionLaunchRequest, { kind: 'cmdb' }>]
  systemChange: [systemId: string]
}>()

const systemId = defineModel<string>('systemId', { default: '' })
const hostId = defineModel<string>('hostId', { default: '' })
const visibleHosts = computed(() => availableHosts(props.hosts, systemId.value, props.openHostIds ?? new Set()))

watch(visibleHosts, hosts => {
  if (hostId.value && !hosts.some(host => host.id === hostId.value)) hostId.value = ''
})

function onSystemChange(): void {
  hostId.value = ''
  emit('systemChange', systemId.value)
}

function submit(): void {
  if (!systemId.value || !hostId.value || props.loading || !props.catalog?.available) return
  emit('launch', { kind: 'cmdb', systemId: systemId.value, hostId: hostId.value })
}
</script>

<template>
  <form class="bastion-form" @submit.prevent="submit">
    <p v-if="catalog && !catalog.available" class="status" role="status">{{ catalog.message }}</p>
    <p v-else-if="error" class="error" role="alert">{{ error }}</p>
    <label>堡垒机系统
      <select v-model="systemId" :disabled="!catalog?.available || loading" @change="onSystemChange">
        <option value="">请选择系统</option>
        <option v-for="system in catalog?.systems ?? []" :key="system.id" :value="system.id">{{ system.name }}</option>
      </select>
    </label>
    <label>目标主机
      <select v-model="hostId" :disabled="!systemId || loading || !visibleHosts.length">
        <option value="">{{ systemId ? (visibleHosts.length ? '请选择主机' : '暂无可用主机') : '请先选择系统' }}</option>
        <option v-for="host in visibleHosts" :key="host.id" :value="host.id">{{ host.name }} · {{ host.address }}</option>
      </select>
    </label>
    <button type="submit" :disabled="!systemId || !hostId || loading">{{ loading ? '唤起中…' : '唤起终端' }}</button>
  </form>
</template>

<style scoped>
.bastion-form { display: grid; gap: 12px; }
label { display: grid; gap: 5px; color: var(--text-strong, #202228); font-size: 13px; font-weight: 600; }
select { min-width: 0; height: 36px; padding: 0 9px; border: 1px solid var(--line, #d9dce3); border-radius: 5px; background: var(--surface-soft, #fafbfc); color: var(--text, #3b3e45); }
button { min-height: 36px; border: 1px solid var(--accent, #315fca); border-radius: 5px; background: var(--accent, #315fca); color: #fff; font-weight: 650; }
button:disabled, select:disabled { cursor: not-allowed; opacity: .62; }
.status, .error { margin: 0; line-height: 1.5; }
.status { color: var(--muted, #747983); }
.error { color: var(--red, #b04444); }
</style>
