<script setup lang="ts">
import { RefreshCw } from '@lucide/vue'
import { nextTick, onMounted, ref } from 'vue'
import { hostMemoryRecordSchema, type HostMemoryRecord, type HostMemorySettings } from '../../../../shared/contracts'
import { HOST_MEMORY_COMMANDS } from '../../../../shared/host-memory-commands'
import { summarizeHostMemoryRecord } from './host-memory-summary'

type DiskDraft = { name: string; totalBytes: string }
type NetworkDraft = { name: string; addresses: string }
type ProcessDraft = { name: string; pid: string; workingDirectory: string }
type ServiceDraft = { name: string; status: string }
type LegacySoftwareDraft = { name: string; version: string }
type LegacyInstallLocationDraft = { name: string; path: string }
type HostMemoryDraft = {
  hostname: string
  observedAt: string
  connectionIp: string
  operatingSystemName: string
  operatingSystemVersion: string
  cpuModel: string
  cpuArchitecture: string
  cpuLogicalCores: string
  memoryTotalBytes: string
  disks: DiskDraft[]
  networkInterfaces: NetworkDraft[]
  processes: ProcessDraft[]
  currentUser: string
  workingDirectory: string
  services: ServiceDraft[]
  legacySoftware: LegacySoftwareDraft[]
  legacyInstallLocations: LegacyInstallLocationDraft[]
  legacyFacts: HostMemoryRecord['legacyFacts']
}

const loading = ref(true)
const error = ref('')
const settings = ref<HostMemorySettings>({ enabled: false, scopes: { identity: true, hardware: true, processes: true, runtime: true } })
const records = ref<HostMemoryRecord[]>([])
const expanded = ref<string | null>(null)
const editing = ref<HostMemoryDraft | null>(null)
const savingEdit = ref(false)
const clearTarget = ref<string | null>(null)
const clearing = ref(false)
const clearDialog = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
let clearFocusOrigin: HTMLElement | null = null

onMounted(() => { void refresh() })

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [nextSettings, nextRecords] = await Promise.all([
      window.terminalAgent.settings.memory.get(),
      window.terminalAgent.settings.memory.list(),
    ])
    settings.value = nextSettings
    records.value = nextRecords
  } catch {
    error.value = '无法加载本地主机记忆。'
  } finally {
    loading.value = false
  }
}

function scheduleSaveSettings(): void { void nextTick(saveSettings) }
async function saveSettings(): Promise<void> {
  try {
    settings.value = await window.terminalAgent.settings.memory.save({ enabled: settings.value.enabled, scopes: { ...settings.value.scopes } })
  } catch {
    error.value = '无法保存主机记忆设置。'
  }
}

function beginEdit(record: HostMemoryRecord): void {
  expanded.value = record.hostname
  editing.value = {
    hostname: record.hostname,
    observedAt: record.observedAt,
    connectionIp: record.connectionIp ?? '',
    operatingSystemName: record.operatingSystem?.name ?? '',
    operatingSystemVersion: record.operatingSystem?.version ?? '',
    cpuModel: record.cpu?.model ?? '',
    cpuArchitecture: record.cpu?.architecture ?? '',
    cpuLogicalCores: record.cpu?.logicalCores?.toString() ?? '',
    memoryTotalBytes: record.memory?.totalBytes.toString() ?? '',
    disks: (record.disks ?? []).map(disk => ({ name: disk.name, totalBytes: disk.totalBytes.toString() })),
    networkInterfaces: (record.networkInterfaces ?? []).map(item => ({ name: item.name, addresses: item.addresses.join('\n') })),
    processes: (record.processes ?? []).map(process => ({ name: process.name, pid: process.pid.toString(), workingDirectory: process.workingDirectory ?? '' })),
    currentUser: record.currentUser ?? '',
    workingDirectory: record.workingDirectory ?? '',
    services: Object.entries(record.services ?? {}).map(([name, status]) => ({ name, status })),
    legacySoftware: Object.entries(record.legacyFacts?.software ?? {}).map(([name, version]) => ({ name, version })),
    legacyInstallLocations: Object.entries(record.legacyFacts?.installLocations ?? {}).map(([name, path]) => ({ name, path })),
    legacyFacts: record.legacyFacts ? structuredClone(record.legacyFacts) : undefined,
  }
}

function cancelEdit(): void { editing.value = null }
function optional(value: string): string | undefined { const trimmed = value.trim(); return trimmed || undefined }
function positiveInteger(value: string): number | undefined {
  if (!value.trim()) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Number.NaN
}
function splitAddresses(value: string): string[] { return value.split(/[\s,]+/).map(item => item.trim()).filter(Boolean) }
function namedRecord<T extends { name: string }>(entries: T[], value: (entry: T) => string): Record<string, string> {
  const record: Record<string, string> = {}
  for (const entry of entries) {
    const name = entry.name.trim()
    if (!name || name in record) throw new Error('Host memory entry names must be unique')
    record[name] = value(entry).trim()
  }
  return record
}

function legacyFactsFromDraft(draft: HostMemoryDraft): HostMemoryRecord['legacyFacts'] {
  if (!draft.legacyFacts) return undefined
  const legacyFacts = {
    ...(draft.legacySoftware.length ? { software: namedRecord(draft.legacySoftware, entry => entry.version) } : {}),
    ...(draft.legacyFacts.processes ? { processes: draft.legacyFacts.processes.map(process => ({ ...process })) } : {}),
    ...(draft.legacyInstallLocations.length ? { installLocations: namedRecord(draft.legacyInstallLocations, entry => entry.path) } : {}),
    ...(draft.legacyFacts.services ? { services: { ...draft.legacyFacts.services } } : {}),
    ...(draft.legacyFacts.logLocations ? { logLocations: [...draft.legacyFacts.logLocations] } : {}),
    ...(draft.legacyFacts.configurationHashes ? { configurationHashes: { ...draft.legacyFacts.configurationHashes } } : {}),
  }
  return Object.keys(legacyFacts).length ? legacyFacts : undefined
}

function recordFromDraft(draft: HostMemoryDraft): HostMemoryRecord {
  const connectionIp = optional(draft.connectionIp)
  const operatingSystemName = optional(draft.operatingSystemName)
  const operatingSystemVersion = optional(draft.operatingSystemVersion)
  const cpuModel = optional(draft.cpuModel)
  const cpuArchitecture = optional(draft.cpuArchitecture)
  const cpuLogicalCores = positiveInteger(draft.cpuLogicalCores)
  const memoryTotalBytes = positiveInteger(draft.memoryTotalBytes)
  const legacyFacts = legacyFactsFromDraft(draft)
  const record = {
    hostname: draft.hostname,
    observedAt: draft.observedAt,
    ...(connectionIp ? { connectionIp } : {}),
    ...(operatingSystemName || operatingSystemVersion ? { operatingSystem: { name: operatingSystemName ?? '', ...(operatingSystemVersion ? { version: operatingSystemVersion } : {}) } } : {}),
    ...(cpuModel || cpuArchitecture || cpuLogicalCores !== undefined ? { cpu: { ...(cpuModel ? { model: cpuModel } : {}), ...(cpuArchitecture ? { architecture: cpuArchitecture } : {}), ...(cpuLogicalCores !== undefined ? { logicalCores: cpuLogicalCores } : {}) } } : {}),
    ...(memoryTotalBytes !== undefined ? { memory: { totalBytes: memoryTotalBytes } } : {}),
    ...(draft.disks.length ? { disks: draft.disks.map(disk => ({ name: disk.name.trim(), totalBytes: positiveInteger(disk.totalBytes) })) } : {}),
    ...(draft.networkInterfaces.length ? { networkInterfaces: draft.networkInterfaces.map(item => ({ name: item.name.trim(), addresses: splitAddresses(item.addresses) })) } : {}),
    ...(draft.processes.length ? { processes: draft.processes.map(process => {
      const workingDirectory = optional(process.workingDirectory)
      return { name: process.name.trim(), pid: positiveInteger(process.pid), ...(workingDirectory ? { workingDirectory } : {}) }
    }) } : {}),
    ...(optional(draft.currentUser) ? { currentUser: optional(draft.currentUser) } : {}),
    ...(optional(draft.workingDirectory) ? { workingDirectory: optional(draft.workingDirectory) } : {}),
    ...(draft.services.length ? { services: Object.fromEntries(draft.services.map(service => [service.name.trim(), service.status.trim()])) } : {}),
    ...(legacyFacts ? { legacyFacts } : {}),
  }
  return hostMemoryRecordSchema.parse(record)
}

async function saveEdit(): Promise<void> {
  if (!editing.value || savingEdit.value) return
  savingEdit.value = true
  error.value = ''
  try {
    const hostname = editing.value.hostname
    const saved = await window.terminalAgent.settings.memory.update(hostname, recordFromDraft(editing.value))
    records.value = records.value.map(item => item.hostname === saved.hostname ? saved : item)
    editing.value = null
  } catch {
    error.value = '主机事实必须是安全、完整的结构化数据。'
  } finally {
    savingEdit.value = false
  }
}

function addDisk(): void { editing.value?.disks.push({ name: '', totalBytes: '' }) }
function addNetworkInterface(): void { editing.value?.networkInterfaces.push({ name: '', addresses: '' }) }
function addProcess(): void { editing.value?.processes.push({ name: '', pid: '', workingDirectory: '' }) }
function addService(): void { editing.value?.services.push({ name: '', status: '' }) }
function addLegacySoftware(): void { editing.value?.legacySoftware.push({ name: '', version: '' }) }
function addLegacyInstallLocation(): void { editing.value?.legacyInstallLocations.push({ name: '', path: '' }) }

function toggleExpanded(hostname: string): void {
  if (editing.value?.hostname === hostname) return
  expanded.value = expanded.value === hostname ? null : hostname
}

function requestClear(hostname: string): void {
  clearFocusOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null
  clearTarget.value = hostname
  void nextTick(() => clearDialog.value?.querySelector<HTMLElement>('button:not([disabled])')?.focus())
}
function closeClearDialog(): void {
  if (clearing.value) return
  clearTarget.value = null
  void nextTick(() => {
    if (clearFocusOrigin?.isConnected) clearFocusOrigin.focus()
    else panel.value?.querySelector<HTMLElement>('button,[href],input,[tabindex]:not([tabindex="-1"])')?.focus()
  })
}
function clearFocusable(): HTMLElement[] { return clearDialog.value ? [...clearDialog.value.querySelectorAll<HTMLElement>('button,[href],input,[tabindex]:not([tabindex="-1"])')].filter(item => !item.hasAttribute('disabled')) : [] }
function onClearDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.preventDefault(); closeClearDialog(); return }
  if (event.key !== 'Tab') return
  const elements = clearFocusable()
  const first = elements[0]
  const last = elements.at(-1)
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
async function removeRecord(): Promise<void> {
  if (!clearTarget.value || clearing.value) return
  const hostname = clearTarget.value
  clearing.value = true
  try {
    await window.terminalAgent.settings.memory.remove(hostname)
    records.value = records.value.filter(record => record.hostname !== hostname)
    if (expanded.value === hostname) expanded.value = null
    if (editing.value?.hostname === hostname) editing.value = null
    clearing.value = false
    closeClearDialog()
  } catch {
    clearing.value = false
    error.value = '无法清除该主机记忆。'
  }
}

function formatBytes(value: number | undefined): string {
  if (!value) return '未记录'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let current = value
  let unit = 0
  while (current >= 1024 && unit < units.length - 1) { current /= 1024; unit += 1 }
  return `${current >= 10 || unit === 0 ? current.toFixed(0) : current.toFixed(1)} ${units[unit]}`
}
</script>

<template>
  <section ref="panel" class="settings-panel host-memory" aria-label="本地主机记忆设置">
    <header class="panel-head">
      <div><h2>本地主机记忆</h2><p>开启后，通过只读命令采集基础事实并保存在本机，用于后续聊天理解环境。每台新主机首次接入时会显示一次信息告知。</p></div>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <label class="memory-status memory-toggle">
      <span><strong>启用本地主机记忆</strong><small>新主机连接成功后显示告知；确认后执行只读采集。关闭后不采集、不保存。</small></span>
      <input v-model="settings.enabled" class="switch-input" type="checkbox" :disabled="loading" @change="scheduleSaveSettings">
      <span class="switch-control" :class="{ enabled: settings.enabled }" aria-hidden="true"><i /></span>
    </label>

    <fieldset class="collection" :disabled="loading">
      <legend>告知后将保存的内容</legend>
      <div class="scopes">
        <label class="scope-card"><input v-model="settings.scopes.identity" type="checkbox" @change="scheduleSaveSettings"><span><small>主机名、连接 IP、操作系统和基础版本</small></span></label>
        <label class="scope-card"><input v-model="settings.scopes.hardware" type="checkbox" @change="scheduleSaveSettings"><span><small>CPU、内存、磁盘、网络等基础信息</small></span></label>
        <label class="scope-card"><input v-model="settings.scopes.processes" type="checkbox" @change="scheduleSaveSettings"><span><small>运行进程名称、PID 和进程工作目录</small></span></label>
        <label class="scope-card"><input v-model="settings.scopes.runtime" type="checkbox" @change="scheduleSaveSettings"><span><small>当前用户、工作目录和常用服务状态</small></span></label>
      </div>
    </fieldset>
    <p class="privacy">不会保存密码、私钥、API Key、令牌、环境变量值、命令行或完整终端内容。所有记忆仅保存在本机，可逐台清除。</p>

    <section class="command-catalog" aria-labelledby="command-catalog-title">
      <div class="section-head">
        <div><h3 id="command-catalog-title">采集命令清单</h3><p>连接 Shell 后，点击“我已知道”才会按以下顺序执行。</p></div>
        <span>只读预制</span>
      </div>
      <ol>
        <li
          v-for="item in HOST_MEMORY_COMMANDS"
          :key="item.id"
          :class="{ disabled: item.scope && !settings.scopes[item.scope] }"
          :aria-disabled="item.scope ? !settings.scopes[item.scope] : false"
        >
          <span><strong>{{ item.label }}</strong><small>{{ item.required ? '始终执行' : item.scope && settings.scopes[item.scope] ? '将执行' : '当前不执行' }}</small></span>
          <code>{{ item.command }}</code>
        </li>
      </ol>
    </section>

    <section class="remembered-hosts" aria-labelledby="remembered-hosts-title">
      <div class="section-head"><div><h3 id="remembered-hosts-title">已建立记忆的主机</h3><p>展开主机可查看本地缓存的事实；进入编辑后可修正过期或识别错误的信息。</p></div><div class="section-head-actions"><span>{{ records.length }} 台</span><button type="button" class="refresh-button" :disabled="loading" aria-label="刷新主机记忆" title="刷新" @click="refresh"><RefreshCw :size="14" aria-hidden="true" /></button></div></div>
      <p v-if="loading">正在加载...</p>
      <p v-else-if="!records.length" class="empty">尚无已告知主机的记忆。</p>
      <ul v-else class="host-list" aria-label="已记忆主机">
        <li v-for="record in records" :key="record.hostname">
          <div class="host-row">
            <div class="host-identity"><strong>{{ record.hostname }}</strong><small>{{ summarizeHostMemoryRecord(record) }}</small></div>
            <span>{{ record.connectionIp ?? '未记录连接 IP' }}</span>
            <time :datetime="record.observedAt">{{ record.observedAt }}</time>
            <button type="button" :aria-expanded="expanded === record.hostname" @click="toggleExpanded(record.hostname)">{{ expanded === record.hostname ? '收起缓存' : '查看缓存' }}</button>
            <button type="button" class="danger" @click="requestClear(record.hostname)">清除</button>
          </div>

          <div v-if="expanded === record.hostname" class="memory-detail">
            <template v-if="editing?.hostname !== record.hostname">
              <div class="detail-head"><div><strong>{{ record.hostname }} 的本地记忆</strong><span>最近观察：{{ record.observedAt }}</span></div><span>只读查看</span></div>
              <section class="fact-section" aria-label="身份事实"><h4>身份</h4><dl class="fact-grid"><div><dt>主机名</dt><dd>{{ record.hostname }}</dd></div><div><dt>连接 IP</dt><dd>{{ record.connectionIp ?? '未记录' }}</dd></div><div><dt>操作系统</dt><dd>{{ record.operatingSystem?.name ?? '未记录' }}{{ record.operatingSystem?.version ? ` ${record.operatingSystem.version}` : '' }}</dd></div></dl></section>
              <section class="fact-section" aria-label="硬件事实"><h4>硬件</h4><dl class="fact-grid"><div><dt>CPU 型号</dt><dd>{{ record.cpu?.model ?? '未记录' }}</dd></div><div><dt>CPU 架构</dt><dd>{{ record.cpu?.architecture ?? '未记录' }}</dd></div><div><dt>逻辑核心</dt><dd>{{ record.cpu?.logicalCores ?? '未记录' }}</dd></div><div><dt>内存总量</dt><dd>{{ formatBytes(record.memory?.totalBytes) }}</dd></div></dl><table v-if="record.disks?.length"><caption>磁盘</caption><thead><tr><th>名称</th><th>总量</th></tr></thead><tbody><tr v-for="disk in record.disks" :key="disk.name"><td>{{ disk.name }}</td><td>{{ formatBytes(disk.totalBytes) }}</td></tr></tbody></table><table v-if="record.networkInterfaces?.length"><caption>网络接口</caption><thead><tr><th>名称</th><th>地址</th></tr></thead><tbody><tr v-for="item in record.networkInterfaces" :key="item.name"><td>{{ item.name }}</td><td>{{ item.addresses.join('、') || '未记录' }}</td></tr></tbody></table></section>
              <section class="fact-section" aria-label="进程事实"><h4>进程</h4><table v-if="record.processes?.length"><thead><tr><th>进程名称</th><th>进程 PID</th><th>进程工作目录</th></tr></thead><tbody><tr v-for="process in record.processes" :key="`${process.pid}:${process.name}`"><td>{{ process.name }}</td><td>{{ process.pid }}</td><td>{{ process.workingDirectory ?? '未记录' }}</td></tr></tbody></table><p v-else>未记录进程。</p></section>
              <section class="fact-section" aria-label="运行环境事实"><h4>运行环境</h4><dl class="fact-grid"><div><dt>当前用户</dt><dd>{{ record.currentUser ?? '未记录' }}</dd></div><div><dt>工作目录</dt><dd>{{ record.workingDirectory ?? '未记录' }}</dd></div></dl><table v-if="record.services && Object.keys(record.services).length"><thead><tr><th>服务名称</th><th>服务状态</th></tr></thead><tbody><tr v-for="(status, name) in record.services" :key="name"><td>{{ name }}</td><td>{{ status }}</td></tr></tbody></table></section>
              <section v-if="record.legacyFacts" class="fact-section" aria-label="迁移保留事实"><h4>迁移保留事实</h4><table v-if="record.legacyFacts.software"><caption>软件版本</caption><thead><tr><th>软件</th><th>版本</th></tr></thead><tbody><tr v-for="(version, name) in record.legacyFacts.software" :key="name"><td>{{ name }}</td><td>{{ version }}</td></tr></tbody></table><table v-if="record.legacyFacts.installLocations"><caption>安装目录</caption><thead><tr><th>软件</th><th>目录</th></tr></thead><tbody><tr v-for="(path, name) in record.legacyFacts.installLocations" :key="name"><td>{{ name }}</td><td>{{ path }}</td></tr></tbody></table><table v-if="record.legacyFacts.processes"><caption>旧进程状态</caption><thead><tr><th>进程名称</th><th>状态</th></tr></thead><tbody><tr v-for="process in record.legacyFacts.processes" :key="`${process.name}:${process.status}`"><td>{{ process.name }}</td><td>{{ process.status }}</td></tr></tbody></table><table v-if="record.legacyFacts.logLocations"><caption>日志位置</caption><tbody><tr v-for="path in record.legacyFacts.logLocations" :key="path"><td>{{ path }}</td></tr></tbody></table><table v-if="record.legacyFacts.configurationHashes"><caption>配置哈希</caption><thead><tr><th>路径</th><th>SHA-256</th></tr></thead><tbody><tr v-for="(hash, path) in record.legacyFacts.configurationHashes" :key="path"><td>{{ path }}</td><td>{{ hash }}</td></tr></tbody></table></section>
              <div class="detail-actions"><button type="button" @click="beginEdit(record)">编辑</button></div>
            </template>

            <form v-else class="editor" aria-label="编辑主机记忆" @submit.prevent="saveEdit">
              <div class="detail-head"><div><strong>编辑 {{ editing.hostname }}</strong><span>主机名和观察时间不可修改。</span></div><span>结构化编辑</span></div>
              <fieldset><legend>身份</legend><div class="form-grid"><label>主机名<input :value="editing.hostname" readonly></label><label>连接 IP<input v-model.trim="editing.connectionIp" inputmode="text"></label><label>操作系统<input v-model.trim="editing.operatingSystemName"></label><label>基础版本<input v-model.trim="editing.operatingSystemVersion"></label></div></fieldset>
              <fieldset><legend>硬件</legend><div class="form-grid"><label>CPU 型号<input v-model.trim="editing.cpuModel"></label><label>CPU 架构<input v-model.trim="editing.cpuArchitecture"></label><label>逻辑核心数<input v-model.trim="editing.cpuLogicalCores" type="number" min="1" step="1"></label><label>内存总量（字节）<input v-model.trim="editing.memoryTotalBytes" type="number" min="1" step="1"></label></div><div class="repeat-group"><div class="repeat-head"><strong>磁盘</strong><button type="button" @click="addDisk">添加磁盘</button></div><div v-for="(disk, index) in editing.disks" :key="index" class="repeat-row"><label>磁盘名称<input v-model.trim="disk.name"></label><label>磁盘总量（字节）<input v-model.trim="disk.totalBytes" type="number" min="1" step="1"></label><button type="button" :aria-label="`移除磁盘 ${index + 1}`" @click="editing.disks.splice(index, 1)">移除</button></div></div><div class="repeat-group"><div class="repeat-head"><strong>网络接口</strong><button type="button" @click="addNetworkInterface">添加网络接口</button></div><div v-for="(item, index) in editing.networkInterfaces" :key="index" class="repeat-row network-row"><label>接口名称<input v-model.trim="item.name"></label><label>接口地址<textarea v-model.trim="item.addresses" rows="2" /></label><button type="button" :aria-label="`移除网络接口 ${index + 1}`" @click="editing.networkInterfaces.splice(index, 1)">移除</button></div></div></fieldset>
              <fieldset><legend>进程</legend><div class="repeat-head"><span>已记录 {{ editing.processes.length }} 个进程</span><button type="button" @click="addProcess">添加进程</button></div><div v-for="(process, index) in editing.processes" :key="index" class="repeat-row process-row"><label>进程名称<input v-model.trim="process.name"></label><label>进程 PID<input v-model.trim="process.pid" type="number" min="1" step="1"></label><label>进程工作目录<input v-model.trim="process.workingDirectory"></label><button type="button" :aria-label="`移除进程 ${index + 1}`" @click="editing.processes.splice(index, 1)">移除</button></div></fieldset>
              <fieldset><legend>运行环境</legend><div class="form-grid"><label>当前用户<input v-model.trim="editing.currentUser"></label><label>工作目录<input v-model.trim="editing.workingDirectory"></label></div><div class="repeat-group"><div class="repeat-head"><strong>常用服务</strong><button type="button" @click="addService">添加服务</button></div><div v-for="(service, index) in editing.services" :key="index" class="repeat-row"><label>服务名称<input v-model.trim="service.name"></label><label>服务状态<input v-model.trim="service.status"></label><button type="button" :aria-label="`移除服务 ${index + 1}`" @click="editing.services.splice(index, 1)">移除</button></div></div></fieldset>
              <fieldset v-if="editing.legacyFacts"><legend>迁移保留事实</legend><div class="repeat-group"><div class="repeat-head"><strong>软件版本</strong><button type="button" @click="addLegacySoftware">添加软件版本</button></div><div v-for="(software, index) in editing.legacySoftware" :key="index" class="repeat-row"><label>软件名称<input v-model.trim="software.name"></label><label>软件版本<input v-model.trim="software.version"></label><button type="button" :aria-label="`移除软件版本 ${index + 1}`" @click="editing.legacySoftware.splice(index, 1)">移除</button></div></div><div class="repeat-group"><div class="repeat-head"><strong>安装目录</strong><button type="button" @click="addLegacyInstallLocation">添加安装目录</button></div><div v-for="(location, index) in editing.legacyInstallLocations" :key="index" class="repeat-row"><label>软件名称<input v-model.trim="location.name"></label><label>安装目录<input v-model.trim="location.path"></label><button type="button" :aria-label="`移除安装目录 ${index + 1}`" @click="editing.legacyInstallLocations.splice(index, 1)">移除</button></div></div><p>无 PID 的旧进程状态及其他迁移数据继续按原结构保留。</p></fieldset>
              <div class="detail-actions"><button type="button" :disabled="savingEdit" @click="cancelEdit">取消</button><button type="submit" :disabled="savingEdit">{{ savingEdit ? '正在保存...' : '保存' }}</button></div>
            </form>
          </div>
        </li>
      </ul>
    </section>

    <div class="settings-actions"><button type="button" class="primary-button" :disabled="loading" @click="saveSettings">保存记忆设置</button></div>

    <div v-if="clearTarget" ref="clearDialog" class="confirm" role="dialog" aria-modal="true" aria-label="确认清除主机记忆" :aria-busy="clearing" @keydown.capture="onClearDialogKeydown">
      <p>确认清除 {{ clearTarget }} 的本地主机记忆？</p><div><button type="button" :disabled="clearing" @click="removeRecord">{{ clearing ? '正在清除...' : '确认清除' }}</button><button type="button" :disabled="clearing" @click="closeClearDialog">取消</button></div>
    </div>
  </section>
</template>

<style scoped>
.host-memory { display: grid; gap: 16px; min-width: 0; }
.host-memory h2,.host-memory h3,.host-memory h4,.host-memory p { margin: 0; }
.panel-head,.section-head,.host-row,.detail-head,.detail-actions,.repeat-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.panel-head > div,.section-head > div,.host-identity,.detail-head > div { display: grid; gap: 4px; min-width: 0; }
.panel-head p,.section-head p,.privacy,.detail-head span,.host-identity small { color: var(--muted); font-size: 11px; line-height: 1.5; }
button { min-height: 30px; padding: 0 10px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text); font-size: 11px; }
button:not(:disabled) { cursor: pointer; } button:disabled { opacity: .55; }button:hover:not(:disabled) { border-color: var(--focus); background: var(--hover); color: var(--text-strong); }
.memory-toggle { display: flex; align-items: center; justify-content: space-between; gap: 18px; min-width: 0; padding: 13px 14px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); cursor: pointer; }.memory-toggle > span:first-child { display: grid; gap: 4px; min-width: 0; }.memory-toggle strong { color: var(--text-strong); font-size: 11px; }.memory-toggle small { color: var(--muted); font-size: 10px; line-height: 1.45; }.switch-input { position: absolute; width: 1px; height: 1px; opacity: 0; }.switch-control { box-sizing: border-box; width: 42px; height: 23px; flex: 0 0 auto; padding: 2px; border: 1px solid var(--line); border-radius: 999px; background: var(--line); transition: background .15s,border-color .15s; }.switch-control i { display: block; width: 17px; height: 17px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgb(19 27 36 / 22%); transition: transform .15s; }.switch-control.enabled { border-color: var(--accent); background: var(--accent); }.switch-control.enabled i { transform: translateX(17px); }.switch-input:focus-visible + .switch-control { box-shadow: 0 0 0 3px var(--accent-soft); }
.collection { display: grid; gap: 10px; min-width: 0; margin: 0; padding: 0; border: 0; }.collection legend,.editor legend { padding: 0; color: var(--text-strong); font-size: 11px; font-weight: 700; }
.scopes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); overflow: hidden; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); }
.scopes label { display: flex; align-items: flex-start; gap: 8px; min-width: 0; color: var(--text); font-size: 11px; line-height: 1.4; }
.scopes input { width: 15px; height: 15px; margin-top: 1px; accent-color: var(--accent); }
.scope-card { min-height: 46px; padding: 11px 12px; border: 0; border-radius: 0; background: transparent; }.scope-card:nth-child(odd) { border-right: 1px solid var(--line); }.scope-card:nth-child(-n+2) { border-bottom: 1px solid var(--line); }.scope-card > span { display: grid; min-width: 0; }.scope-card small { color: var(--text); font-size: 10px; line-height: 1.4; }
.privacy { color: var(--muted); font-size: 10px; }
.command-catalog,.remembered-hosts { display: grid; gap: 10px; min-width: 0; padding-top: 14px; border-top: 1px solid var(--line); }
.command-catalog > .section-head > span { flex: 0 0 auto; color: var(--muted); font-size: 10px; }
.command-catalog ol { margin: 0; padding: 0; border-bottom: 1px solid var(--line); list-style: none; }
.command-catalog li { display: grid; grid-template-columns: minmax(130px, .34fr) minmax(0, 1fr); gap: 10px; min-width: 0; padding: 8px 0; border-top: 1px solid var(--line); }
.command-catalog li > span { display: grid; align-content: start; gap: 2px; min-width: 0; }
.command-catalog li strong { color: var(--text-strong); font-size: 10px; }.command-catalog li small { color: var(--accent); font-size: 9px; }
.command-catalog li.disabled strong,.command-catalog li.disabled code { color: var(--muted); }.command-catalog li.disabled small { color: var(--faint); }
.command-catalog code { min-width: 0; padding: 5px 7px; overflow-wrap: anywhere; border-radius: 3px; background: var(--surface-soft); color: var(--text); font: 9px/1.45 "Cascadia Mono",Consolas,monospace; white-space: pre-wrap; }
.section-head-actions { display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: 10px; }.refresh-button { width: 28px; padding: 0; }
.empty { padding: 18px 0; color: var(--muted); text-align: center; }
.host-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.host-list > li { min-width: 0; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); }
.host-row { display: grid; grid-template-columns: minmax(150px, 1.2fr) minmax(110px, .8fr) minmax(155px, .9fr) auto auto; min-width: 0; padding: 10px; }
.host-row > span,.host-row time { min-width: 0; overflow: hidden; color: var(--muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.host-identity strong { overflow: hidden; color: var(--text-strong); text-overflow: ellipsis; white-space: nowrap; }
.danger { border-color: color-mix(in srgb, var(--red) 60%, var(--line)); color: var(--red); }
.settings-actions { display: flex; align-items: center; }.primary-button { border-color: var(--accent); background: var(--accent); color: #fff; font-weight: 650; }.primary-button:hover:not(:disabled) { background: color-mix(in srgb,var(--accent) 88%,#000); color: #fff; }
.memory-detail { display: grid; gap: 12px; padding: 12px; border-top: 1px solid var(--line); background: var(--surface-soft); }
.detail-head > span { flex: 0 0 auto; }
.fact-section { display: grid; gap: 8px; min-width: 0; }
.fact-section h4 { color: var(--text-strong); font-size: 11px; }
.fact-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px 12px; margin: 0; }
.fact-grid > div { display: grid; grid-template-columns: minmax(92px, .45fr) minmax(0, 1fr); gap: 8px; min-width: 0; }
.fact-grid dt { color: var(--muted); font-size: 10px; }.fact-grid dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: var(--text); font-size: 11px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 10px; } caption { padding: 4px 0; color: var(--muted); text-align: left; } th,td { padding: 6px; overflow-wrap: anywhere; border-bottom: 1px solid var(--line); text-align: left; } th { color: var(--muted); font-weight: 650; }
.detail-actions { justify-content: flex-end; }
.editor { display: grid; gap: 12px; }.editor fieldset { display: grid; gap: 9px; min-width: 0; margin: 0; padding: 10px; border: 1px solid var(--line); border-radius: 5px; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; }
.form-grid label,.repeat-row label { display: grid; gap: 4px; min-width: 0; color: var(--muted); font-size: 10px; }
input,textarea { box-sizing: border-box; width: 100%; min-width: 0; border: 1px solid var(--line); border-radius: 4px; outline: 0; background: var(--surface); color: var(--text); font: 11px/1.4 Inter,"Segoe UI",sans-serif; }
input { height: 31px; padding: 0 8px; } textarea { resize: vertical; padding: 7px 8px; }
input:focus,textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
input[readonly] { background: var(--surface-soft); color: var(--muted); }
.repeat-group { display: grid; gap: 7px; }.repeat-head { min-height: 30px; }.repeat-head strong,.repeat-head span { color: var(--text-strong); font-size: 10px; }
.repeat-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; align-items: end; gap: 8px; min-width: 0; }
.process-row { grid-template-columns: minmax(110px, .8fr) minmax(80px, .4fr) minmax(150px, 1.4fr) auto; }.network-row { grid-template-columns: minmax(110px, .6fr) minmax(180px, 1.4fr) auto; }
.error { color: var(--red); font-size: 11px; }
.confirm { position: fixed; z-index: 40; inset: 0; display: grid; place-content: center; gap: 12px; padding: 24px; background: rgb(15 23 35 / 48%); }
.confirm > p,.confirm > div { box-sizing: border-box; width: min(420px, calc(100vw - 48px)); }.confirm > p { padding: 18px 18px 0; border: 1px solid var(--line); border-bottom: 0; border-radius: 6px 6px 0 0; background: var(--surface); }.confirm > div { display: flex; justify-content: flex-end; gap: 8px; margin-top: -12px; padding: 14px 18px 18px; border: 1px solid var(--line); border-top: 0; border-radius: 0 0 6px 6px; background: var(--surface); }
@media (max-width: 760px) { .scopes,.form-grid,.fact-grid,.command-catalog li { grid-template-columns: 1fr; }.scope-card:nth-child(odd) { border-right: 0; }.scope-card:nth-child(-n+3) { border-bottom: 1px solid var(--line); }.host-row { grid-template-columns: minmax(0, 1fr) auto auto; }.host-row > span,.host-row time { grid-column: 1 / -1; }.repeat-row,.process-row,.network-row { grid-template-columns: 1fr; }.repeat-row > button { justify-self: end; } }
</style>
