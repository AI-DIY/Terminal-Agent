import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

type QuickInstallPackager = {
  packageQuickInstall(input: {
    projectRoot: string
    version: string
    releaseDirectory: string
    outputPath: string
  }): Promise<{ path: string; entries: string[]; bytes: number }>
}

const require = createRequire(import.meta.url)

function packager(): QuickInstallPackager {
  return require('../../../scripts/windows/package-quick-install.cjs') as QuickInstallPackager
}

async function seedRelease(projectRoot: string, version = '1.0.8') {
  const releaseDirectory = join(projectRoot, 'release')
  const imageDirectory = join(projectRoot, 'docs', 'images', 'quickstart')
  await mkdir(releaseDirectory, { recursive: true })
  await mkdir(imageDirectory, { recursive: true })
  await writeFile(join(releaseDirectory, 'putty.exe'), 'bridge')
  await writeFile(join(releaseDirectory, `Terminal-Agent-Setup-${version}.exe`), 'installer')
  await writeFile(join(projectRoot, '快速安装手册.md'), 'guide')
  await writeFile(join(projectRoot, '快速安装脚本.cmd'), '@echo off\r\n')
  await writeFile(join(projectRoot, 'quick-install.cmd'), '@echo off\r\n')
  await writeFile(join(imageDirectory, '06-select-global-putty.png'), 'session image')
  await writeFile(join(imageDirectory, '07-launch-bastion.png'), 'bastion image')
  return releaseDirectory
}

describe('Windows quick-install package', () => {
  it('keeps the source guide version-neutral and tied to the packaged screenshots', async () => {
    const guide = await readFile(join(process.cwd(), '快速安装手册.md'), 'utf8')
    const installer = await readFile(join(process.cwd(), 'quick-install.cmd'), 'utf8')

    expect(guide).toContain('# Terminal-Agent * 快速安装手册')
    expect(guide).toContain('Terminal-Agent-Setup-*.exe')
    expect(guide).toContain('Terminal-Agent-Quick-Install-*.zip')
    expect(guide).toContain('使用全局设置(putty)')
    expect(guide).toContain('集团堡垒机的正常流程指定目标主机并发起 SSH 连接')
    expect(guide).toContain('docs/images/quickstart/06-select-global-putty.png')
    expect(guide).toContain('docs/images/quickstart/07-launch-bastion.png')
    expect(guide).not.toMatch(/快速安装手册\.pdf|备份|恢复|常用参数|\/AccessClientDir|\/NoDownload|\/NoLaunch|\/NoPause|\b\d+\.\d+\.\d+\b/)
    expect(installer).toContain('快速安装手册.md')
    expect(installer).not.toContain('快速安装手册.pdf')
  })

  it('includes the Markdown guide and both referenced screenshots without the removed PDF', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'terminal-agent-quick-install-'))
    const version = '1.0.8'
    const outputPath = join(projectRoot, 'release', `Terminal-Agent-Quick-Install-${version}.zip`)

    try {
      const releaseDirectory = await seedRelease(projectRoot, version)
      const result = await packager().packageQuickInstall({ projectRoot, version, releaseDirectory, outputPath })
      const archive = await readFile(outputPath)
      const archiveText = archive.toString('utf8')

      expect(result.entries).toEqual([
        'putty.exe',
        `Terminal-Agent-Setup-${version}.exe`,
        '快速安装手册.md',
        '快速安装脚本.cmd',
        'quick-install.cmd',
        'docs/images/quickstart/06-select-global-putty.png',
        'docs/images/quickstart/07-launch-bastion.png',
      ])
      expect(result.bytes).toBeGreaterThan(0)
      expect(archiveText).toContain('快速安装手册.md')
      expect(archiveText).toContain('docs/images/quickstart/06-select-global-putty.png')
      expect(archiveText).toContain('docs/images/quickstart/07-launch-bastion.png')
      expect(archiveText).not.toContain('快速安装手册.pdf')
    }
    finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('fails closed when a guide screenshot is missing', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'terminal-agent-quick-install-'))
    const version = '1.0.8'

    try {
      const releaseDirectory = await seedRelease(projectRoot, version)
      await rm(join(projectRoot, 'docs', 'images', 'quickstart', '07-launch-bastion.png'))
      await expect(packager().packageQuickInstall({
        projectRoot,
        version,
        releaseDirectory,
        outputPath: join(releaseDirectory, 'missing-image.zip'),
      })).rejects.toThrow('07-launch-bastion.png')
    }
    finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})
