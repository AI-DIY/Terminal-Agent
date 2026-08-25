# 开源 Terminal-Agent 微调实施计划

> **供代理执行者使用：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，严格按任务逐项执行。所有执行步骤均使用复选框（`- [ ]`）跟踪。

**目标：** 在保留现有工作台布局、SSH 能力、本地凭据保护和单条候选命令审批机制的前提下，加入独立渲染 DevTools、自动附加主进程的独立 Node Inspector、任务命名/重命名/置顶、模型上下文原文直通、模型列表左对齐和低干扰任务滚动条，并生成 Windows `1.0.9` 安装包。

**架构：** 主进程新增集中式诊断控制器，统一拥有调试窗口、Node Inspector 端口和清理生命周期；任务继续使用现有 `AtomicJsonStore` 串行写入，但文档直接升级到不兼容旧数据的版本 2，并以 `titleState`、`pinnedAt` 明确表达状态。模型调用只移除发送前和回复展示链路的二次脱敏，API Key、SSH 凭据、桥接临时密码、Shell 历史保护、安全围栏和单条命令确认继续沿用现有实现。

**技术栈：** Electron 43、Node.js `node:inspector`、Vue 3、TypeScript 6、Zod 4、Vitest 4、Playwright Electron、Lucide Vue、electron-builder/NSIS、PowerShell。

---

## 文件结构与职责

- 新建 `src/main/diagnostics/diagnostics-controller.ts`：打开/复用分离渲染 DevTools，按需启停主进程 Inspector，构造内置调试前端 URL，并幂等清理资源。
- 新建 `src/main/diagnostics/register-diagnostics-handlers.ts`：注册两个无参数、只接受主窗口调用方的诊断 IPC。
- 新建 `tests/unit/diagnostics/diagnostics-controller.test.ts`：验证 Inspector 地址、窗口复用、所有权和失败回滚。
- 新建 `tests/unit/diagnostics/register-diagnostics-handlers.test.ts`：验证受信 IPC、零参数边界和注销行为。
- 新建 `tests/helpers/node-inspector-client.ts`：仅供 E2E 使用，通过 Inspector 协议执行只读表达式，证明独立前端已附加当前主进程。
- 修改 `src/main/main.ts`：实例化诊断控制器，接入快捷键、IPC、主窗口关闭和应用退出生命周期。
- 修改 `src/shared/contracts.ts`：公开任务标题状态、置顶时间、重命名/置顶/取消置顶请求契约；候选命令契约保持单条结构。
- 修改 `src/main/chat/chat-contracts.ts`：定义版本 2 任务文档和完整操作快照，明确拒绝其他持久化版本且不迁移。
- 修改 `src/main/chat/chat-repository.ts`：默认任务标题、首次活动自动改名、手动重命名、置顶/取消置顶及排序元数据持久化。
- 修改 `src/main/chat/chat-service.ts`、`src/main/chat/register-chat-handlers.ts`：发布重命名和置顶变化，注册受信 IPC。
- 修改 `src/preload/api.ts`：公开命名后的任务管理 API 和两个无参数诊断 API；现有 `src/preload/index.ts` 继续只暴露冻结后的命名 API，不增加 Electron 原始桥接。
- 修改 `src/renderer/src/stores/chat-workspaces.ts`：同步任务标题/置顶操作，生成置顶分组与普通日期分组。
- 修改 `src/renderer/src/components/workbench/WorkbenchSessionSidebar.vue`：任务文案、三点菜单、行内重命名、置顶状态和 Gemini 风格滚动条。
- 修改 `src/renderer/src/views/WorkbenchView.vue`：接线任务管理操作，加入设置、DevTools、Node Inspector 工具栏按钮和非阻塞诊断错误。
- 修改 `src/main/chat/chat-context-builder.ts`、`src/main/chat/chat-runtime.ts`：让 AI 工作区输入、上下文、流式增量和最终回复原文通过。
- 修改 `src/main/agent/execution-gateway.ts`：让仅驻留内存、仅来自已批准命令的审计标签保留原文，以便上下文构建器真正发送原始审计；执行授权与围栏不变。
- 修改 `src/main/agent/agent-model-runtime.ts`、`src/main/agent/register-agent-handlers.ts`：让 Shell AI 的目标、事实、分析、证据策略和单条候选命令原文通过，同时保留严格 JSON 与执行控制。
- 修改 `src/renderer/src/stores/global-chat.ts`：移除渲染端草稿、历史和流式回复的二次脱敏。
- 修改 `src/renderer/src/components/settings/ModelProfileManager.vue`：只覆盖模型连接项内部的左对齐规则。
- 修改 `tests/unit/**`、`tests/e2e/workbench.spec.ts`、`tests/e2e/settings.spec.ts`：提供契约、持久化、UI、诊断和安全边界回归证据。
- 修改 `README.md`、`README-en.md`、`RELEASE_NOTES.md`、`package.json`、`package-lock.json`：记录模型数据边界、诊断入口、任务交互和 `1.0.9` 发布版本。

## 全程不变的边界

- 不创建日志按钮、日志窗口、日志持久化服务或新的全业务日志埋点。
- 不增加命令组、多命令候选、候选删除或批量审批；`AgentCandidate.command` 继续只保存一个字符串。
- 不读取、转换或补写版本 1 任务数据；遇到旧文件直接显示“任务数据版本不兼容，请清空旧任务数据后重试”。
- 不移除 `src/main/agent/sensitive-data.ts`，也不削弱 Windows API Key 保护、SSH 凭据保护、桥接临时密码保护、Shell 历史敏感输入保护和基础设施错误净化。
- 不让渲染进程向诊断 IPC 传 URL、端口、WebSocket 地址或 `webContents` 标识。

### 任务 1：建立分支、提交设计基线并验证当前工程

**文件：**
- 检查：`docs/superpowers/specs/2026-08-24-open-source-ta-polish-design.md`
- 检查：`docs/superpowers/plans/2026-08-24-open-source-ta-polish.md`
- 检查：`package.json`
- 检查：`package-lock.json`

- [ ] **步骤 1：确认当前 Git 状态并创建实施分支**

运行：

```powershell
git status --short --branch
git switch -c codex/open-source-ta-polish
git branch --show-current
```

预期：最后一条命令输出 `codex/open-source-ta-polish`。如果仍出现 `.git/refs/heads/*.lock: Permission denied`，停止业务代码修改，先由有权限的环境恢复仓库 `.git` 写权限；不得在 `main` 上假装已经创建分支。

- [ ] **步骤 2：提交已确认的设计和计划文档**

运行：

```powershell
git add docs/superpowers/specs/2026-08-24-open-source-ta-polish-design.md docs/superpowers/plans/2026-08-24-open-source-ta-polish.md
git commit -m "docs: add open source polish design and plan"
git status --short
```

预期：提交成功且 `git status --short` 无输出。“提交 Git”在这里仅表示把两份已确认文档保存为可追溯的版本快照，不会发布到远程仓库，也不会修改应用行为。

- [ ] **步骤 3：按锁文件恢复依赖并运行基线**

运行：

```powershell
npm ci
npm test
npm run lint
npm run build
```

预期：四条命令退出码均为 0，`package-lock.json` 不发生变化。基线失败时使用 `superpowers:systematic-debugging` 确定是环境问题还是仓库已有问题，并在继续实施前留下可复现记录。

### 任务 2：扩展任务共享契约

**文件：**
- 修改：`src/shared/contracts.ts`
- 修改：`tests/unit/shared/contracts.test.ts`

- [ ] **步骤 1：为任务状态和严格管理请求编写失败测试**

在 `tests/unit/shared/contracts.test.ts` 增加：

```ts
import {
  chatPinRequestSchema,
  chatSummarySchema,
  chatTitleStateSchema,
  chatUnpinRequestSchema,
  chatUpdateTitleRequestSchema,
} from '../../../src/shared/contracts'

it('publishes explicit title and pin state while keeping management requests strict', () => {
  expect(chatTitleStateSchema.options).toEqual(['new', 'started', 'custom'])
  expect(chatSummarySchema.parse({
    id: 'task-1', title: '新建任务 2026-08-24 10:00:00', titleState: 'new', pinnedAt: null,
    createdAt: '2026-08-24T02:00:00.000Z', updatedAt: '2026-08-24T02:00:00.000Z',
    shellCount: 0, mode: 'copilot', live: false,
  })).toMatchObject({ titleState: 'new', pinnedAt: null })
  expect(chatUpdateTitleRequestSchema.parse({ requestId: 'rename-1', chatId: 'task-1', title: '  发布检查  ' }).title).toBe('发布检查')
  expect(chatPinRequestSchema.parse({ requestId: 'pin-1', chatId: 'task-1' })).toEqual({ requestId: 'pin-1', chatId: 'task-1' })
  expect(chatUnpinRequestSchema.parse({ requestId: 'unpin-1', chatId: 'task-1' })).toEqual({ requestId: 'unpin-1', chatId: 'task-1' })
  expect(() => chatUpdateTitleRequestSchema.parse({ requestId: 'rename-2', chatId: 'task-1', title: '   ' })).toThrow()
  expect(() => chatPinRequestSchema.parse({ requestId: 'pin-2', chatId: 'task-1', websocketUrl: 'ws://forged' })).toThrow()
})
```

同时把已有 `ChatSummary`/`ChatWorkspace` 固定值补上 `titleState: 'custom'` 和 `pinnedAt: null`，并把 `tests/unit/renderer/chat-workspaces.test.ts` 的 `summary()` 默认值改为：

```ts
return {
  updatedAt: overrides.createdAt,
  titleState: 'custom',
  pinnedAt: null,
  shellCount: 0,
  mode: 'copilot',
  live: false,
  ...overrides,
}
```

这能确保新增字段不能被静默省略，同时让旧用例只表达各自原本关注的行为。

- [ ] **步骤 2：运行测试并确认按预期失败**

运行：

```powershell
npx vitest run tests/unit/shared/contracts.test.ts
```

预期：失败原因为 `chatTitleStateSchema`、`chatPinRequestSchema`、`chatUnpinRequestSchema` 尚未导出，且现有 `chatSummarySchema` 不接受新增字段。

- [ ] **步骤 3：加入唯一的共享任务契约**

在 `src/shared/contracts.ts` 中定义并复用以下结构：

```ts
export const chatTitleStateSchema = z.enum(['new', 'started', 'custom'])
export type ChatTitleState = z.infer<typeof chatTitleStateSchema>

export const chatSummarySchema = z.object({
  id: chatIdentifierSchema,
  title: z.string().trim().min(1).max(255),
  titleState: chatTitleStateSchema,
  pinnedAt: chatTimestampSchema.nullable(),
  createdAt: chatTimestampSchema,
  updatedAt: chatTimestampSchema,
  shellCount: z.number().int().nonnegative(),
  mode: sessionModeSchema,
  live: z.boolean(),
}).strict()

const chatManagementRequestSchema = z.object({
  requestId: chatRequestIdSchema,
  chatId: chatIdentifierSchema,
}).strict()

export const chatUpdateTitleRequestSchema = chatManagementRequestSchema.extend({
  title: z.string().trim().min(1).max(255),
}).strict()
export const chatPinRequestSchema = chatManagementRequestSchema
export const chatUnpinRequestSchema = chatManagementRequestSchema
export type ChatPinRequest = z.infer<typeof chatPinRequestSchema>
export type ChatUnpinRequest = z.infer<typeof chatUnpinRequestSchema>
```

保留现有 `chatWorkspaceSchema = chatSummarySchema.extend(...)`，让工作区和变更事件自动携带这两个字段。不要修改 `agentProposalEventSchema`、`agentCandidateSchema` 或候选确认请求。

- [ ] **步骤 4：运行共享契约测试并提交**

运行：

```powershell
npx vitest run tests/unit/shared/contracts.test.ts tests/unit/preload/api.test.ts
git add src/shared/contracts.ts tests/unit/shared/contracts.test.ts
git commit -m "feat: add task title and pin contracts"
```

预期：测试通过；提交只包含共享契约和对应测试。

### 任务 3：建立不迁移的版本 2 任务文档

**文件：**
- 修改：`src/main/chat/chat-contracts.ts`
- 修改：`src/main/chat/chat-repository.ts`
- 修改：`tests/unit/chat/chat-contracts.test.ts`
- 修改：`tests/unit/chat/chat-repository.test.ts`

- [ ] **步骤 1：先固定版本 2 与旧数据拒绝行为**

在 `tests/unit/chat/chat-contracts.test.ts` 增加版本 2 空文档断言；在 `tests/unit/chat/chat-repository.test.ts` 使用临时文件增加：

```ts
it('rejects a version 1 task document without rewriting or migrating it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chat-repository-legacy-'))
  dirs.push(directory)
  const path = join(directory, 'chat-workspaces.json')
  const legacy = JSON.stringify({
    version: 1, liveChatId: null, chats: [], messages: [], associations: [], operations: [],
  })
  await writeFile(path, legacy)

  const repository = new ChatRepository(path)
  await expect(repository.list()).rejects.toThrow('任务数据版本不兼容，请清空旧任务数据后重试。')
  await expect(readFile(path, 'utf8')).resolves.toBe(legacy)
})
```

删除原来断言版本 1 自动补字段、自动净化关联元数据或自动改写取消状态的迁移测试；这些测试与“用户清空旧数据、应用不迁移”的已确认边界冲突。

- [ ] **步骤 2：运行测试并确认旧文档仍会被迁移或返回通用错误**

运行：

```powershell
npx vitest run tests/unit/chat/chat-contracts.test.ts tests/unit/chat/chat-repository.test.ts
```

预期：版本 2 断言失败，旧文档没有返回指定的版本不兼容错误。

- [ ] **步骤 3：定义完整版本 2 快照和明确版本守卫**

在 `src/main/chat/chat-contracts.ts` 中把持久化任务与操作结果定义为：

```ts
export const persistedChatSchema = z.object({
  id: chatIdentifierSchema,
  title: z.string().trim().min(1).max(255),
  titleState: chatTitleStateSchema,
  pinnedAt: chatTimestampSchema.nullable(),
  createdAt: chatTimestampSchema,
  updatedAt: chatTimestampSchema,
  mode: sessionModeSchema,
  deletedAt: chatTimestampSchema.optional(),
}).strict()

const chatOperationResultSchema = z.object({
  createdAt: chatTimestampSchema,
  updatedAt: chatTimestampSchema,
  mode: sessionModeSchema,
  title: z.string().trim().min(1).max(255),
  titleState: chatTitleStateSchema,
  pinnedAt: chatTimestampSchema.nullable(),
}).strict()

export const chatOperationSchema = z.object({
  requestId: chatRequestIdSchema,
  kind: z.enum([
    'create', 'appendMessage', 'updateMessage', 'updateTitle', 'pin', 'unpin',
    'setMode', 'associateShell', 'bindSession', 'closeAssociation', 'remove',
  ]),
  chatId: chatIdentifierSchema,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  appliedAt: chatTimestampSchema,
  resultId: chatIdentifierSchema.optional(),
  result: chatOperationResultSchema.optional(),
}).strict()

const chatDocumentBaseSchema = z.object({
  version: z.literal(2),
  liveChatId: chatIdentifierSchema.nullable(),
  chats: z.array(persistedChatSchema),
  messages: z.array(persistedMessageSchema),
  associations: z.array(persistedAssociationSchema),
  operations: z.array(chatOperationSchema),
}).strict()

export const chatDocumentSchema = chatDocumentBaseSchema.superRefine(validateChatDocument)

export function emptyChatDocument(): ChatDocument {
  return { version: 2, liveChatId: null, chats: [], messages: [], associations: [], operations: [] }
}

export function requireCurrentChatDocument(persisted: unknown): { value: unknown; changed: false } {
  if (isRecord(persisted) && Object.prototype.hasOwnProperty.call(persisted, 'version') && persisted.version !== 2) {
    throw new Error('任务数据版本不兼容，请清空旧任务数据后重试。')
  }
  return { value: persisted, changed: false }
}
```

将当前内联 `superRefine` 回调的完整函数体提取为 `validateChatDocument(document, context)`，原有唯一性、引用关系、删除墓碑、`resultId` 和全局 `appliedAt` 单调性检查一条不删。把 `lastResultByChat` 的值类型扩展为完整的 `chatOperationResultSchema`，并按操作顺序校验相邻快照，而不是错误地拿每个历史快照与任务最终状态比较：

- `create` 的 `updatedAt` 等于 `createdAt`、模式为 `copilot`、`pinnedAt` 为 `null`；无显式标题时状态为 `new`，有显式标题时状态为 `custom`。
- `appendMessage` 只有用户消息允许把 `new` 转成 `started`，系统标题从 `新建任务 <创建时间>` 变成 `任务 <同一创建时间>`；assistant/system 消息必须保持上一标题状态。
- `associateShell` 允许同样的 `new -> started` 转换；`bindSession` 只有真正写入新关联的路径允许转换，重复绑定请求保持上一标题状态。
- `updateTitle` 必须得到 `titleState: 'custom'`，并保持上一快照的 `pinnedAt` 和 `mode`。
- `pin` 必须保持上一快照的 `updatedAt`、标题、标题状态和模式，并满足 `pinnedAt === operation.appliedAt`。
- `unpin` 必须保持上一快照的 `updatedAt`、标题、标题状态和模式，并满足 `pinnedAt === null`。
- 除 `pin`/`unpin` 外的真实活动操作继续要求 `result.updatedAt === operation.appliedAt`；只有 `setMode` 可改变模式。
- 每个活动任务的最后一个结果快照必须与当前任务的 `createdAt`、`updatedAt`、`mode`、`title`、`titleState`、`pinnedAt` 全部一致。

删除墓碑改用 `已删除任务`、`titleState: 'custom'`、`pinnedAt: null`。对应测试分别篡改每种操作的一个字段并断言 schema 拒绝，确保验证逻辑不是只覆盖正常路径。

- [ ] **步骤 4：让仓库只执行版本守卫，不执行迁移**

在 `ChatRepository` 构造器中替换原有迁移器：

```ts
this.store = new AtomicJsonStore(path, chatDocumentSchema, emptyChatDocument, {
  ...(options.fileSystem ? { fileSystem: options.fileSystem } : {}),
  migrate: requireCurrentChatDocument,
})
```

删除 `migrateChatDocument` 及其旧数据补写逻辑。这里复用 `AtomicJsonStore` 的解析前钩子只为抛出明确版本错误，返回值永远 `changed: false`，所以不会转换或重写旧数据。

- [ ] **步骤 5：运行文档与仓库测试并提交**

运行：

```powershell
npx vitest run tests/unit/chat/chat-contracts.test.ts tests/unit/chat/chat-repository.test.ts
git add src/main/chat/chat-contracts.ts src/main/chat/chat-repository.ts tests/unit/chat/chat-contracts.test.ts tests/unit/chat/chat-repository.test.ts
git commit -m "feat: version task storage without migration"
```

预期：版本 2 文档通过，版本 1 文档以指定中文错误失败且原文件字节不变。

### 任务 4：实现默认命名、首次活动、重命名和置顶持久化

**文件：**
- 修改：`src/main/chat/chat-repository.ts`
- 修改：`tests/unit/chat/chat-repository.test.ts`

- [ ] **步骤 1：为任务生命周期写失败测试**

先把测试文件已有 helper 扩展为可注入时钟，并在文件顶部定义顺序时钟：

```ts
async function createRepository(options: { now?: () => Date } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'chat-repository-'))
  dirs.push(dir)
  let index = 0
  return new ChatRepository(join(dir, 'chat-workspaces.json'), {
    now: options.now ?? (() => new Date('2026-08-16T08:00:00.000Z')),
    createId: () => ids[index++] ?? `55555555-5555-4555-8555-${String(index).padStart(12, '0')}`,
  })
}

function sequenceClock(timestamps: readonly string[]): () => Date {
  let index = 0
  return () => new Date(timestamps[Math.min(index++, timestamps.length - 1)])
}
```

然后增加独立用例，固定 `now` 为连续时间并断言：

```ts
it('uses creation time for system titles and never overwrites a custom title', async () => {
  const repository = await createRepository({ now: sequenceClock([
    '2026-08-24T02:03:04.000Z', '2026-08-24T02:03:05.000Z', '2026-08-24T02:03:06.000Z',
  ]) })
  const created = await repository.create({ requestId: 'create-1' })
  expect(created.value).toMatchObject({
    title: '新建任务 2026-08-24 10:03:04', titleState: 'new', pinnedAt: null,
  })
  const renamed = await repository.updateTitle({ requestId: 'rename-1', chatId: created.value.id, title: '  发布检查  ' })
  expect(renamed.value).toMatchObject({ title: '发布检查', titleState: 'custom' })
  const started = await repository.appendMessage({
    requestId: 'message-1', chatId: created.value.id, role: 'user', content: '开始', state: 'complete',
  })
  expect(started.value).toMatchObject({ title: '发布检查', titleState: 'custom' })
})

it('starts a new task exactly once after the first persisted user message or shell', async () => {
  const byMessage = (await repository.create({ requestId: 'create-message' })).value
  const messageStarted = await repository.appendMessage({
    requestId: 'first-user', chatId: byMessage.id, role: 'user', content: '检查', state: 'complete',
  })
  expect(messageStarted.value).toMatchObject({ title: expect.stringMatching(/^任务 /), titleState: 'started' })

  const byShell = (await repository.create({ requestId: 'create-shell' })).value
  const shellStarted = await repository.associateShell({
    requestId: 'first-shell', chatId: byShell.id, sessionId: 'session-1', historyId: 'history-1', hostname: 'host', title: 'shell',
  })
  expect(shellStarted.value).toMatchObject({ title: expect.stringMatching(/^任务 /), titleState: 'started' })
  expect(shellStarted.value.title.slice(3)).toBe(byShell.title.slice(5))
})

it('starts a blank target task when a running shell is transferred into it', async () => {
  const source = (await repository.create({ requestId: 'create-source' })).value
  await repository.associateShell({
    requestId: 'source-shell', chatId: source.id, sessionId: 'session-transfer',
    historyId: 'history-transfer', hostname: 'host', title: 'shell',
  })
  const target = (await repository.create({ requestId: 'create-target' })).value
  const transferred = await repository.transferSessions({
    requestId: 'transfer-1', sourceChatId: source.id, targetChatId: target.id, sessionIds: ['session-transfer'],
  }, [{ sessionId: 'session-transfer', historyId: 'history-transfer', hostname: 'host', title: 'shell' }])
  expect(transferred.value.target).toMatchObject({ title: expect.stringMatching(/^任务 /), titleState: 'started' })
})

it('pins without changing activity time and restores ordinary grouping metadata on unpin', async () => {
  const task = (await repository.create({ requestId: 'create-pin' })).value
  const activityTime = task.updatedAt
  const pinned = await repository.pin({ requestId: 'pin-1', chatId: task.id })
  expect(pinned.value.updatedAt).toBe(activityTime)
  expect(pinned.value.pinnedAt).not.toBeNull()
  const duplicate = await repository.pin({ requestId: 'pin-1', chatId: task.id })
  expect(duplicate.changed).toBe(false)
  const unpinned = await repository.unpin({ requestId: 'unpin-1', chatId: task.id })
  expect(unpinned.value).toMatchObject({ updatedAt: activityTime, pinnedAt: null })
})
```

再加入两个并发用例：同时排队第一条用户消息和首个 Shell 后仅发生一次 `new -> started`；相同 `requestId` 改用于不同任务或相反管理动作时抛出 `Chat request idempotency conflict`。

- [ ] **步骤 2：运行仓库测试并确认失败**

运行：

```powershell
npx vitest run tests/unit/chat/chat-repository.test.ts
```

预期：默认标题仍含“新建聊天”，没有标题状态和置顶方法，首次活动不会改名。

- [ ] **步骤 3：加入统一的系统标题和首次活动转换**

在 `chat-repository.ts` 用创建时间生成标题：

```ts
function formatSystemTaskTitle(prefix: '新建任务' | '任务', createdAt: string): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(createdAt))
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? ''
  return `${prefix} ${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')}`
}

function startTaskIfNeeded(chat: PersistedChat): void {
  if (chat.titleState !== 'new') return
  chat.title = formatSystemTaskTitle('任务', chat.createdAt)
  chat.titleState = 'started'
}
```

`create()` 以及 `associateOrCreateShell()`/`transferSessions()` 内部创建 fallback 任务的分支，在没有显式标题时写 `titleState: 'new'`，显式标题写 `titleState: 'custom'`，都写 `pinnedAt: null`。`appendMessage()` 只在 `parsed.role === 'user'` 且消息已加入同一次 `store.update()` 后调用 `startTaskIfNeeded(chat)`；`associateShell()`、`associateOrCreateShell()` 和 `transferSessions()` 只在目标任务的新关联记录成功加入后调用。模型请求启动、草稿、失败连接、重复绑定请求和仅打开对话框不经过这些成功写入路径，因此不会触发改名。

- [ ] **步骤 4：实现自定义标题和管理操作快照**

`updateTitle()` 在同一次写入中设置 `chat.title = parsed.title`、`chat.titleState = 'custom'` 和活动时间。新增：

```ts
async pin(request: ChatPinRequest): Promise<ChatMutation<ChatWorkspace>> {
  const parsed = chatPinRequestSchema.parse(request)
  const fingerprint = requestFingerprint('pin', [parsed.chatId])
  return this.mutate(parsed.requestId, 'pin', parsed.chatId, fingerprint, (document, timestamp) => {
    const chat = requireChat(document, parsed.chatId)
    chat.pinnedAt = timestamp
    return { chatId: chat.id }
  })
}

async unpin(request: ChatUnpinRequest): Promise<ChatMutation<ChatWorkspace>> {
  const parsed = chatUnpinRequestSchema.parse(request)
  const fingerprint = requestFingerprint('unpin', [parsed.chatId])
  return this.mutate(parsed.requestId, 'unpin', parsed.chatId, fingerprint, document => {
    const chat = requireChat(document, parsed.chatId)
    chat.pinnedAt = null
    return { chatId: chat.id }
  })
}
```

调整 `mutate()` 生成的 `result`，完整复制 `createdAt`、`updatedAt`、`mode`、`title`、`titleState`、`pinnedAt`。`pin`/`unpin` 使用操作时间作为 `appliedAt`，但绝不赋值给 `chat.updatedAt`。`summarizeChats()` 和 `toWorkspace()` 复制新增元数据；删除任务时墓碑清空 `pinnedAt`。

- [ ] **步骤 5：运行仓库测试并提交**

运行：

```powershell
npx vitest run tests/unit/chat/chat-contracts.test.ts tests/unit/chat/chat-repository.test.ts
git add src/main/chat/chat-repository.ts tests/unit/chat/chat-repository.test.ts
git commit -m "feat: persist task naming and pin state"
```

预期：默认命名、两种首次活动、并发状态转换、自定义标题、置顶时间、`updatedAt` 不变和请求幂等测试全部通过。

### 任务 5：贯通任务服务、受信 IPC 和 preload API

**文件：**
- 修改：`src/main/chat/chat-service.ts`
- 修改：`src/main/chat/register-chat-handlers.ts`
- 修改：`src/preload/api.ts`
- 修改：`tests/unit/chat/chat-service.test.ts`
- 修改：`tests/unit/chat/register-chat-handlers.test.ts`
- 修改：`tests/unit/preload/api.test.ts`

- [ ] **步骤 1：先为三个管理通道写失败测试**

在 handler 测试中断言受信 sender 可调用、伪造 sender 被拒绝、注销后处理器被移除：

```ts
await handlers['chats:update-title']({ sender: trusted }, { requestId: 'rename-1', chatId: 'task-1', title: '任务名' })
await handlers['chats:pin']({ sender: trusted }, { requestId: 'pin-1', chatId: 'task-1' })
await handlers['chats:unpin']({ sender: trusted }, { requestId: 'unpin-1', chatId: 'task-1' })
expect(service.updateTitle).toHaveBeenCalledWith({ requestId: 'rename-1', chatId: 'task-1', title: '任务名' })
expect(service.pin).toHaveBeenCalledWith({ requestId: 'pin-1', chatId: 'task-1' })
expect(service.unpin).toHaveBeenCalledWith({ requestId: 'unpin-1', chatId: 'task-1' })
await expect(handlers['chats:pin']({ sender: forged }, { requestId: 'pin-2', chatId: 'task-1' })).rejects.toThrow('Untrusted renderer')
```

在 preload 测试中调用 `api.chats.updateTitle()`、`pin()`、`unpin()`，断言只路由到同名 IPC，且没有原始 `invoke` 属性。

- [ ] **步骤 2：运行测试并确认通道不存在**

运行：

```powershell
npx vitest run tests/unit/chat/chat-service.test.ts tests/unit/chat/register-chat-handlers.test.ts tests/unit/preload/api.test.ts
```

预期：服务端口、handler 和 preload 方法缺失。

- [ ] **步骤 3：扩展服务并只在真实变化后发布事件**

把 `pin`、`unpin` 加入 `ChatRepositoryPort`，并在 `ChatService` 新增：

```ts
async pin(request: ChatPinRequest): Promise<ChatWorkspaceSnapshot> {
  const parsed = chatPinRequestSchema.parse(request)
  return this.trackMutation(() => this.apply(this.repository.pin(parsed), 'updated'))
}

async unpin(request: ChatUnpinRequest): Promise<ChatWorkspaceSnapshot> {
  const parsed = chatUnpinRequestSchema.parse(request)
  return this.trackMutation(() => this.apply(this.repository.unpin(parsed), 'updated'))
}
```

继续复用 `apply()` 的 `mutation.changed` 判断；重复请求不得增加 revision 或重复发 `chats:changed`。

- [ ] **步骤 4：注册严格 IPC 并扩展 preload**

把以下通道加入 `channels`，解析后调用服务：

```ts
ipcMain.handle('chats:update-title', (event, request: unknown) => {
  assertTrustedSender(event, trustedSender)
  return service.updateTitle(chatUpdateTitleRequestSchema.parse(request))
})
ipcMain.handle('chats:pin', (event, request: unknown) => {
  assertTrustedSender(event, trustedSender)
  return service.pin(chatPinRequestSchema.parse(request))
})
ipcMain.handle('chats:unpin', (event, request: unknown) => {
  assertTrustedSender(event, trustedSender)
  return service.unpin(chatUnpinRequestSchema.parse(request))
})
```

在 `TerminalAgentApi.chats` 与 `createTerminalAgentApi()` 中以同样的 `updateTitle`、`pin`、`unpin` 名称公开强类型 Promise。不要新增通用 IPC 方法。

- [ ] **步骤 5：运行服务边界测试并提交**

运行：

```powershell
npx vitest run tests/unit/chat/chat-service.test.ts tests/unit/chat/register-chat-handlers.test.ts tests/unit/preload/api.test.ts
git add src/main/chat/chat-service.ts src/main/chat/register-chat-handlers.ts src/preload/api.ts tests/unit/chat/chat-service.test.ts tests/unit/chat/register-chat-handlers.test.ts tests/unit/preload/api.test.ts
git commit -m "feat: expose trusted task management APIs"
```

预期：三个管理操作都经过严格 schema、受信 sender 和命名 API；重复请求不产生第二个变更事件。

### 任务 6：实现渲染端置顶分组和任务管理状态

**文件：**
- 修改：`src/renderer/src/stores/chat-workspaces.ts`
- 修改：`tests/unit/renderer/chat-workspaces.test.ts`

- [ ] **步骤 1：为排序、恢复分组和失败行为写测试**

在 `tests/unit/renderer/chat-workspaces.test.ts` 增加：

```ts
it('places pinned tasks first by newest pin time and removes them from date groups', () => {
  const groups = groupChatSummaries([
    summary({ id: 'normal', pinnedAt: null, updatedAt: '2026-08-24T01:00:00.000Z' }),
    summary({ id: 'older-pin', pinnedAt: '2026-08-24T02:00:00.000Z' }),
    summary({ id: 'newer-pin', pinnedAt: '2026-08-24T03:00:00.000Z' }),
  ], new Date('2026-08-24T04:00:00.000Z'))

  expect(groups[0]).toMatchObject({ label: '置顶', chats: [{ id: 'newer-pin' }, { id: 'older-pin' }] })
  expect(groups.slice(1).flatMap(group => group.chats.map(chat => chat.id))).toEqual(['normal'])
})
```

再测试相同 `pinnedAt` 按 ID 稳定排序、取消置顶事件后回到按 `createdAt` 形成的日期组、置顶失败时本地顺序不变、重命名失败返回 `false` 且服务端错误写入 `state.error`。

- [ ] **步骤 2：运行测试并确认当前所有任务仍只按日期分组**

运行：

```powershell
npx vitest run tests/unit/renderer/chat-workspaces.test.ts
```

预期：没有“置顶”分组，`summaryOf()` 丢失新字段，store 没有管理方法。

- [ ] **步骤 3：实现稳定分组**

`summaryOf()` 复制 `titleState` 与 `pinnedAt`。`groupChatSummaries()` 先分离置顶项：

```ts
const pinned = chats
  .filter(chat => chat.pinnedAt !== null)
  .sort((left, right) => right.pinnedAt!.localeCompare(left.pinnedAt!) || left.id.localeCompare(right.id))
const ordinary = chats.filter(chat => chat.pinnedAt === null)
const groups: ChatGroup[] = pinned.length > 0 ? [{ label: '置顶', chats: pinned }] : []
```

只让 `ordinary` 进入现有日期逻辑；每个普通分组内部继续按 `updatedAt` 降序、ID 升序。取消置顶后 `createdAt` 决定日期标签，`updatedAt` 决定组内位置。

- [ ] **步骤 4：扩展 ChatApi 和可等待的管理方法**

给本地 `ChatApi` 增加三个方法，并在 store 返回布尔结果：

```ts
async function updateTitle(chatId: string, title: string): Promise<boolean> {
  state.error = ''
  try {
    return mergeSnapshot(await api.updateTitle({ requestId: requestId(), chatId, title }))
  } catch (error) {
    state.error = error instanceof Error ? error.message : '无法重命名任务。'
    return false
  }
}

async function pin(chatId: string): Promise<boolean> {
  state.error = ''
  try { return mergeSnapshot(await api.pin({ requestId: requestId(), chatId })) }
  catch (error) { state.error = error instanceof Error ? error.message : '无法置顶任务。'; return false }
}

async function unpin(chatId: string): Promise<boolean> {
  state.error = ''
  try { return mergeSnapshot(await api.unpin({ requestId: requestId(), chatId })) }
  catch (error) { state.error = error instanceof Error ? error.message : '无法取消置顶任务。'; return false }
}
```

同时把 `无法新建聊天`、`无法读取聊天列表`、`无法删除聊天` 改为对应的“任务”文案。

- [ ] **步骤 5：运行 store 测试并提交**

运行：

```powershell
npx vitest run tests/unit/renderer/chat-workspaces.test.ts
git add src/renderer/src/stores/chat-workspaces.ts tests/unit/renderer/chat-workspaces.test.ts
git commit -m "feat: group and manage pinned tasks"
```

预期：置顶/普通分组互斥、排序稳定、管理失败不乐观改动本地状态。

### 任务 7：完成任务历史三点菜单、行内重命名和低干扰滚动条

**文件：**
- 修改：`src/renderer/src/components/workbench/WorkbenchSessionSidebar.vue`
- 修改：`src/renderer/src/views/WorkbenchView.vue`
- 修改：`tests/unit/renderer/v18-visual-contract.test.ts`
- 修改：`tests/e2e/workbench.spec.ts`

- [ ] **步骤 1：先写可访问性和交互失败测试**

在视觉契约测试读取组件源码并断言存在 `MoreHorizontal`、`role="menu"`、`maxlength="255"`、`@keydown.enter.prevent`、`@keydown.esc.prevent`、`:focus-within`、`scrollbar-gutter: stable`，同时断言不再导入 `Trash2` 作为列表项唯一操作入口。

在 `tests/e2e/workbench.spec.ts` 增加完整用户流：

```ts
await page.getByRole('button', { name: '新建任务' }).click()
const item = page.getByRole('button', { name: /任务菜单 新建任务/ })
await item.click()
await page.getByRole('menuitem', { name: '重命名' }).click()
const input = page.getByRole('textbox', { name: '任务名称' })
await expect(input).toBeFocused()
await input.fill('  发布检查  ')
await input.press('Enter')
await expect(page.getByText('发布检查', { exact: true })).toBeVisible()
```

继续覆盖 `Escape` 取消、空名称显示就地错误、失焦只发一次保存、失败后输入仍保留、置顶分组出现、取消置顶返回日期分组、重启 Electron 后标题和置顶状态仍存在。

- [ ] **步骤 2：运行测试并确认当前仍是单独删除按钮**

运行：

```powershell
npx vitest run tests/unit/renderer/v18-visual-contract.test.ts
npx playwright test tests/e2e/workbench.spec.ts --grep "任务菜单|任务名称|置顶"
```

预期：组件契约失败；E2E 找不到“新建任务”和任务菜单。

- [ ] **步骤 3：实现一次提交的行内重命名状态机**

`WorkbenchSessionSidebar.vue` 接收 `renameTask(chatId, title): Promise<boolean>`、`pinTask(chatId): Promise<boolean>`、`unpinTask(chatId): Promise<boolean>` 回调。局部状态使用 `editingId`、`editingTitle`、`renameError`、`renamePending`；保存函数必须以同一个 Promise 屏蔽 Enter 与 blur 的重复触发：

```ts
async function commitRename(chatId: string): Promise<void> {
  if (renamePending || editingId !== chatId) return
  const title = editingTitle.trim()
  if (!title) { renameError = '任务名称不能为空。'; return }
  renamePending = true
  const saved = await props.renameTask(chatId, title)
  renamePending = false
  if (saved) cancelRename()
  else renameError = '任务名称保存失败，请修正后重试。'
}
```

输入框设置 `aria-label="任务名称"`、`maxlength="255"`，进入编辑后 `nextTick()` 调用 `select()`。Enter 调 `commitRename()`，Escape 调 `cancelRename()`，blur 调 `commitRename()`。失败时不清空 `editingTitle`。

- [ ] **步骤 4：用三点菜单替换独立删除入口**

每项右侧使用 Lucide `MoreHorizontal` 图标按钮，菜单依次包含 `Pencil` 重命名、`Pin`/`PinOff` 置顶或取消置顶、`Trash2` 删除。菜单带 `role="menu"`，项目带 `role="menuitem"`；点击外部、Escape、切换任务或完成操作时关闭。置顶任务标题旁使用小号 `Pin` 图标和 `aria-label="已置顶"`，不新增装饰卡片。

所有用户可见文字改为：`新建任务`、`正在读取任务…`、`暂无任务`、`选择任务`、`删除任务`、`任务与 Shell 记录`。`WorkbenchView.vue` 把 store 的三个 Promise 回调传入侧栏，删除仍走现有关闭/转移 Shell 的安全流程。

- [ ] **步骤 5：把滚动条限制在任务列表并保持占位稳定**

用以下状态规则替换当前常显滑块：

```css
nav {
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
nav:hover,
nav:focus-within {
  scrollbar-color: color-mix(in srgb, var(--muted) 58%, transparent) transparent;
}
nav::-webkit-scrollbar { width: 8px; }
nav::-webkit-scrollbar-track { background: transparent; }
nav::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
nav::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background: transparent;
  background-clip: padding-box;
}
nav:hover::-webkit-scrollbar-thumb,
nav:focus-within::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--muted) 58%, transparent);
}
nav::-webkit-scrollbar-thumb:hover { background-color: var(--muted); }
```

不要修改其他页面或 Shell 容器的滚动条。

- [ ] **步骤 6：运行 UI 测试并提交**

运行：

```powershell
npx vitest run tests/unit/renderer/chat-workspaces.test.ts tests/unit/renderer/v18-visual-contract.test.ts
npx playwright test tests/e2e/workbench.spec.ts --grep "任务菜单|任务名称|置顶"
git add src/renderer/src/components/workbench/WorkbenchSessionSidebar.vue src/renderer/src/views/WorkbenchView.vue tests/unit/renderer/v18-visual-contract.test.ts tests/e2e/workbench.spec.ts
git commit -m "feat: add task menu rename and pin interactions"
```

预期：键盘、失焦、失败保留、菜单、置顶持久化和滚动条契约均通过。

### 任务 8：实现诊断窗口控制器

**文件：**
- 新建：`src/main/diagnostics/diagnostics-controller.ts`
- 新建：`tests/unit/diagnostics/diagnostics-controller.test.ts`

- [ ] **步骤 1：为调试窗口复用和 Inspector 所有权写失败测试**

控制器构造签名固定为以下形式，生产代码只传第一个参数，测试才覆盖 adapters：

```ts
type DiagnosticsControllerAdapters = {
  inspector?: Pick<typeof import('node:inspector'), 'url' | 'open' | 'close'>
  createWindow?: (options: Electron.BrowserWindowConstructorOptions) => DiagnosticsWindow
}

export class DiagnosticsController {
  constructor(renderer: DiagnosticsRenderer, adapters: DiagnosticsControllerAdapters = {})
}
```

`DiagnosticsRenderer` 只声明 `isDestroyed()`、`isDevToolsOpened()`、`openDevTools()` 和只读 `devToolsWebContents`；`DiagnosticsWindow` 只声明 `isDestroyed()`、`isMinimized()`、`restore()`、`focus()`、`show()`、`close()`、`loadURL()`、`on('closed')`。创建测试并注入假的 renderer、Inspector adapter 与窗口工厂；测试 helper 使用一个 `Map<'closed', () => void>` 保存窗口关闭监听，并公开 `emitClosed()` 主动触发生命周期。至少覆盖：

```ts
it('opens detached renderer tools once and focuses the existing tools on repeat', async () => {
  const fixture = createDiagnosticsFixture()
  await fixture.controller.openRendererDevTools()
  fixture.renderer.isDevToolsOpened.mockReturnValue(true)
  await fixture.controller.openRendererDevTools()
  expect(fixture.renderer.openDevTools).toHaveBeenCalledOnce()
  expect(fixture.renderer.openDevTools).toHaveBeenCalledWith({ mode: 'detach', activate: true })
  expect(fixture.devToolsWebContents.focus).toHaveBeenCalledOnce()
})

it('starts an owned loopback inspector and auto-attaches one reusable Electron window', async () => {
  const fixture = createDiagnosticsFixture({ inspectorUrls: [undefined, 'ws://127.0.0.1:43123/target-id'] })
  await fixture.controller.openNodeInspector()
  await fixture.controller.openNodeInspector()
  expect(fixture.inspector.open).toHaveBeenCalledWith(0, '127.0.0.1', false)
  expect(fixture.createWindow).toHaveBeenCalledOnce()
  expect(fixture.window.loadURL).toHaveBeenCalledWith(
    'devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws=127.0.0.1%3A43123%2Ftarget-id',
  )
  expect(fixture.window.focus).toHaveBeenCalled()
})
```

再覆盖已有 `inspector.url()` 时不调用 `open/close`、拒绝非 `127.0.0.1` 地址、窗口加载失败关闭新窗口并关闭自有 Inspector、窗口关闭/`dispose()` 清理幂等、最小化窗口重复打开时先 restore 再 focus。

- [ ] **步骤 2：运行测试并确认模块不存在**

运行：

```powershell
npx vitest run tests/unit/diagnostics/diagnostics-controller.test.ts
```

预期：失败原因为诊断控制器模块不存在。

- [ ] **步骤 3：实现可测试的 Inspector URL 边界**

在新模块导出：

```ts
export function nodeInspectorFrontendUrl(address: string): string {
  const target = new URL(address)
  if (target.protocol !== 'ws:' || target.hostname !== '127.0.0.1' || !target.port || !target.pathname.slice(1)) {
    throw new Error('Node Inspector 只允许连接当前应用的本机回环地址。')
  }
  const websocketTarget = `${target.host}${target.pathname}`
  return `devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws=${encodeURIComponent(websocketTarget)}`
}
```

控制器依赖使用窄接口：renderer 只需 `isDestroyed/isDevToolsOpened/openDevTools/devToolsWebContents`；Inspector adapter 只需 `url/open/close`；窗口工厂默认创建 `BrowserWindow`。

- [ ] **步骤 4：实现窗口复用、失败回滚和所有权清理**

`openNodeInspector()` 的顺序固定为：复用已有窗口；读取 `inspector.url()`；没有地址时执行 `open(0, '127.0.0.1', false)` 并标记 `ownsInspector = true`；再次读取地址；创建 `show: false` 的独立窗口；加载内置 URL；成功后 show/focus。窗口配置使用：

```ts
new BrowserWindow({
  width: 1100,
  height: 760,
  minWidth: 800,
  minHeight: 600,
  show: false,
  autoHideMenuBar: true,
  title: 'Terminal-Agent Node Inspector',
  webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false },
})
```

窗口 `closed` 时仅当 `ownsInspector` 为真才调用 `inspector.close()`；外部 `--inspect` 地址永不关闭。清理先清空字段再调用外部资源方法，保证重复 `closed`、主窗口关闭和应用退出不会二次释放。

同模块导出 `DiagnosticsError` 和 `publicDiagnosticsError(error)`；控制器对 Inspector 启动、地址读取、窗口创建/加载等底层异常统一包装成固定中文 `DiagnosticsError`，`publicDiagnosticsError` 对其他异常只返回 `无法打开诊断窗口。请关闭后重试。`，不拼接底层 message、URL、端口或 stack。

- [ ] **步骤 5：运行控制器测试并提交**

运行：

```powershell
npx vitest run tests/unit/diagnostics/diagnostics-controller.test.ts
git add src/main/diagnostics/diagnostics-controller.ts tests/unit/diagnostics/diagnostics-controller.test.ts
git commit -m "feat: add reusable diagnostics windows"
```

预期：两类调试窗口复用、回环地址、自有/外部 Inspector 清理和部分失败回滚全部通过。

### 任务 9：接入诊断 IPC、快捷键和主进程生命周期

**文件：**
- 新建：`src/main/diagnostics/register-diagnostics-handlers.ts`
- 新建：`tests/unit/diagnostics/register-diagnostics-handlers.test.ts`
- 修改：`src/main/main.ts`
- 修改：`src/main/application-shutdown.ts`
- 修改：`src/preload/api.ts`
- 修改：`tests/unit/electron-startup.test.ts`
- 修改：`tests/unit/main/chat-main-lifecycle.test.ts`
- 修改：`tests/unit/main/application-shutdown.test.ts`
- 修改：`tests/unit/preload/api.test.ts`

- [ ] **步骤 1：为零参数 IPC 和快捷键写失败测试**

handler 测试断言：

```ts
await handlers['diagnostics:open-renderer-devtools']({ sender: trusted })
await handlers['diagnostics:open-node-inspector']({ sender: trusted })
await expect(handlers['diagnostics:open-node-inspector'](
  { sender: trusted }, 'ws://127.0.0.1:9229/forged',
)).rejects.toThrow('Diagnostic commands do not accept arguments')
await expect(handlers['diagnostics:open-renderer-devtools']({ sender: forged })).rejects.toThrow('Untrusted renderer')
```

启动源码测试断言存在 `before-input-event`、`input.control`、`input.shift`、`input.key.toLowerCase() === 'i'`、`event.preventDefault()`，且调用与按钮相同的 `diagnostics.openRendererDevTools()`。preload 测试断言两个方法调用 IPC 时没有第二个参数。

- [ ] **步骤 2：运行边界测试并确认失败**

运行：

```powershell
npx vitest run tests/unit/diagnostics/register-diagnostics-handlers.test.ts tests/unit/electron-startup.test.ts tests/unit/main/chat-main-lifecycle.test.ts tests/unit/preload/api.test.ts
```

预期：诊断 handler/API 尚不存在，主窗口没有显式快捷键监听和清理。

- [ ] **步骤 3：注册只接受零参数的受信 IPC**

新文件实现：

```ts
const channels = ['diagnostics:open-renderer-devtools', 'diagnostics:open-node-inspector'] as const

export function registerDiagnosticsHandlers(
  controller: Pick<DiagnosticsController, 'openRendererDevTools' | 'openNodeInspector'>,
  trustedSender: WebContents,
): () => void {
  const register = (channel: typeof channels[number], open: () => Promise<void>) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (event.sender !== trustedSender) throw new Error('Untrusted renderer')
      if (args.length !== 0) throw new Error('Diagnostic commands do not accept arguments')
      return open().catch(error => { throw new Error(publicDiagnosticsError(error)) })
    })
  }
  register(channels[0], () => controller.openRendererDevTools())
  register(channels[1], () => controller.openNodeInspector())
  return () => { for (const channel of channels) ipcMain.removeHandler(channel) }
}
```

注销函数增加幂等布尔保护，和现有 handler 生命周期一致。

- [ ] **步骤 4：接入主窗口和快捷键**

`createMainWindow()` 创建 `DiagnosticsController(rendererWindow.webContents)`，注册 handler，并监听：

```ts
const onBeforeInput = (event: Electron.Event, input: Electron.Input) => {
  const opensDevTools = input.type === 'keyDown'
    && input.control && input.shift && !input.alt && !input.meta
    && input.key.toLowerCase() === 'i'
  if (!opensDevTools) return
  event.preventDefault()
  void diagnostics.openRendererDevTools().catch(error => {
    if (!rendererWindow.isDestroyed()) rendererWindow.webContents.send('diagnostics:error', publicDiagnosticsError(error))
  })
}
rendererWindow.webContents.on('before-input-event', onBeforeInput)
```

快捷键失败使用控制器模块导出的稳定错误映射，不能把 Inspector URL、端口或内部 stack 发给 renderer：

```ts
rendererWindow.webContents.send('diagnostics:error', publicDiagnosticsError(error))
```

`DiagnosticsError` 与 `publicDiagnosticsError` 由控制器导出；固定中文消息只覆盖 renderer 已销毁、Inspector 启动失败、Inspector 地址不是回环地址、调试前端加载失败。IPC 和快捷键都通过同一映射返回/发布错误。

在 `main.ts` 保留当前窗口的控制器引用：

```ts
let diagnostics: DiagnosticsController | undefined
let unregisterDiagnosticsHandlers: (() => void) | undefined
```

`createMainWindow()` 为当前 renderer 创建控制器并注册 handler。主窗口 `closed` 时移除此监听、注销 IPC、调用当前控制器的 `dispose()`，然后仅当全局引用仍指向该实例时清空引用。

把 `registerGracefulApplicationShutdown` 的第四个参数扩展为默认空函数 `disposeDiagnostics: () => void = () => undefined`，在 `closeSessions()` 之前以独立 `try/catch` 调用。`main.ts` 传入 `() => diagnostics?.dispose()`。在 `application-shutdown.test.ts` 断言首次 `before-quit` 只清理一次，第二次被 `shuttingDown` 拦截，持久化完成后的最终 `app.quit()` 不再次清理。这样应用退出和主窗口关闭走同一个幂等控制器方法，且不依赖 Electron 事件监听顺序。

- [ ] **步骤 5：扩展命名 preload API 和错误事件**

在 `TerminalAgentApi` 增加：

```ts
diagnostics: {
  openRendererDevTools(): Promise<void>
  openNodeInspector(): Promise<void>
  onError(listener: (message: string) => void): () => void
}
```

实现仅调用两个固定 IPC，并用 `z.string().trim().min(1).max(4000)` 解析 `diagnostics:error`。不要接受任何目标参数。

- [ ] **步骤 6：运行生命周期测试并提交**

运行：

```powershell
npx vitest run tests/unit/diagnostics tests/unit/electron-startup.test.ts tests/unit/main/chat-main-lifecycle.test.ts tests/unit/main/application-shutdown.test.ts tests/unit/preload/api.test.ts
git add src/main/diagnostics/register-diagnostics-handlers.ts src/main/main.ts src/main/application-shutdown.ts src/preload/api.ts tests/unit/diagnostics tests/unit/electron-startup.test.ts tests/unit/main/chat-main-lifecycle.test.ts tests/unit/main/application-shutdown.test.ts tests/unit/preload/api.test.ts
git commit -m "feat: wire trusted diagnostics lifecycle"
```

预期：按钮 IPC 和 `Ctrl+Shift+I` 共用控制器；伪造参数与 sender 被拒绝；窗口关闭后 handler、快捷键和 Inspector 都被清理。

### 任务 10：加入顶部诊断按钮和响应式避让

**文件：**
- 修改：`src/renderer/src/views/WorkbenchView.vue`
- 修改：`src/renderer/src/components/workbench/WorkbenchShell.vue`
- 修改：`tests/unit/renderer/v18-visual-contract.test.ts`
- 修改：`tests/e2e/workbench.spec.ts`

- [ ] **步骤 1：先锁定按钮顺序、工具提示和错误状态**

单元源码契约断言 `Settings`、`Code2`、`Bug` 的模板顺序，按钮名称分别为 `设置`、`DevTools`、`Node Inspector`，且两个诊断方法无参数调用。E2E 在 `1024x768` 检查按钮不与原生窗口按钮区域重叠，窄宽度下文字隐藏但 `aria-label` 和 `title` 保留。

- [ ] **步骤 2：运行测试并确认只能找到设置按钮**

运行：

```powershell
npx vitest run tests/unit/renderer/v18-visual-contract.test.ts
npx playwright test tests/e2e/workbench.spec.ts --grep "DevTools|Node Inspector|顶部工具栏"
```

预期：诊断按钮不存在，顺序与响应式契约失败。

- [ ] **步骤 3：实现非阻塞诊断动作**

`WorkbenchView.vue` 增加 `diagnosticError` 和两个动作：

```ts
async function openRendererDevTools(): Promise<void> {
  diagnosticError.value = ''
  try { await window.terminalAgent.diagnostics.openRendererDevTools() }
  catch (error) { diagnosticError.value = error instanceof Error ? error.message : '无法打开 DevTools。' }
}

async function openNodeInspector(): Promise<void> {
  diagnosticError.value = ''
  try { await window.terminalAgent.diagnostics.openNodeInspector() }
  catch (error) { diagnosticError.value = error instanceof Error ? error.message : '无法打开 Node Inspector。' }
}
```

挂载时订阅 `diagnostics.onError`，卸载时取消。诊断错误使用独立、可截断的 `role="alert"` 文本，不覆盖连接错误，也不改变 SSH/AI 状态。

- [ ] **步骤 4：按固定顺序加入 Lucide 按钮**

模板顺序固定为：

```vue
<button type="button" class="header-button" aria-label="设置" title="设置" @click="emit('showSettings')"><Settings :size="14" aria-hidden="true" /><span>设置</span></button>
<button type="button" class="header-button" aria-label="DevTools" title="DevTools" @click="openRendererDevTools"><Code2 :size="14" aria-hidden="true" /><span>DevTools</span></button>
<button type="button" class="header-button" aria-label="Node Inspector" title="Node Inspector" @click="openNodeInspector"><Bug :size="14" aria-hidden="true" /><span>Node Inspector</span></button>
```

保留 `WorkbenchShell` 现有原生窗口按钮右侧留白。在受限宽度 media query 中只隐藏 `.header-button span`，按钮保持固定 `30px` 方形尺寸；错误文本设置 `min-width: 0`、单行省略和最大宽度，不能挤入 `window-controls` 区域。

- [ ] **步骤 5：运行工具栏测试并提交**

运行：

```powershell
npx vitest run tests/unit/renderer/v18-visual-contract.test.ts
npx playwright test tests/e2e/workbench.spec.ts --grep "DevTools|Node Inspector|顶部工具栏"
git add src/renderer/src/views/WorkbenchView.vue src/renderer/src/components/workbench/WorkbenchShell.vue tests/unit/renderer/v18-visual-contract.test.ts tests/e2e/workbench.spec.ts
git commit -m "feat: add workbench diagnostics actions"
```

预期：三个应用按钮在原生窗口按钮左侧顺序稳定，窄窗口无重叠，错误不阻塞工作台。

### 任务 11：让 AI 工作区模型输入与回复原文直通

**文件：**
- 修改：`src/main/chat/chat-context-builder.ts`
- 修改：`src/main/chat/chat-runtime.ts`
- 修改：`src/main/agent/execution-gateway.ts`
- 修改：`src/renderer/src/stores/global-chat.ts`
- 修改：`tests/unit/chat/chat-context-builder.test.ts`
- 修改：`tests/unit/chat/chat-runtime.test.ts`
- 修改：`tests/unit/agent/execution-gateway.test.ts`
- 修改：`tests/unit/renderer/global-chat.test.ts`
- 修改：`tests/integration/chat-runtime.test.ts`

- [ ] **步骤 1：把脱敏断言改为原文直通断言**

使用只存在于测试内的合成文本：

```ts
const temporaryPath = `tmp:${['C:', 'synthetic', 'AppData', 'Local', 'Temp', 'access', 'profile.conf'].join('\\')}`
const tokenLike = `sk-proj-${'A'.repeat(32)}`
const base64Like = `${'A'.repeat(45)}+/=`
```

`chat-context-builder.test.ts` 断言最近消息、活动 Shell 元数据、已授权 facts 与 audit 的上述文本完整出现在传给模型的消息中；系统提示词不再包含“脱敏消息”“不得输出临时路径”。`execution-gateway.test.ts` 断言只有成功通过人工批准的命令才进入内存审计、命令文本仅按现有 512 字符上限截断而不替换路径/令牌形态文本，并继续断言自动驾驶命令不写入这份“人工批准”审计。`chat-runtime.test.ts` 断言 `request.content` 原样持久化和发送，拆成多 delta 的路径/令牌最终逐字符原样发布。`global-chat.test.ts` 断言草稿、hydrate、delta、completed 都保留合成文本。

- [ ] **步骤 2：运行测试并确认仍发生替换或流式缓存**

运行：

```powershell
npx vitest run tests/unit/chat/chat-context-builder.test.ts tests/unit/chat/chat-runtime.test.ts tests/unit/agent/execution-gateway.test.ts tests/unit/renderer/global-chat.test.ts tests/integration/chat-runtime.test.ts
```

预期：断言失败，内容被 `[REDACTED ...]` 替换或被流式 redactor 延迟。

- [ ] **步骤 3：简化上下文构建器为授权数据的原样序列化**

`buildChatContext()` 继续只选择最近 `maxMessages`、只加入活动 Shell、只接收调用方已过滤的 facts 和批准审计，但不再调用 `redactSensitiveText()`、`sanitizeObject()` 或递归字段删除。结构保持：

```ts
const systemContext = {
  shells: input.shells?.filter(shell => shell.status === 'open') ?? [],
  facts: input.facts ?? [],
  audit: input.audit ?? [],
}
return [
  { role: 'system', content: `你是 Terminal-Agent 的 AI 助手。任务上下文：${JSON.stringify(systemContext)}` },
  ...messages.map(message => ({ role: message.role, content: message.content })),
]
```

保留中文助手定位、上下文数量限制和 host-memory 授权过滤；只删除与二次脱敏有关的提示语和转换函数。

`ApprovedExecutionAudit.record()` 改为 `const label = command.slice(0, 512)`，删除该文件对 `redactSensitiveText` 的导入。审计仍只驻留当前主进程内存、最多 100 条、每次上下文最多读取 20 条，也仍只记录已经消费人工确认并成功发送的命令；不新增磁盘文件、日志或 renderer DTO。

- [ ] **步骤 4：移除主进程与渲染进程的流式二次脱敏**

`ChatRuntime.send()` 使用 `request.content`（仅契约已做的 trim）创建用户消息，不再创建 `safeRequestContent`。provider 的每个 delta 直接累加到完整响应、直接发布，并在最终 `updateMessage`/`chat:completed` 中使用相同原文。

`global-chat.ts` 删除 `sanitizeChatText`、`RendererSensitiveTextStreamRedactor`、`pendingStreams` 和相关候选解析函数；替换为：

```ts
setDraft(chatId: string, value: string): void { state.drafts[chatId] = value }
const value = content.trim()
const visible = messages.filter(message => message.role !== 'system').map(message => ({ ...message }))
// chat:delta
message.content += event.content
// chat:completed
message.content = event.content
```

继续保留 run 所有权、取消、重试、持久化失败公开错误和最大长度 schema。

- [ ] **步骤 5：运行直通与本地保护回归并提交**

运行：

```powershell
npx vitest run tests/unit/chat/chat-context-builder.test.ts tests/unit/chat/chat-runtime.test.ts tests/unit/agent/execution-gateway.test.ts tests/unit/renderer/global-chat.test.ts tests/integration/chat-runtime.test.ts tests/unit/settings/secret-store.test.ts tests/unit/ssh/key-material-store.test.ts tests/unit/shell-history/shell-history-service.test.ts tests/unit/access-client/bridge-diagnostics.test.ts
git add src/main/chat/chat-context-builder.ts src/main/chat/chat-runtime.ts src/main/agent/execution-gateway.ts src/renderer/src/stores/global-chat.ts tests/unit/chat/chat-context-builder.test.ts tests/unit/chat/chat-runtime.test.ts tests/unit/agent/execution-gateway.test.ts tests/unit/renderer/global-chat.test.ts tests/integration/chat-runtime.test.ts
git commit -m "feat: pass global AI context through unchanged"
```

预期：模型链路合成文本逐字符保留；API Key、SSH 密钥材料、Shell 历史和桥接日志保护测试仍通过。

### 任务 12：让 Shell AI 输出原文直通并保留单条命令控制

**文件：**
- 修改：`src/main/agent/agent-model-runtime.ts`
- 修改：`src/main/agent/register-agent-handlers.ts`
- 修改：`tests/unit/agent/agent-runtime.test.ts`
- 修改：`tests/unit/agent/register-agent-handlers.test.ts`
- 检查：`src/main/agent/agent-contracts.ts`
- 检查：`src/main/agent/candidate-confirmation-service.ts`
- 检查：`src/main/agent/execution-gateway.ts`

- [ ] **步骤 1：为原文目标、事实和提案写失败测试**

在 runtime 测试捕获模型 `messages`，传入含 `temporaryPath`、`tokenLike` 和嵌套 facts 的目标，断言完全保留。让模型返回严格 JSON：

```ts
const response = JSON.stringify({
  analysis: `检查 ${temporaryPath} 与 ${tokenLike}`,
  evidenceStrategy: [`读取 ${base64Like}`],
  candidate: { command: `type "${temporaryPath}"`, explanation: `路径 ${tokenLike}` },
})
```

断言 proposal 的四个文本字段原样到达 handler 发布端，不再抛 `UnsafeAgentOutputError`。另保留无效 JSON、缺少 `candidate.command`、多余字段和空命令仍被 schema 拒绝的用例。

- [ ] **步骤 2：运行测试并确认敏感模式仍导致拒绝或替换**

运行：

```powershell
npx vitest run tests/unit/agent/agent-runtime.test.ts tests/unit/agent/register-agent-handlers.test.ts
```

预期：输入被 `sanitizeFacts/redactSensitiveText` 改写，输出被 `assertSafeResult` 或 handler 的敏感检测拒绝。

- [ ] **步骤 3：只移除模型链路脱敏和内容模式拒绝**

`AgentModelRuntime` 删除 `SensitiveTextStreamRedactor`、`sanitizeFacts()`、`assertSafeResult()` 与 `UnsafeAgentOutputError`。`createMessages()` 直接序列化 `request.goal`、`request.hostname` 和调用方已授权的 `request.facts`；系统提示删除“不得索取、推测或输出密码、私钥、API Key、令牌”等本轮脱敏说明，但继续要求中文、严格 JSON、分析、证据策略和一个候选对象。

流式响应仍完整拼接后经 `agentResultSchema.strict()` 解析；每个 provider delta 直接发布 `delta` 事件，最终解析成功后仍使用现有单个 `proposal` 事件原样发布：

```ts
const onDelta = (content: string): void => {
  response += content
  publish({ kind: 'delta', content })
}
await publish({
  kind: 'proposal',
  analysis: parsed.analysis,
  evidenceStrategy: parsed.evidenceStrategy,
  candidate,
})
```

`register-agent-handlers.ts` 删除 proposal 的 `SensitiveTextStreamRedactor` 和 `containsSensitiveMaterial()` 分支，保留 run ID、session 所有权、候选保存和公开基础设施错误。

- [ ] **步骤 4：证明命令审批边界没有扩大**

运行并检查现有契约：

```powershell
npx vitest run tests/unit/agent/candidate-confirmation-service.test.ts tests/unit/agent/confirmation-service.test.ts tests/unit/agent/execution-gateway.test.ts tests/unit/agent/regex-fence-service.test.ts tests/unit/shared/contracts.test.ts
```

预期：`candidate.command` 仍是单个非空字符串；一次性确认、精确命令匹配、确认有效期、安全围栏和自动驾驶授权测试全部通过。不得修改这些模块来支持命令数组。

- [ ] **步骤 5：运行 Agent 回归并提交**

运行：

```powershell
npx vitest run tests/unit/agent
git add src/main/agent/agent-model-runtime.ts src/main/agent/register-agent-handlers.ts tests/unit/agent/agent-runtime.test.ts tests/unit/agent/register-agent-handlers.test.ts
git commit -m "feat: pass shell AI model content through unchanged"
```

预期：合法严格 JSON 即使含路径或令牌形态文本也通过；无效结构和未经确认的命令仍被拒绝。

### 任务 13：完成模型连接左对齐和任务文案收口

**文件：**
- 修改：`src/renderer/src/components/settings/ModelProfileManager.vue`
- 修改：`src/renderer/src/components/workbench/WorkbenchShell.vue`
- 修改：`src/renderer/src/views/WorkbenchView.vue`
- 修改：`src/renderer/src/stores/chat-workspaces.ts`
- 修改：`tests/unit/renderer/settings-panels.test.ts`
- 修改：`tests/unit/renderer/v18-visual-contract.test.ts`
- 修改：`tests/e2e/settings.spec.ts`

- [ ] **步骤 1：先写两类模型列表的几何契约**

源码契约断言 `.profile-select` 同时包含 `width: 100%`、`justify-items: start`、`align-content: start`、`text-align: left`，并且 `.profile-select strong/.profile-select span/.profile-select small` 具有 `width: 100%` 与左对齐。E2E 分别打开大语言模型和视觉语言模型页面，通过 `boundingBox()` 断言名称、提供方/模型、密钥状态三行左边缘差值不超过 1 像素。

- [ ] **步骤 2：运行测试并确认通用 button 居中规则仍有影响**

运行：

```powershell
npx vitest run tests/unit/renderer/settings-panels.test.ts tests/unit/renderer/v18-visual-contract.test.ts
npx playwright test tests/e2e/settings.spec.ts --grep "模型连接左对齐"
```

预期：缺少明确的 grid 对齐和占满宽度规则。

- [ ] **步骤 3：只覆盖连接项内部对齐**

把 `.profile-select` 调整为：

```css
.profile-select {
  display: grid;
  align-content: start;
  justify-items: start;
  gap: 3px;
  width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
}
.profile-select strong,
.profile-select span,
.profile-select small { width: 100%; text-align: left; }
```

不改变 `.profile-layout` 网格列、字段顺序、操作区和现有 `900px/600px` 响应式断点。

- [ ] **步骤 4：扫描并修正本轮范围内的用户可见“聊天”文案**

运行：

```powershell
rg -n "新建聊天|无法新建聊天|无法读取聊天|暂无聊天|未选择聊天|选择聊天|删除聊天|此聊天" src/renderer/src
```

逐项按语义改为“任务”：顶部缺省为 `未选择任务`，侧栏和 store 使用任务，新建/读取/删除错误使用任务，Shell 历史描述使用“此任务”。内部 `chat` 类型、文件名、IPC 和 CSS 类名保持不变，避免无行为价值的重命名。

- [ ] **步骤 5：运行样式与文案测试并提交**

运行：

```powershell
npx vitest run tests/unit/renderer/settings-panels.test.ts tests/unit/renderer/v18-visual-contract.test.ts tests/unit/renderer/chat-workspaces.test.ts
npx playwright test tests/e2e/settings.spec.ts --grep "模型连接左对齐"
git add src/renderer/src/components/settings/ModelProfileManager.vue src/renderer/src/components/workbench/WorkbenchShell.vue src/renderer/src/views/WorkbenchView.vue src/renderer/src/stores/chat-workspaces.ts tests/unit/renderer/settings-panels.test.ts tests/unit/renderer/v18-visual-contract.test.ts tests/e2e/settings.spec.ts
git commit -m "style: align model profiles and task wording"
```

预期：LLM/VLM 三行内容左边缘一致，设置网格与断点不变，本轮任务区域没有遗留用户可见“新建聊天”等旧文案。

### 任务 14：完成真实 Electron 诊断、任务和视觉验收

**文件：**
- 新建：`tests/helpers/node-inspector-client.ts`
- 修改：`tests/e2e/workbench.spec.ts`
- 修改：`tests/e2e/settings.spec.ts`
- 修改：`playwright.config.ts`

- [ ] **步骤 1：编写最小 Inspector 协议测试客户端**

实现一个只供测试调用的 helper：连接从 Node Inspector 窗口 `devtools://` URL 的 `ws` 参数还原出的 `ws://` 地址；按递增 ID 发送 `Runtime.enable` 和 `Runtime.evaluate`；在超时、socket error 或 close 时拒绝所有待处理 Promise；测试结束始终关闭 socket。公开接口固定为：

```ts
export async function evaluateNodeInspector<T>(frontendUrl: string, expression: string): Promise<T>
```

`Runtime.evaluate` 使用 `{ expression, returnByValue: true, throwOnSideEffect: true }`，只允许 E2E 传入仓库内写死的只读表达式。

- [ ] **步骤 2：先写真实诊断窗口失败测试**

在工作台 E2E 中记录主窗口 bounds，点击 `DevTools` 后确认出现独立 DevTools page；再次点击确认 page 数量不增加。关闭后用 `Ctrl+Shift+I` 再次打开同类独立窗口。

点击 `Node Inspector` 后找到 URL 以 `devtools://devtools/bundled/js_app.html` 开头的独立窗口，等待主面板非空，再调用：

```ts
const pid = await evaluateNodeInspector<number>(inspectorWindow.url(), 'process.pid')
const electronPid = await electronApp.evaluate(() => process.pid)
expect(pid).toBe(electronPid)
```

再通过 DevTools 顶部标签或溢出菜单逐一确认 `Sources`、`Console`、`Performance`、`Memory`（或对应本地化标签）四项都可打开，并在 `Sources` 中能搜索到主进程脚本。重复点击窗口数量不增加，关闭后重新打开成功，主窗口 bounds 始终未变。

- [ ] **步骤 3：运行诊断 E2E 并根据真实 Electron 前端修正实现**

运行：

```powershell
npx playwright test tests/e2e/workbench.spec.ts --grep "独立 DevTools|Node Inspector"
```

预期首次运行可能暴露 Electron 43 内置前端查询参数或 ready 时序差异。只允许修正 `nodeInspectorFrontendUrl()`、窗口 ready 等待和 E2E 选择器；不能改为外部 Chrome、`chrome://inspect`、剪贴板地址或手工附加。

- [ ] **步骤 4：覆盖任务重启与两主题两视口截图**

扩展 E2E：从空数据启动，创建任务，分别验证首条 AI 用户消息和首个成功 Shell 关联后的系统标题；验证自定义标题不被后续活动覆盖；验证置顶、取消置顶、删除及重启持久化。测试夹具必须清空本次 E2E 专用 userData，不导入旧版本文件。

在 `1440x900`、`1024x768` 下分别切换珍珠白和石墨黑主题，保存以下截图：

```text
test-results/open-source-polish/pearl-1440x900.png
test-results/open-source-polish/pearl-1024x768.png
test-results/open-source-polish/graphite-1440x900.png
test-results/open-source-polish/graphite-1024x768.png
```

每张图检查：应用按钮与原生窗口按钮不重叠；当前任务标题不被错误消息覆盖；三点菜单和重命名输入不裁切；模型项左对齐；滚动条显隐前后任务标题 `x` 坐标不变。

- [ ] **步骤 5：运行完整 E2E 并提交**

运行：

```powershell
npm run test:e2e
git add tests/helpers/node-inspector-client.ts tests/e2e/workbench.spec.ts tests/e2e/settings.spec.ts playwright.config.ts src/main/diagnostics src/main/main.ts src/renderer/src/views/WorkbenchView.vue
git commit -m "test: verify diagnostics and task polish in Electron"
```

预期：真实 Electron 中两类调试窗口、主进程 PID 附加、任务持久化、两主题和两视口全部通过；截图不存在空白、重叠或布局位移。

### 任务 15：更新说明、发布版本并构建 Windows 1.0.9

**文件：**
- 修改：`README.md`
- 修改：`README-en.md`
- 修改：`RELEASE_NOTES.md`
- 修改：`package.json`
- 修改：`package-lock.json`
- 修改：`tests/unit/windows/app-branding.test.ts`
- 检查：`scripts/windows/finalize-windows-release-artifacts.cjs`
- 检查：`scripts/windows/package-uninstall-cleanup.ps1`
- 验证：`release/Terminal-Agent-Setup-1.0.9.exe`
- 验证：`release/Terminal-Agent-Setup-1.0.9.exe.blockmap`
- 验证：`release/latest.yml`
- 验证：`release/putty.exe`
- 验证：`release/Terminal-Agent-Uninstall-Cleanup-1.0.9.zip`

- [ ] **步骤 1：先把品牌测试期望更新为 1.0.9**

在 `tests/unit/windows/app-branding.test.ts` 将版本断言改为：

```ts
expect(packageJson.version).toBe('1.0.9')
expect(packageLock.version).toBe('1.0.9')
expect(packageLock.packages[''].version).toBe('1.0.9')
```

运行：

```powershell
npx vitest run tests/unit/windows/app-branding.test.ts
```

预期：当前元数据仍为 `1.0.8`，测试失败。

- [ ] **步骤 2：更新版本和双语说明**

运行版本命令：

```powershell
npm version 1.0.9 --no-git-tag-version
```

README 中加入明确警告：Terminal-Agent 不再自动脱敏发送给模型的任务消息、授权主机事实和审计上下文；用户只应配置可信本地模型或集团内网模型，公网模型不会被应用额外阻断。同步说明 DevTools、自动附加 Node Inspector、任务重命名/置顶和旧任务数据不兼容边界。英文 README 表达同一事实。

`RELEASE_NOTES.md` 新增 `1.0.9` 段落，列出诊断窗口、模型原文直通、任务交互、列表左对齐和滚动条；明确没有新增日志中心、没有命令组审批、没有旧任务迁移。

- [ ] **步骤 3：运行全部静态、单元和构建验证**

依次运行：

```powershell
npm test
npm run lint
npm run build
npm run test:e2e
git diff --check
```

预期：所有命令退出码为 0；`git diff --check` 无输出。不得通过跳过诊断 E2E 或安全回归测试来获得绿色结果。

- [ ] **步骤 4：构建安装包后再运行打包集成测试**

运行：

```powershell
npm run make:win
npm run test:integration
```

预期：`make:win` 先生成新的 `release/win-unpacked` 和 NSIS 产物，随后 `test:integration` 验证的正是本轮 `1.0.9` 运行时与启动器。

- [ ] **步骤 5：核对产物名称、大小、时间与哈希**

运行：

```powershell
$artifacts = @(
  'release/Terminal-Agent-Setup-1.0.9.exe',
  'release/Terminal-Agent-Setup-1.0.9.exe.blockmap',
  'release/latest.yml',
  'release/putty.exe',
  'release/Terminal-Agent-Uninstall-Cleanup-1.0.9.zip'
)
Get-Item $artifacts | Select-Object FullName,Length,LastWriteTime
Get-FileHash -Algorithm SHA256 $artifacts | Select-Object Path,Hash
Get-Content release/latest.yml
```

预期：五个文件全部存在且大小非零；`latest.yml` 的 `version`、`path`、文件大小和 SHA-512 指向 `Terminal-Agent-Setup-1.0.9.exe`；记录安装包绝对路径和 SHA-256。

- [ ] **步骤 6：实际冒烟运行打包版并完成发布提交**

从测试专用空 userData 启动 `release/win-unpacked/Terminal-Agent-runtime.exe`，验证主窗口可见、DevTools 可分离、Node Inspector 自动附加、创建/重命名/置顶任务可用，然后正常关闭，确认没有残留 `Terminal-Agent-runtime` 进程或本功能拥有的 Inspector 端口。

最后运行：

```powershell
git add README.md README-en.md RELEASE_NOTES.md package.json package-lock.json tests/unit/windows/app-branding.test.ts
git commit -m "release: prepare Terminal-Agent 1.0.9"
git status --short
git log --oneline --decorate -12
```

预期：工作区干净，提交历史包含计划中的阶段提交；没有自动创建 tag，也没有自动推送远程。

## 最终规格对照

- 任务 8 至 10、14 覆盖分离渲染 DevTools、`Ctrl+Shift+I`、独立自动附加 Node Inspector、窗口复用、回环地址和资源所有权。
- 任务 2 至 7、14 覆盖任务文案、默认标题、首次活动、手动重命名、置顶/取消置顶、重启持久化和不迁移旧数据。
- 任务 11、12 覆盖 AI 工作区与 Shell AI 的模型输入/回复原文直通，并通过既有回归证明本地凭据与执行控制继续存在。
- 任务 7、13、14 覆盖 Gemini 风格滚动条、LLM/VLM 左对齐、两主题和两视口无重叠验收。
- 任务 15 覆盖双语风险说明、版本 `1.0.9`、完整验证、Windows 安装包和哈希记录。
- 全计划没有日志功能、命令组审批或旧任务数据转换步骤。
