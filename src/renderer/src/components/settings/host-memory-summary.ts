import type { HostMemoryRecord } from '../../../../shared/contracts'

export function summarizeHostMemoryRecord(record: HostMemoryRecord): string {
  const categories: Array<[string, number]> = [
    ['身份', 1 + Number(Boolean(record.connectionIp)) + Number(Boolean(record.operatingSystem))],
    ['硬件', Number(Boolean(record.cpu)) + Number(Boolean(record.memory)) + (record.disks?.length ?? 0) + (record.networkInterfaces?.length ?? 0)],
    ['进程', record.processes?.length ?? 0],
    ['运行环境', Number(Boolean(record.currentUser)) + Number(Boolean(record.workingDirectory)) + Object.keys(record.services ?? {}).length],
  ]
  const parts = categories.filter(([, count]) => count > 0).map(([label, count]) => `${label} ${count} 项`)
  return parts.length > 0 ? parts.join('；') : '尚无已采集事实'
}
