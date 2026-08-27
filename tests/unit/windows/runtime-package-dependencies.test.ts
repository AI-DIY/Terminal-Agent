import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

type PackageManifest = {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

function readPackageManifest(packageName: string): PackageManifest {
  return require(`${packageName}/package.json`) as PackageManifest
}

describe('安装版运行时依赖', () => {
  it('将 LangGraph 运行时所需的非可选 peer 依赖声明为生产依赖', () => {
    const projectPackage = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as PackageManifest
    const langGraphPackages = [
      '@langchain/langgraph',
      '@langchain/langgraph-checkpoint',
      '@langchain/langgraph-sdk',
    ]
    const requiredPeers = new Set<string>()

    for (const packageName of langGraphPackages) {
      const manifest = readPackageManifest(packageName)
      for (const dependencyName of Object.keys(manifest.peerDependencies ?? {})) {
        if (!manifest.peerDependenciesMeta?.[dependencyName]?.optional) {
          requiredPeers.add(dependencyName)
        }
      }
    }

    expect([...requiredPeers].sort()).toEqual(['@langchain/core', 'zod'])
    for (const dependencyName of requiredPeers) {
      expect(projectPackage.dependencies).toHaveProperty(dependencyName)
    }
  })
})
