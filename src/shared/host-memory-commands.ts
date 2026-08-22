import type { HostMemoryScope, HostMemoryScopes } from './contracts'

export type HostMemoryCommand = Readonly<{
  id: string
  scope: HostMemoryScope | null
  label: string
  command: string
  required?: true
}>

export const linuxCpuModelCommand = 'awk -F: \'/^model name[[:space:]]*:/ { sub(/^[[:space:]]+/, "", $2); print $2; exit }\' /proc/cpuinfo'
export const linuxMemoryCommand = 'awk \'/^MemTotal:/ { print $2; exit }\' /proc/meminfo'
export const linuxDiskCommand = 'lsblk -b -dn -o NAME,SIZE,TYPE | head -n 64'
export const linuxNetworkCommand = 'ip -o addr show | head -n 128'
export const linuxProcessCommand = 'for p in /proc/[0-9]*; do [ -r "$p/comm" ] || continue; pid=${p##*/}; name=$(head -n 1 "$p/comm"); cwd=$(readlink "$p/cwd" 2>/dev/null || true); printf \'%s\\t%s\\t%s\\n\' "$pid" "$name" "$cwd"; done | head -n 200'
export const linuxServiceCommand = 'systemctl list-units --type=service --state=running,failed --no-pager --no-legend | head -n 128'

export const HOST_MEMORY_COMMANDS: readonly HostMemoryCommand[] = Object.freeze([
  { id: 'hostname', scope: null, label: '主机名（唯一存储键）', command: 'hostname', required: true },
  { id: 'os-name', scope: 'identity', label: '操作系统', command: 'uname -s' },
  { id: 'os-version', scope: 'identity', label: '系统版本', command: 'uname -r' },
  { id: 'cpu-model', scope: 'hardware', label: 'CPU 型号', command: linuxCpuModelCommand },
  { id: 'cpu-architecture', scope: 'hardware', label: 'CPU 架构', command: 'uname -m' },
  { id: 'cpu-cores', scope: 'hardware', label: '逻辑核心数', command: 'getconf _NPROCESSORS_ONLN' },
  { id: 'memory', scope: 'hardware', label: '内存总量', command: linuxMemoryCommand },
  { id: 'disks', scope: 'hardware', label: '磁盘', command: linuxDiskCommand },
  { id: 'network', scope: 'hardware', label: '网络接口', command: linuxNetworkCommand },
  { id: 'processes', scope: 'processes', label: '运行进程', command: linuxProcessCommand },
  { id: 'current-user', scope: 'runtime', label: '当前用户', command: 'id -un' },
  { id: 'working-directory', scope: 'runtime', label: '工作目录', command: 'pwd -P' },
  { id: 'services', scope: 'runtime', label: '服务状态', command: linuxServiceCommand },
])

export function hostMemoryCommandsForScopes(scopes: HostMemoryScopes): readonly HostMemoryCommand[] {
  return HOST_MEMORY_COMMANDS.filter(item => item.scope === null || scopes[item.scope])
}
