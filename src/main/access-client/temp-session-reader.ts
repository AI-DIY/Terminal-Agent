import { readFile as readFileFromDisk } from 'node:fs/promises'
import { parsePort } from './argv-parser'
import { AccessClientLaunchFailure } from './launch-failure'

export type TemporarySessionProfile = {
  host: string
  port: number
  username: string
  protocol: 'ssh' | 'raw'
  title: string
  columns: number
  rows: number
  lineCodePage?: string
}

type FileReader = (path: string) => Promise<Buffer>

const allowedKeys = new Set(['HostName', 'PortNumber', 'UserName', 'Protocol', 'WinTitle', 'TermWidth', 'TermHeight', 'LineCodePage'])

export async function readTempSession(path: string, readFile: FileReader = readFileFromDisk): Promise<TemporarySessionProfile> {
  let content: Buffer
  try {
    content = await readFile(path)
  } catch {
    throw new AccessClientLaunchFailure('temporary-profile-unreadable')
  }

  const values = new Map<string, string>()
  for (const line of content.toString('utf8').split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator)
    if (allowedKeys.has(key)) values.set(key, line.slice(separator + 1))
  }

  const host = values.get('HostName')?.trim() ?? ''
  const username = values.get('UserName')?.trim() ?? ''
  const protocol = values.get('Protocol')?.trim().toLowerCase()
  if (protocol !== 'ssh' && protocol !== 'raw') throw invalidTemporaryProfile()
  if (protocol === 'ssh' && (!host || !username)) throw invalidTemporaryProfile()

  let columns: number
  let rows: number
  let port: number
  try {
    columns = parseDimension(values.get('TermWidth'), 80, 'TermWidth')
    rows = parseDimension(values.get('TermHeight'), 24, 'TermHeight')
    port = parsePort(values.get('PortNumber'))
  } catch {
    throw invalidTemporaryProfile()
  }
  return {
    host,
    port,
    username,
    protocol,
    title: values.get('WinTitle')?.trim() || host || (protocol === 'raw' ? `Raw ${port}` : host),
    columns,
    rows,
    ...(values.get('LineCodePage')?.trim() ? { lineCodePage: values.get('LineCodePage')?.trim() } : {}),
  }
}

function parseDimension(value: string | undefined, fallback: number, field: string): number {
  if (value === undefined || value.trim() === '') return fallback
  const dimension = Number(value)
  if (!Number.isInteger(dimension) || dimension < 1 || dimension > 500) throw new Error(`Invalid ${field}`)
  return dimension
}

function invalidTemporaryProfile(): AccessClientLaunchFailure {
  return new AccessClientLaunchFailure('temporary-profile-invalid')
}
