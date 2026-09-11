import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getLegacySsoConfigPath, getPreviousSsoConfigPath, getSsoConfigPath } from '../../../src/main/settings/sso-config-service'
import {
  configureTerminalAgentUserDataDirectory,
  migrateLegacyUserDataDirectory,
  type UserDataPathApp,
} from '../../../src/main/settings/user-data-directory'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function appWithPaths(homeDirectory: string, userDataDirectory: string): UserDataPathApp & { setPathCalls: string[] } {
  const app = {
    isPackaged: false,
    setPathCalls: [] as string[],
    getPath(name: 'home' | 'userData') {
      return name === 'home' ? homeDirectory : userDataDirectory
    },
    setPath(_name: 'userData', path: string) {
      this.setPathCalls.push(path)
    },
  }
  return app
}

describe('Terminal-Agent user data directory', () => {
  it('uses the home .terminal-agent directory and retains the previous Electron profile as a migration source', () => {
    const app = appWithPaths('C:\\Users\\Ada', 'C:\\Users\\Ada\\AppData\\Roaming\\terminal-agent-v2')

    const location = configureTerminalAgentUserDataDirectory({ app, environment: {}, argv: [], platform: 'win32' })

    expect(location).toEqual({
      homeDirectory: 'C:\\Users\\Ada',
      userConfigHomeDirectory: 'C:\\Users\\Ada',
      directory: 'C:\\Users\\Ada\\.terminal-agent',
      legacyDirectory: 'C:\\Users\\Ada\\AppData\\Roaming\\terminal-agent-v2',
    })
    expect(app.setPathCalls).toEqual(['C:\\Users\\Ada\\.terminal-agent'])
  })

  it('keeps an explicitly requested Electron profile isolated', () => {
    const app = appWithPaths('C:\\Users\\Ada', 'D:\\test-profile')

    const location = configureTerminalAgentUserDataDirectory({
      app,
      environment: {},
      argv: ['electron.exe', '--user-data-dir', 'D:\\test-profile'],
      platform: 'win32',
    })

    expect(location).toEqual({
      homeDirectory: 'C:\\Users\\Ada',
      userConfigHomeDirectory: 'D:\\test-profile',
      directory: 'D:\\test-profile',
    })
    expect(getSsoConfigPath(location.userConfigHomeDirectory ?? location.homeDirectory)).toBe('D:\\test-profile\\.terminal-agent\\user-config.yml')
    expect(getPreviousSsoConfigPath(location.userConfigHomeDirectory ?? location.homeDirectory)).toBe('D:\\test-profile\\.terminal-agent\\user-config')
    expect(getLegacySsoConfigPath(location.userConfigHomeDirectory ?? location.homeDirectory)).toBe('D:\\test-profile\\.ta\\user-config')
    expect(app.setPathCalls).toEqual([])
  })

  it('keeps E2E config and model migration sources inside the isolated test home', () => {
    const app = appWithPaths('C:\\Users\\Ada', 'D:\\e2e-profile')

    const location = configureTerminalAgentUserDataDirectory({
      app,
      environment: {
        TERMINAL_AGENT_E2E: '1',
        TERMINAL_AGENT_TEST_SSO_HOME: 'C:\\test-runs\\sso-home',
      },
      argv: ['electron.exe', '--user-data-dir=D:\\e2e-profile'],
      platform: 'win32',
    })

    expect(location).toEqual({
      homeDirectory: 'C:\\test-runs\\sso-home',
      userConfigHomeDirectory: 'C:\\test-runs\\sso-home',
      directory: 'D:\\e2e-profile',
    })
    expect(getSsoConfigPath(location.userConfigHomeDirectory ?? location.homeDirectory)).toBe('C:\\test-runs\\sso-home\\.terminal-agent\\user-config.yml')
    expect(getPreviousSsoConfigPath(location.userConfigHomeDirectory ?? location.homeDirectory)).toBe('C:\\test-runs\\sso-home\\.terminal-agent\\user-config')
    expect(getLegacySsoConfigPath(location.userConfigHomeDirectory ?? location.homeDirectory)).toBe('C:\\test-runs\\sso-home\\.ta\\user-config')
    expect(app.setPathCalls).toEqual([])
  })

  it('copies legacy files without overwriting canonical data and omits stale Chromium singleton files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-agent-user-data-'))
    temporaryDirectories.push(root)
    const legacy = join(root, 'legacy')
    const canonical = join(root, '.terminal-agent')
    await Promise.all([mkdir(join(legacy, 'Local Storage'), { recursive: true }), mkdir(canonical, { recursive: true })])
    await Promise.all([
      writeFile(join(legacy, 'chat-workspaces.json'), '{"legacy":true}', 'utf8'),
      writeFile(join(legacy, 'shell-history.json'), '{"history":true}', 'utf8'),
      writeFile(join(legacy, 'Local Storage', 'leveldb.data'), 'persisted browser data', 'utf8'),
      writeFile(join(legacy, 'SingletonLock'), 'stale lock', 'utf8'),
      writeFile(join(canonical, 'chat-workspaces.json'), '{"canonical":true}', 'utf8'),
    ])

    const migrated = await migrateLegacyUserDataDirectory({
      homeDirectory: root,
      directory: canonical,
      legacyDirectory: legacy,
    })

    expect(migrated).toBe(true)
    await expect(readFile(join(canonical, 'chat-workspaces.json'), 'utf8')).resolves.toBe('{"canonical":true}')
    await expect(readFile(join(canonical, 'shell-history.json'), 'utf8')).resolves.toBe('{"history":true}')
    await expect(readFile(join(canonical, 'Local Storage', 'leveldb.data'), 'utf8')).resolves.toBe('persisted browser data')
    await expect(readFile(join(canonical, 'SingletonLock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    await rm(join(canonical, 'shell-history.json'))
    await expect(migrateLegacyUserDataDirectory({
      homeDirectory: root,
      directory: canonical,
      legacyDirectory: legacy,
    })).resolves.toBe(false)
    await expect(readFile(join(canonical, 'shell-history.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retries a migration when the legacy directory was missing initially', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-agent-user-data-'))
    temporaryDirectories.push(root)
    const legacy = join(root, 'missing')
    const canonical = join(root, '.terminal-agent')
    const location = {
      homeDirectory: root,
      directory: canonical,
      legacyDirectory: legacy,
    }

    await expect(migrateLegacyUserDataDirectory(location)).resolves.toBe(false)
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'chat-workspaces.json'), '{"legacy":true}', 'utf8')
    await expect(migrateLegacyUserDataDirectory(location)).resolves.toBe(true)
    await expect(readFile(join(canonical, 'chat-workspaces.json'), 'utf8')).resolves.toBe('{"legacy":true}')
  })

  it('retries a migration after a copy failure without marking it complete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-agent-user-data-'))
    temporaryDirectories.push(root)
    const legacy = join(root, 'legacy')
    const canonical = join(root, '.terminal-agent')
    const location = {
      homeDirectory: root,
      directory: canonical,
      legacyDirectory: legacy,
    }
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'chat-workspaces.json'), '{"legacy":true}', 'utf8')

    await expect(migrateLegacyUserDataDirectory(location, {
      copy: async () => { throw new Error('copy interrupted') },
    })).rejects.toThrow('copy interrupted')
    await expect(migrateLegacyUserDataDirectory(location)).resolves.toBe(true)
    await expect(readFile(join(canonical, 'chat-workspaces.json'), 'utf8')).resolves.toBe('{"legacy":true}')
  })

  it('retries a migration when recording completion fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-agent-user-data-'))
    temporaryDirectories.push(root)
    const legacy = join(root, 'legacy')
    const canonical = join(root, '.terminal-agent')
    const location = {
      homeDirectory: root,
      directory: canonical,
      legacyDirectory: legacy,
    }
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'chat-workspaces.json'), '{"legacy":true}', 'utf8')

    await expect(migrateLegacyUserDataDirectory(location, {
      copy: (source, destination, options) => cp(source, destination, options),
      writeFile: async () => { throw new Error('marker write interrupted') },
    })).rejects.toThrow('marker write interrupted')
    await expect(migrateLegacyUserDataDirectory(location)).resolves.toBe(true)
  })
})
