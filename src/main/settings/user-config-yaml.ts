import { Document, isMap, isNode, isScalar, isSeq, parseDocument, type Node } from 'yaml'
import type { AtomicJsonStoreCodec } from '../persistence/atomic-json-store'

const invalidYamlMessage = 'AtomicJsonStore could not read valid YAML data'

/**
 * YAML is deliberately limited to a single, strict YAML 1.2 document.  The
 * document is then still validated by the owning Zod schema in AtomicJsonStore.
 */
export const userConfigYamlCodec: AtomicJsonStoreCodec = {
  parse: parseUserConfigYaml,
  stringify: stringifyUserConfigYaml,
  invalidDataMessage: invalidYamlMessage,
}

export function parseUserConfigYaml(source: string): unknown {
  const document = parseDocument(source, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
    version: '1.2',
  })
  if (document.errors.length > 0) {
    throw new Error(document.errors.map(error => error.message).join('\n'))
  }
  return document.toJS({ maxAliasCount: 100 })
}

/**
 * Write a readable, stable configuration document.  Known fields are
 * documented in Chinese, while forward-compatible fields retain their values
 * and receive a generic explanation instead of being silently dropped.
 */
export function stringifyUserConfigYaml(value: unknown): string {
  const document = new Document(value, { aliasDuplicateObjects: false, version: '1.2' })
  document.commentBefore = ' Terminal-Agent 用户配置文件。请按需修改各字段的值。'
  annotateFields(document.contents, [])
  return document.toString({
    indent: 2,
    lineWidth: 0,
    minContentWidth: 0,
  })
}

function annotateFields(node: Node | null, path: readonly string[]): void {
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = scalarKey(pair.key)
      if (key === undefined) continue
      if (isNode(pair.key)) pair.key.commentBefore = ` ${commentFor([...path, key])}`
      annotateFields(isNode(pair.value) ? pair.value : null, [...path, key])
    }
    return
  }

  if (isSeq(node)) {
    for (const item of node.items) {
      annotateFields(isNode(item) ? item : null, [...path, '[]'])
    }
  }
}

function scalarKey(value: unknown): string | undefined {
  if (!isScalar(value)) return undefined
  return typeof value.value === 'string' ? value.value : undefined
}

function commentFor(path: readonly string[]): string {
  return fieldComments[path.join('.')] ?? '保留的扩展配置字段。'
}

const fieldComments: Record<string, string> = {
  version: '用户配置文件格式版本，请勿手动修改。',
  sso: '单点登录配置。',
  'sso.enabled': '是否启用单点登录。',
  'sso.loginPageUrl': '单点登录页面地址。',
  'sso.platformUrlMatcher': '平台请求地址匹配规则。',
  'sso.platformUrlMatcher.mode': '平台地址匹配方式：exact、prefix 或 regex。',
  'sso.platformUrlMatcher.value': '平台地址匹配内容。',
  'sso.userInfoUrlMatcher': '用户信息请求地址匹配规则。',
  'sso.userInfoUrlMatcher.mode': '用户信息地址匹配方式：exact、prefix 或 regex。',
  'sso.userInfoUrlMatcher.value': '用户信息地址匹配内容。',
  'sso.employeeIdField': '用户信息响应中员工编号的字段路径。',
  'sso.nameField': '用户信息响应中姓名的字段路径。',
  models: '大语言模型和视觉语言模型配置。',
  'models.version': '模型配置格式版本，请勿手动修改。',
  'models.profiles': '可用模型配置列表。',
  'models.profiles.[].id': '模型配置唯一标识。',
  'models.profiles.[].name': '模型配置显示名称。',
  'models.profiles.[].kind': '模型类型：llm 或 vlm。',
  'models.profiles.[].provider': '模型服务提供方。',
  'models.profiles.[].model': '调用的模型名称。',
  'models.profiles.[].endpoint': '模型服务的 Chat Completions 接口地址。',
  'models.profiles.[].contextLimit': 'LLM 上下文长度上限。',
  'models.profiles.[].maxImages': 'VLM 单次请求允许的最大图片数量。',
  'models.profiles.[].apiKey': '模型服务 API 密钥，请妥善保管。',
  'models.activeLlmId': '当前启用的大语言模型配置标识；null 表示未选择。',
  'models.activeVlmId': '当前启用的视觉语言模型配置标识；null 表示未选择。',
  'models.autoActivateLlm': '新增可用 LLM 时是否自动启用。',
  'models.autoActivateVlm': '新增可用 VLM 时是否自动启用。',
  'models.routing': '模型路由策略。',
  'models.migrations': '历史配置迁移状态，请勿手动修改。',
  'models.migrations.legacyModelSettings': '旧版单模型设置已迁移的标记。',
  'models.migrations.legacyModelProfiles': '旧版模型配置列表已迁移的标记。',
  'models.migrations.legacyModelProfileId': '由旧版单模型设置迁移出的配置标识。',
  'models.migrations.apiKeyReferences': '等待迁移 API 密钥引用的关系列表。',
  'models.migrations.apiKeyReferences.[].sourceProfileId': 'API 密钥来源模型配置标识。',
  'models.migrations.apiKeyReferences.[].targetProfileId': 'API 密钥目标模型配置标识。',
}
