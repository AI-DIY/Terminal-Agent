# AI 工作区图文对话与 Shell 计划审批实施计划

> **供智能体执行：** 实施时必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，按任务逐项执行，并维护下列复选框状态。

**目标：** 将右侧 AI 工作区升级为支持图片和文字聊天、LangGraph.js 结构化计划、围栏人工复核、整组顺序发送及聊天内执行审计的受控 Shell 协作界面。

**架构：** 聊天消息以 OpenAI Chat Completions 兼容内容块持久化；主进程根据完整聊天历史路由 LLM 或 VLM。`@langchain/langgraph` 只负责“生成 JSON、校验、最多两次修正”的模型输出闭环。主进程将合法计划材料化为带围栏结果和执行状态的应用内部对象，并通过受限 IPC 处理编辑、删除、取消与整组执行；渲染器不能自行选择目标 `sessionId` 或直接向 Shell 发送计划命令。

**技术栈：** Electron、TypeScript、Vue 3、Zod、Vitest、Playwright、`@langchain/langgraph@^1.4.12`、现有 OpenAI Chat Completions/Ollama/llama.cpp 适配层。

---

## 0. 实施边界和文件图

### 0.1 需要创建的文件

| 文件 | 职责 |
| --- | --- |
| `src/shared/chat-content.ts` | 图片/文字内容块校验、内容归一化、图片检测和文本提取。 |
| `src/shared/chat-plan.ts` | AI 最终 JSON、持久化计划、步骤状态和计划操作请求的共享 Zod 契约。 |
| `src/main/chat/structured-chat-agent.ts` | LangGraph.js 生成、校验、修正闭环；只返回最终合法 JSON。 |
| `src/main/chat/execution-plan-service.ts` | 围栏材料化、人工编辑/删除/取消、会话绑定、顺序写入和审计内容生成。 |
| `tests/unit/shared/chat-content.test.ts` | 内容块、Data URL、图片检测及纯文本兼容测试。 |
| `tests/unit/shared/chat-plan.test.ts` | AI JSON 和计划状态/操作请求契约测试。 |
| `tests/unit/chat/structured-chat-agent.test.ts` | LangGraph.js 三次调用上限、结构校验和语义修正测试。 |
| `tests/unit/chat/execution-plan-service.test.ts` | 围栏、编辑、删除、绑定、顺序发送和审计测试。 |

### 0.2 需要修改的主要文件

| 文件 | 修改职责 |
| --- | --- |
| `package.json`、`package-lock.json` | 增加 LangGraph.js 依赖。 |
| `src/shared/contracts.ts` | 将聊天消息、运行事件和 IPC 请求改为共享内容/计划契约。 |
| `src/main/model/chat-completions-client.ts` | 支持 Chat Completions 多模态 `content` 内容块。 |
| `src/main/model/model-provider-router.ts` | 保留 OpenAI 兼容内容块，转换 Ollama 图片格式并传递 JSON Schema。 |
| `src/main/chat/chat-contracts.ts`、`chat-repository.ts`、`chat-service.ts` | 持久化 `messageType` 和 `executionPlan`，并保持任务数据版本 2 与纯文本历史兼容。 |
| `src/main/chat/chat-context-builder.ts`、`token-estimator.ts` | 删除内部应用字段，保留审计正文，识别图片并按文本部分估算上下文。 |
| `src/main/chat/chat-runtime.ts` | 以结构化代理替换用户可见的普通流式模型输出；只发布最终 JSON。 |
| `src/main/chat/register-chat-handlers.ts` | 注册计划编辑、删除、取消、执行 IPC，并保持可信渲染器校验。 |
| `src/main/main.ts` | 组合模型路由、结构化代理、计划服务和运行上下文；移除聊天上下文中的内存审计重复注入。 |
| `src/preload/api.ts` | 暴露受类型和参数校验约束的图片聊天及计划操作 API。 |
| `src/renderer/src/stores/global-chat.ts` | 维护多模态用户草稿、最终 JSON 消息和计划更新。 |
| `src/renderer/src/components/chat/GlobalChatPanel.vue` | 图片选择、普通回复/计划/审计区分渲染、围栏详情、编辑/删除/确认及悬浮滚动条。 |
| `src/renderer/src/views/WorkbenchView.vue` | 移除右侧全自动驾驶入口、升级弹窗和相关事件传递。 |
| `src/renderer/src/components/workbench/WorkbenchShell.vue`、`src/renderer/src/stores/layout-preferences.ts` | 将 AI 工作区的上限改为客户区 45%，并修正窄窗口适配。 |
| `tests/unit/...`、`tests/e2e/workbench.spec.ts` | 更新旧断言，新增模型、计划和视觉端到端覆盖。 |

### 0.3 保留而不作为本次重构对象的旧能力

- `src/main/agent/*` 中的旧单 Shell 分析、候选命令和 `ExecutionGateway` 保持兼容，不作为右侧 AI 工作区的执行入口。
- `SessionMode` 与旧 IPC 可暂时保留给既有模块和历史测试，但 `GlobalChatPanel.vue`、`WorkbenchView.vue` 不得再提供全自动驾驶入口或自动发送路径。
- SSH 凭据、API Key、私钥、私钥口令、AccessClient 临时桥接密码、主机记忆和 Shell 历史保持现有隔离边界。

## 1. 实现顺序

```text
共享内容与计划契约
        |
持久化与上下文映射 ---- 模型多模态适配
        |                     |
        +------ LangGraph.js 结构化代理
                              |
                        ChatRuntime 最终消息
                              |
                    计划服务、IPC 与预加载桥接
                              |
                右侧 UI、图片输入、动态宽度与端到端验证
```

## 2. 任务清单

### 任务 1：安装 LangGraph.js 并建立共享图文/计划契约

**文件：**

- 修改：`package.json`
- 修改：`package-lock.json`
- 创建：`src/shared/chat-content.ts`
- 创建：`src/shared/chat-plan.ts`
- 修改：`src/shared/contracts.ts`
- 创建：`tests/unit/shared/chat-content.test.ts`
- 创建：`tests/unit/shared/chat-plan.test.ts`
- 修改：`tests/unit/shared/contracts.test.ts`

- [ ] **步骤 1：先写内容块与计划契约的失败测试。**

```ts
// tests/unit/shared/chat-content.test.ts
it('accepts text and image_url blocks while rejecting non-image Data URLs', () => {
  expect(chatMessageContentSchema.parse([
    { type: 'text', text: '检查截图' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
  ])).toHaveLength(2)
  expect(() => chatMessageContentSchema.parse([
    { type: 'image_url', image_url: { url: 'data:text/plain;base64,QQ==' } },
  ])).toThrow()
})

it('detects images in current and historical message content', () => {
  expect(chatHistoryHasImages([{ role: 'user', content: '纯文字' }])).toBe(false)
  expect(chatHistoryHasImages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA==' } }] }])).toBe(true)
})
```

```ts
// tests/unit/shared/chat-plan.test.ts
it('accepts the final AI JSON only when every plan step has a hostname and executable command', () => {
  expect(parseAssistantPlanOutput(JSON.stringify({
    version: 1,
    reply: '准备执行。',
    plan: { title: '清理缓存', steps: [{ target: 'web-02', explanation: '仅供复核', command: 'rm -rf /srv/cache/*' }] },
  }))).toMatchObject({ plan: { steps: [{ target: 'web-02' }] } })
  expect(() => parseAssistantPlanOutput('{"version":1,"reply":"x","plan":{"title":"x","steps":[]}}')).toThrow()
})

it('allows only restricted plan edit, remove, cancel and execute requests from the renderer', () => {
  expect(chatPlanEditStepRequestSchema.parse({ requestId: 'r1', chatId: 'c1', messageId: 'm1', stepId: 's1', command: 'systemctl restart api' })).toBeDefined()
  expect(() => chatPlanExecuteRequestSchema.parse({ requestId: 'r1', chatId: 'c1', messageId: 'm1', sessionId: 'forged' })).toThrow()
})
```

- [ ] **步骤 2：运行新测试，确认它们在模块不存在时失败。**

运行：

```powershell
npm test -- tests/unit/shared/chat-content.test.ts tests/unit/shared/chat-plan.test.ts
```

预期：失败，提示尚不存在 `chat-content`、`chat-plan` 或导出符号。

- [ ] **步骤 3：安装固定的 Node.js LangGraph.js 依赖。**

运行：

```powershell
npm install @langchain/langgraph@^1.4.12
```

确认 `package.json` 的 `dependencies` 中出现：

```json
"@langchain/langgraph": "^1.4.12"
```

不得安装 Python 包、Python 运行时、LangGraph Platform 或独立服务。

- [ ] **步骤 4：实现 `src/shared/chat-content.ts`。**

实现以下稳定契约和辅助函数，所有内容块使用 `.strict()`：

```ts
export const chatTextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string().max(100_000),
}).strict()

export const chatImageUrlPartSchema = z.object({
  type: z.literal('image_url'),
  image_url: z.object({
    url: z.string().regex(/^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i),
  }).strict(),
}).strict()

export const chatMessageContentSchema = z.union([
  z.string().max(1_000_000),
  z.array(z.union([chatTextPartSchema, chatImageUrlPartSchema])).min(1).max(8),
])

export function chatContentHasImages(content: ChatMessageContent): boolean
export function chatHistoryHasImages(messages: readonly { content: ChatMessageContent }[]): boolean
export function chatContentText(content: ChatMessageContent): string
export function chatImageCount(content: ChatMessageContent): number
```

对 Data URL 额外按解码后字节数限制单图不超过 `5 * 1024 * 1024`，并在 `chatMessageContentSchema` 的 `superRefine` 中拒绝超过 8 张图或总 Data URL 超过 `8_000_000` 字符。纯文本继续兼容现有 `1_000_000` 字符上限。`chatContentText()` 只拼接 `text` 块，绝不把 Base64 图像串加入上下文估算或 UI 摘要。

- [ ] **步骤 5：实现 `src/shared/chat-plan.ts`。**

定义并导出以下类型与模式：

```ts
export const assistantPlanOutputSchema = z.object({
  version: z.literal(1),
  reply: z.string().trim().min(1).max(12_000),
  plan: z.object({
    title: z.string().trim().min(1).max(255),
    steps: z.array(z.object({
      target: hostnameSchema,
      explanation: z.string().trim().min(1).max(4_000),
      command: z.string().trim().min(1).max(64 * 1024).refine(value => !value.includes('\0')),
    }).strict()).min(1).max(32),
  }).strict().nullable(),
}).strict()

export const executionPlanStatusSchema = z.enum([
  'pending_review', 'executing', 'executed', 'partially_executed', 'execution_failed', 'cancelled',
])

export const executionPlanStepSchema = z.object({
  id: chatIdentifierSchema,
  target: hostnameSchema,
  explanation: z.string().trim().min(1).max(4_000),
  originalCommand: z.string().trim().min(1).max(64 * 1024).refine(value => !value.includes('\0')),
  finalCommand: z.string().trim().min(1).max(64 * 1024).refine(value => !value.includes('\0')).optional(),
  fence: z.object({ ruleId: z.string(), ruleName: z.string() }).strict().optional(),
  sessionId: terminalSessionIdSchema.optional(),
  sendState: z.enum(['pending', 'sent', 'failed', 'not_sent']),
  failure: z.string().max(1_000).optional(),
}).strict()

export const chatExecutionPlanSchema = z.object({
  id: chatIdentifierSchema,
  title: z.string().trim().min(1).max(255),
  status: executionPlanStatusSchema,
  steps: z.array(executionPlanStepSchema).min(1).max(32),
}).strict()
```

同时定义受限渲染器请求：`chatPlanEditStepRequestSchema`、`chatPlanRemoveStepRequestSchema`、`chatPlanCancelRequestSchema`、`chatPlanExecuteRequestSchema`。它们只含 `requestId`、`chatId`、`messageId` 及该动作必需的 `stepId` 或 `command`；执行请求绝不接受 `sessionId`、命令数组、围栏结果或计划状态。提供 `parseAssistantPlanOutput(value: string)`，只接受完整 JSON，不接受 Markdown 围栏。

- [ ] **步骤 6：将共享契约接入 `src/shared/contracts.ts`。**

将 `chatMessageRecordSchema`、`chatAppendMessageRequestSchema`、`chatUpdateMessageRequestSchema` 和 `chatRunRequestSchema` 的 `content` 改为 `chatMessageContentSchema`。增加：

```ts
messageType: z.literal('execution_audit').optional(),
executionPlan: chatExecutionPlanSchema.optional(),
```

并通过 `superRefine` 保证：

- `messageType: 'execution_audit'` 只允许 `role: 'user'`、`state: 'complete'`；
- `executionPlan` 只允许 `role: 'assistant'`、`state: 'complete'`；
- 多模态内容块只允许 `role: 'user'`；`assistant`、`system` 和执行审计的 `content` 必须是字符串，避免把图片或应用内部内容伪装成模型回复；
- `chatRunRequestSchema` 的纯图片内容合法，纯文本仍需去除首尾空白后非空；
- 运行事件的 `chat:completed` 可携带可选 `executionPlan`，但 `chat:delta` 和 `chat:error` 不可携带。

保留 `SessionMode` 和旧 agent 契约以避免无关破坏；本任务不再给右侧聊天使用它。

- [ ] **步骤 7：运行共享契约测试并提交。**

运行：

```powershell
npm test -- tests/unit/shared/chat-content.test.ts tests/unit/shared/chat-plan.test.ts tests/unit/shared/contracts.test.ts
```

预期：全部通过。

提交：

```powershell
git add package.json package-lock.json src/shared/chat-content.ts src/shared/chat-plan.ts src/shared/contracts.ts tests/unit/shared
git commit -m "feat: add multimodal chat and execution plan contracts"
```

### 任务 2：让聊天仓库持久化多模态消息、审计类型和计划状态

**文件：**

- 修改：`src/main/chat/chat-contracts.ts`
- 修改：`src/main/chat/chat-repository.ts`
- 修改：`src/main/chat/chat-service.ts`
- 修改：`tests/unit/chat/chat-contracts.test.ts`
- 修改：`tests/unit/chat/chat-repository.test.ts`
- 修改：`tests/unit/chat/chat-service.test.ts`

- [ ] **步骤 1：为版本 2 兼容和消息计划写失败测试。**

```ts
it('round-trips a version-2 text-and-image user message without changing the document version', async () => {
  const created = await repository.create({ requestId: 'create-1' })
  await repository.appendMessage({
    requestId: 'image-1', chatId: created.value.id, role: 'user', state: 'complete',
    content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
  })
  expect((await repository.get(created.value.id)).messages[0]?.content).toEqual(expect.any(Array))
})

it('persists a complete assistant message with a materialized execution plan and an audit user message', async () => {
  const created = await repository.create({ requestId: 'create-plan' })
  const chatId = created.value.id
  await repository.appendMessage({
    requestId: 'assistant-plan', chatId, role: 'assistant', state: 'complete', content: '{"version":1,"reply":"准备执行","plan":null}',
    executionPlan: { id: 'EP-1', title: '检查', status: 'pending_review', steps: [{ id: 'step-1', target: 'web-02', explanation: '查看状态', originalCommand: 'systemctl status api', sendState: 'pending' }] },
  })
  await repository.appendMessage({ requestId: 'audit-1', chatId, role: 'user', state: 'complete', messageType: 'execution_audit', content: '【执行审计】计划 EP-1 已发送。' })
  expect((await repository.get(chatId)).messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'assistant', executionPlan: expect.objectContaining({ id: 'EP-1' }) }),
    expect.objectContaining({ role: 'user', messageType: 'execution_audit' }),
  ]))
})
```

还要覆盖：旧纯字符串记录正常加载；审计 `messageType` 不会出现在普通 user 消息；计划操作更新消息时，`requestFingerprint` 包含 `executionPlan`；流式或 error assistant 不能携带计划。

- [ ] **步骤 2：运行失败测试。**

运行：

```powershell
npm test -- tests/unit/chat/chat-contracts.test.ts tests/unit/chat/chat-repository.test.ts tests/unit/chat/chat-service.test.ts
```

预期：因仓库未复制、更新和校验新字段而失败。

- [ ] **步骤 3：扩展 `chat-contracts.ts` 的持久化不变量。**

保持 `chatDocumentSchema.version` 为 `2`，不重新引入版本 1 迁移。让 `persistedMessageSchema` 使用共享消息记录模式，并在下列位置传播 `messageType` 与 `executionPlan`：

```ts
// append/update 操作的 fingerprint 必须包含可选内部字段，避免同 requestId 篡改。
requestFingerprint('appendMessage', [
  parsed.chatId, parsed.role, parsed.content, parsed.state,
  parsed.retryable ?? null, parsed.messageType ?? null, parsed.executionPlan ?? null,
])
```

在文档校验中补充：`updateMessage` 必须仍引用由 `appendMessage` 创建的消息；操作结果快照仍只记录任务标题、置顶、时间和模式，不把大计划复制到操作快照中。

- [ ] **步骤 4：扩展仓库和服务的克隆/更新路径。**

在 `appendMessage`、`updateMessage`、`toWorkspace`、中断流恢复和重试查询路径中完整保留：

```ts
...(message.messageType ? { messageType: message.messageType } : {}),
...(message.executionPlan ? { executionPlan: structuredClone(message.executionPlan) } : {}),
```

`findRetryMessage` 以规范化 `JSON.stringify(content)` 比较用户内容，允许图文请求重试；它只将最后一条普通用户消息作为重试源，`messageType: 'execution_audit'` 不能成为重试源。更新消息时，缺失的可选字段必须明确删除，避免旧计划残留在已取消或错误消息上。`content` 为数组时以 `structuredClone()` 复制，不能让缓存、存储对象或渲染器草稿共享图片数组引用。

- [ ] **步骤 5：运行仓库和服务测试。**

运行：

```powershell
npm test -- tests/unit/chat/chat-contracts.test.ts tests/unit/chat/chat-repository.test.ts tests/unit/chat/chat-service.test.ts
```

预期：全部通过，且现有任务标题、置顶、Shell 关联和幂等测试继续通过。

- [ ] **步骤 6：提交持久化改造。**

```powershell
git add src/main/chat/chat-contracts.ts src/main/chat/chat-repository.ts src/main/chat/chat-service.ts tests/unit/chat
git commit -m "feat: persist multimodal chat plans and execution audits"
```

### 任务 3：扩展模型消息映射、上下文构造和历史图片路由

**文件：**

- 修改：`src/main/model/chat-completions-client.ts`
- 修改：`src/main/model/model-provider-router.ts`
- 修改：`src/main/chat/chat-context-builder.ts`
- 修改：`src/main/chat/token-estimator.ts`
- 修改：`tests/unit/model/chat-completions-client.test.ts`
- 修改：`tests/unit/model/model-provider-router.test.ts`
- 修改：`tests/unit/chat/chat-context-builder.test.ts`
- 修改：`tests/unit/chat/token-estimator.test.ts`

- [ ] **步骤 1：写失败测试，锁定提供方请求和模型路由行为。**

```ts
it('keeps OpenAI-compatible image_url blocks in the outgoing Chat Completions request', async () => {
  await client.stream(settings, [{ role: 'user', content: [
    { type: 'text', text: '检查' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
  ] }], vi.fn())
  expect(JSON.parse(fetcher.mock.calls[0]?.[1].body)).toMatchObject({
    messages: [{ content: [{ type: 'text' }, { type: 'image_url' }] }],
  })
})

it('maps Data URL images to Ollama message images without placing Base64 in text content', async () => {
  await router.stream(ollamaSettings, [{ role: 'user', content: [
    { type: 'text', text: '检查' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
  ] }], vi.fn())
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toMatchObject({
    messages: [{ role: 'user', content: '检查', images: ['AA=='] }],
  })
})

it('selects VLM when the caller marks the current chat history as image-bearing', () => {
  expect(router.route({ routing: 'combined', hasImages: true, llm: llmSettings, vlm: vlmSettings }))
    .toBe(vlmSettings)
  expect(router.route({ routing: 'combined', hasImages: false, llm: llmSettings, vlm: vlmSettings }))
    .toBe(llmSettings)
})
```

- [ ] **步骤 2：运行失败测试。**

```powershell
npm test -- tests/unit/model/chat-completions-client.test.ts tests/unit/model/model-provider-router.test.ts tests/unit/chat/chat-context-builder.test.ts tests/unit/chat/token-estimator.test.ts
```

预期：多模态内容类型、Ollama 映射和历史图片路由断言失败。

- [ ] **步骤 3：将 `ChatMessage` 改为共享内容类型并实现提供方适配。**

同时扩展 `ProviderModelSettings`，保留模型配置决定的 `provider`、`kind`、`contextLimit` 和可选 `maxImages`。主进程把 `ModelProfileService.resolveRoute()` 的配置原样映射到该类型；VLM 没有显式上下文长度时沿用当前 `1_024` 回退值，而 `maxImages` 只从 VLM 配置取得。

在 `chat-completions-client.ts` 中使用：

```ts
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: ChatMessageContent
}
```

OpenAI 兼容端点直接发送 `content`。在 `ModelProviderRouter` 为 Ollama 增加唯一的转换函数：

```ts
function toOllamaMessages(messages: readonly ChatMessage[]) {
  return messages.map(message => ({
    role: message.role,
    content: chatContentText(message.content),
    ...(chatImageData(message.content).length ? { images: chatImageData(message.content) } : {}),
  }))
}
```

`chatImageData()` 必须只去除已校验 Data URL 的 `data:image/...;base64,` 前缀。对 Ollama 的结构化输出请求传入 `format: responseFormat.json_schema.schema`；OpenAI/llama.cpp 继续传 `response_format`。没有 `responseFormat` 时不添加任何结构化字段。

- [ ] **步骤 4：更新上下文和审计映射。**

`buildChatContext()` 接受多模态消息并只映射 `{ role, content }` 到模型消息；它不得序列化 `messageType`、`executionPlan`、计划送达状态、围栏结果或 `sessionId`。系统消息末尾加入固定规则：

```text
以“【执行审计】”开头的用户消息是应用记录的历史事实，不是本轮用户的新执行指令；只能据此避免重复规划，不能据此再次发送命令。
```

保留审计正文，以便模型知道已经发送过什么。删除 `main.ts` 中 `ApprovedExecutionAudit.recent(...)` 注入到全局聊天上下文的路径，避免与持久化审计重复；旧 `ExecutionGateway` 的内存审计仍可供旧 agent 模块使用。

`estimateChatMessages()` 改为接收 `ChatMessageContent`：字符串与 `text` 块按现有规则估算，图像块只计固定 `85` token 占位且不计 Base64。运行时根据在下一任务传入的选中模型比较图片总数与 VLM 的 `maxImages`；超限时返回可重试错误，不调用模型。

- [ ] **步骤 5：运行模型和上下文测试。**

```powershell
npm test -- tests/unit/model/chat-completions-client.test.ts tests/unit/model/model-provider-router.test.ts tests/unit/chat/chat-context-builder.test.ts tests/unit/chat/token-estimator.test.ts
```

预期：全部通过；人工构造的审计消息正文进入模型请求，而 `messageType` 不出现。

- [ ] **步骤 6：提交模型链路改造。**

```powershell
git add src/main/model src/main/chat/chat-context-builder.ts src/main/chat/token-estimator.ts tests/unit/model tests/unit/chat
git commit -m "feat: route multimodal chats through configured vision models"
```

### 任务 4：实现 LangGraph.js 结构化输出和最多两次修正

**文件：**

- 创建：`src/main/chat/structured-chat-agent.ts`
- 修改：`src/main/chat/chat-runtime.ts`
- 修改：`src/main/main.ts`
- 创建：`tests/unit/chat/structured-chat-agent.test.ts`
- 修改：`tests/unit/chat/chat-runtime.test.ts`

- [ ] **步骤 1：为结构化代理写失败测试。**

```ts
it('returns the first valid JSON response without exposing provider deltas', async () => {
  const agent = new StructuredChatAgent({ complete: vi.fn().mockResolvedValue(validReply) })
  await expect(agent.run(request)).resolves.toMatchObject({ reply: '已准备。', plan: null })
  expect(agent.complete).toHaveBeenCalledTimes(1)
})

it('repairs invalid JSON twice at most and fails after the third model call', async () => {
  const complete = vi.fn()
    .mockResolvedValueOnce('{not json')
    .mockResolvedValueOnce('{still invalid')
    .mockResolvedValueOnce('{also invalid')
  await expect(new StructuredChatAgent({ complete }).run(request)).rejects.toThrow('AI 未能生成可执行计划，请重试。')
  expect(complete).toHaveBeenCalledTimes(3)
})

it('asks for a repair when a syntactically valid plan targets an offline hostname', async () => {
  const complete = vi.fn()
    .mockResolvedValueOnce('{"version":1,"reply":"准备","plan":{"title":"检查","steps":[{"target":"missing-host","explanation":"检查","command":"pwd"}]}}')
    .mockResolvedValueOnce('{"version":1,"reply":"准备","plan":{"title":"检查","steps":[{"target":"web-02","explanation":"检查","command":"pwd"}]}}')
  await expect(new StructuredChatAgent({ complete }).run({ ...request, availableHostnames: ['web-02'] }))
    .resolves.toMatchObject({ plan: { steps: [{ target: 'web-02' }] } })
  expect(complete).toHaveBeenCalledTimes(2)
})
```

运行：

```powershell
npm test -- tests/unit/chat/structured-chat-agent.test.ts
```

预期：失败，模块不存在。

- [ ] **步骤 2：实现 `StructuredChatAgent` 的 LangGraph.js 状态图。**

使用 `Annotation.Root`、`StateGraph`、`START` 与 `END`，状态至少具有：

```ts
type GraphState = {
  messages: ChatMessage[]
  availableHostnames: string[]
  attempts: number
  raw: string
  validationError: string | null
  result: AssistantPlanOutput | null
}
```

节点职责固定如下：

```ts
generate -> validate -> (complete | repair -> generate | fail)
```

- `generate` 用收集器调用现有模型 `stream()`，只积累字符串，不向渲染器发布 delta；首次请求和每次修正都传相同 JSON Schema。
- `validate` 用 `parseAssistantPlanOutput()`，并检查每个 `plan.steps[].target` 都位于当前聊天已关联且状态为 `open` 的 `availableHostnames`；不得把其他聊天的在线 Shell 作为可选目标。
- `repair` 在原上下文之后追加一个只含上一次原始输出和本地校验错误的用户消息，明确要求“仅返回完整 JSON，禁止 Markdown 和解释”。
- 条件边在 `attempts < 3` 时回到 `generate`；第三次失败进入 `fail`。
- `fail` 抛出固定中文错误 `AI 未能生成可执行计划，请重试。`，不携带原始模型文本。

系统提示必须包含协议、在线主机名列表、`reply` 不执行、`explanation` 不执行、`command` 可直接写入 Shell、审计事实规则和禁止 Markdown 围栏。它不能要求模型生成计划 ID、围栏结果、风险说明、最终人工命令或 `sessionId`。

- [ ] **步骤 3：将运行时替换为最终结果模型。**

重构 `ChatRuntime` 依赖为：

```ts
getContext(chatId: string): Promise<{
  messages: ChatMessage[]
  hasImages: boolean
  availableHostnames: string[]
}>
resolveModel(input: { hasImages: boolean }): Promise<ProviderModelSettings>
runStructured(settings: ProviderModelSettings, input: StructuredChatRequest, signal: AbortSignal): Promise<AssistantPlanOutput>
```

保留现有用户消息持久化、取消、超时、覆盖、错误和重试语义；改变点仅为：不再发布模型流式 delta，成功时以完整 JSON 更新 assistant 消息并在 `chat:completed` 中发布。此阶段先不材料化 `plan`，所以新计划字段为空；中间无效 JSON 永远不进入 `assistant.content`、事件或 UI。

将 `main.ts` 的 `ChatRuntime` 组合改为：先读取持久化的当前聊天工作区，调用 `chatHistoryHasImages(snapshot.chat.messages)`，再执行 `modelProfiles.resolveRoute({ hasImages })`。仅当路由为 `combined` 且历史无图时选 LLM；历史任意消息有图时选 VLM；`vision-only` 始终选 VLM。渲染器不得传入或覆盖 `hasImages`。随后构建上下文并调用 `StructuredChatAgent.run()`；当前聊天的 `availableHostnames` 必须从任务关联且仍在线的 Shell 中派生。解析当前模型后，以 `chatImageCount()` 检查完整上下文图片数不超过 VLM 的 `maxImages`；超限时返回可重试错误且不调用模型。计划材料化在下一任务接入，避免该任务依赖尚不存在的执行服务。

- [ ] **步骤 4：运行结构化运行时测试。**

```powershell
npm test -- tests/unit/chat/structured-chat-agent.test.ts tests/unit/chat/chat-runtime.test.ts tests/integration/chat-runtime.test.ts
```

预期：通过首次成功、一次/两次修正、第三次失败、取消、超时、覆盖、旧图片历史触发 VLM、图片数超限拒绝和现有文本消息兼容测试。

- [ ] **步骤 5：提交结构化代理。**

```powershell
git add src/main/chat/structured-chat-agent.ts src/main/chat/chat-runtime.ts src/main/main.ts tests/unit/chat/structured-chat-agent.test.ts tests/unit/chat/chat-runtime.test.ts tests/integration/chat-runtime.test.ts
git commit -m "feat: generate validated chat plans with LangGraph"
```

### 任务 5：实现主进程计划服务和整组顺序发送

**文件：**

- 创建：`src/main/chat/execution-plan-service.ts`
- 修改：`src/main/chat/chat-runtime.ts`
- 修改：`src/main/chat/register-chat-handlers.ts`
- 修改：`src/main/main.ts`
- 创建：`tests/unit/chat/execution-plan-service.test.ts`
- 修改：`tests/unit/chat/chat-runtime.test.ts`
- 修改：`tests/unit/chat/register-chat-handlers.test.ts`

- [ ] **步骤 1：写计划材料化与执行服务的失败测试。**

```ts
it('marks only AI original commands with matching regex fences', () => {
  const plan = service.materialize({ title: '清理', steps: [
    { target: 'web-02', explanation: '说明', command: 'rm -rf /tmp/cache' },
  ] })
  expect(plan.steps[0]?.fence).toEqual({ ruleId: 'remove-files', ruleName: '删除文件' })
})

it('edits a fenced step without calling match again and preserves originalCommand', async () => {
  await service.editStep(editRequest)
  expect(regex.match).toHaveBeenCalledTimes(1)
  expect(updatedStep).toMatchObject({ originalCommand: 'rm -rf /tmp/cache', finalCommand: 'rm -r /tmp/cache' })
})

it('selects the first still-online same-host Shell, writes final commands in step order, and appends one audit', async () => {
  sessions.snapshot.mockReturnValue([
    { id: 'first-web', hostname: 'web-02', mode: 'copilot' },
    { id: 'second-web', hostname: 'web-02', mode: 'copilot' },
    { id: 'db', hostname: 'db-01', mode: 'copilot' },
  ])
  await service.execute(executeRequest)
  expect(sessions.write.mock.calls).toEqual([
    ['first-web', 'first-command\n'], ['db', 'second-command\n'],
  ])
  expect(appendAudit).toHaveBeenCalledWith(expect.objectContaining({ role: 'user', messageType: 'execution_audit' }))
})

it('stops later steps after a write failure and records partially_executed without retrying', async () => {
  sessions.snapshot.mockReturnValue([
    { id: 'web', hostname: 'web-02', mode: 'copilot' },
    { id: 'db', hostname: 'db-01', mode: 'copilot' },
    { id: 'cache', hostname: 'cache-01', mode: 'copilot' },
  ])
  sessions.write.mockImplementation((sessionId: string) => {
    if (sessionId === 'db') throw new Error('closed')
  })
  await service.execute(threeStepExecuteRequest)
  expect(sessions.write.mock.calls.map(([sessionId]: [string]) => sessionId)).toEqual(['web', 'db'])
  expect(savedPlan()).toMatchObject({ status: 'partially_executed', steps: [
    { sendState: 'sent' }, { sendState: 'failed' }, { sendState: 'not_sent' },
  ] })
})
```

- [ ] **步骤 2：运行计划服务测试，确认失败。**

```powershell
npm test -- tests/unit/chat/execution-plan-service.test.ts tests/unit/chat/register-chat-handlers.test.ts
```

预期：失败，计划服务和 IPC 路由尚不存在。

- [ ] **步骤 3：实现材料化、风险说明和待审批操作。**

`ExecutionPlanService.materialize()` 由运行时调用，负责生成主进程计划 ID 和步骤 ID，决不能接受模型提供的 ID：

```ts
materialize(plan: NonNullable<AssistantPlanOutput['plan']>): ChatExecutionPlan {
  return {
    id: `EP-${this.createId()}`,
    title: plan.title,
    status: 'pending_review',
    steps: plan.steps.map(step => {
      const matched = this.fence.match(step.command)
      return {
        id: this.createId(), target: step.target, explanation: step.explanation,
        originalCommand: step.command, sendState: 'pending',
        ...(matched ? { fence: { ruleId: matched.id, ruleName: matched.name } } : {}),
      }
    }),
  }
}
```

每个步骤的围栏匹配只调用一次，再映射成 `fence: { ruleId, ruleName }`，不能把 `RegexFenceMatch` 展开为任意对象。风险说明由本地纯函数 `describeFenceRisk(ruleName, originalCommand)` 生成固定中文模板；它只在 UI 查询时派生，绝不来自模型，也绝不发送给 Shell。

`editStep()` 只在 `pending_review` 下允许非空、无 NUL 的最终命令，保存 `finalCommand` 而不修改 `originalCommand`，不调用围栏匹配。`removeStep()` 删除普通步骤；若它是最后一个保留步骤，则将计划改为 `cancelled`，不留下空计划。`cancel()` 也将计划置为 `cancelled`，两者均禁止后续操作。每次都读取 assistant 消息、验证角色/状态/计划 ID，再通过 `ChatService.updateMessage()` 持久化同一 `content` 和新 `executionPlan`。

- [ ] **步骤 4：实现锁定、绑定、顺序发送和审计。**

`execute()` 必须采用以下次序：

```ts
const current = await requirePendingPlan(request)
const workspace = await chats.get(request.chatId)
const bound = bindEveryStepToEarliestOpenAssociatedSession(current.steps, workspace.chat.shells, sessions.snapshot())
await savePlan({ ...current, status: 'executing', steps: bound })

for (const step of bound.steps) {
  if (!step.sessionId) return finishAfterFailure(step, '目标 Shell 已断开或不可用')
  try {
    sessions.write(step.sessionId, `${step.finalCommand ?? step.originalCommand}\n`)
    await saveStepState(step.id, 'sent')
  } catch {
    return finishAfterFailure(step, '命令未能写入目标 Shell')
  }
}
return finishAllSent()
```

实现细节：

- 先从当前聊天的 `shells` 取 `status: 'open'` 且有 `sessionId` 的关联；再按 `SessionService.snapshot()` 返回顺序，从这些关联会话中选择第一个同名在线 Shell。不得使用其他聊天的同名连接，也不得按最后活动、标题或渲染器焦点选择。
- 在第一次写入前先持久化 `executing` 与全部 `sessionId`，使已确认计划永久锁定。
- 在执行过程中用 `activePlanIds` 集合拒绝同一计划的并发 execute IPC，防止双击重复发送。
- 写入后仅标记 `sent`，不读取输出、不等待提示符、不解析退出码。
- 第一步失败时最终状态为 `execution_failed`；至少一个步骤已发送后失败时为 `partially_executed`；失败步骤标记 `failed`，之后步骤标记 `not_sent`。
- 每种终态都调用 `appendExecutionAudit()` 一次；审计 `content` 只包括计划 ID、终态、主机、每个步骤的最终命令和 sent/failed/not_sent 结论，不含输出、退出码、鼠标点击或模型修正内容。
- 如果确认锁定无法持久化，绝不写 Shell；如果发送后审计无法持久化，返回明确错误，不伪称审计已保存。

- [ ] **步骤 5：注册受限 IPC。**

在 `register-chat-handlers.ts` 增加：

```ts
'chat:plan:edit-step'
'chat:plan:remove-step'
'chat:plan:cancel'
'chat:plan:execute'
```

每个 handler 先执行 `assertTrustedSender`，再用共享模式解析请求，最后调用 `ExecutionPlanService`。在卸载函数中移除所有新 channel。`ChatHandlerService` 不向渲染器暴露 `appendMessage` 或任意 `updateMessage`，避免 renderer 伪造审计、围栏结果、状态或会话绑定。

在 `main.ts` 中构造 `ExecutionPlanService`，传入 `chats`、`sessions`、`regexRules`、确定性的 `now`/ID 依赖；同时将它传给聊天处理器和运行时计划材料化回调。此处扩展 `ChatRuntime` 成功路径：在完整 JSON 写入 assistant 消息前，`plan !== null` 时调用 `materialize()` 并把返回值与同一条 assistant 消息、`chat:completed` 事件一起持久化和发布；`plan === null` 时不附带 `executionPlan`。

- [ ] **步骤 6：运行计划服务和 handler 测试。**

```powershell
npm test -- tests/unit/chat/execution-plan-service.test.ts tests/unit/chat/register-chat-handlers.test.ts tests/unit/chat/chat-service.test.ts
```

预期：覆盖围栏命中、人工修改不重检、删除、一次确认、同名会话选择、全部发送、中途失败、审计一次写入与不可信 renderer 拒绝。

- [ ] **步骤 7：提交受控执行闭环。**

```powershell
git add src/main/chat/execution-plan-service.ts src/main/chat/chat-runtime.ts src/main/chat/register-chat-handlers.ts src/main/main.ts tests/unit/chat/execution-plan-service.test.ts tests/unit/chat/chat-runtime.test.ts tests/unit/chat/register-chat-handlers.test.ts
git commit -m "feat: execute approved Shell plans in order"
```

### 任务 6：扩展预加载桥接和全局聊天状态

**文件：**

- 修改：`src/preload/api.ts`
- 修改：`src/preload/index.ts`
- 修改：`src/renderer/src/stores/global-chat.ts`
- 修改：`tests/unit/preload/api.test.ts`
- 修改：`tests/unit/renderer/global-chat.test.ts`

- [ ] **步骤 1：写失败测试。**

```ts
it('exposes only typed plan mutations under terminalAgent.chat.plans', async () => {
  const api = createTerminalAgentApi(ipc)
  await api.chat.plans.editStep({ requestId: 'r1', chatId: 'c1', messageId: 'm1', stepId: 's1', command: 'pwd' })
  expect(ipc.invoke).toHaveBeenCalledWith('chat:plan:edit-step', expect.objectContaining({ stepId: 's1' }))
})

it('keeps an image-only user content value through optimistic send and retry', async () => {
  await store.send('c1', [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }])
  expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ content: expect.any(Array) }))
})

it('hydrates a final assistant JSON with its executionPlan and preserves audit presentation metadata', () => {
  store.hydrate('c1', [
    { id: 'm1', role: 'assistant', content: '{"version":1,"reply":"已准备","plan":null}', state: 'complete', executionPlan: pendingPlan },
    { id: 'm2', role: 'user', content: '【执行审计】计划 EP-1 已发送。', state: 'complete', messageType: 'execution_audit' },
  ])
  expect(store.state.messages.c1).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'm1', executionPlan: pendingPlan }),
    expect.objectContaining({ id: 'm2', messageType: 'execution_audit' }),
  ]))
})
```

- [ ] **步骤 2：运行失败测试。**

```powershell
npm test -- tests/unit/preload/api.test.ts tests/unit/renderer/global-chat.test.ts
```

预期：新 API、内容类型和计划事件尚不存在。

- [ ] **步骤 3：实现预加载 API。**

在 `TerminalAgentApi.chat` 下增加冻结的 `plans` 对象：

```ts
plans: {
  editStep(request: ChatPlanEditStepRequest): Promise<ChatWorkspaceSnapshot>
  removeStep(request: ChatPlanRemoveStepRequest): Promise<ChatWorkspaceSnapshot>
  cancel(request: ChatPlanCancelRequest): Promise<ChatWorkspaceSnapshot>
  execute(request: ChatPlanExecuteRequest): Promise<ChatWorkspaceSnapshot>
}
```

每个方法在调用 `ipcRenderer.invoke()` 前以对应 Zod schema 解析输入。不得向 API 添加原始 `sessions.write` 的计划快捷通道，也不得返回可修改的主进程计划对象引用。

- [ ] **步骤 4：重构 `global-chat.ts` 的内容和计划状态。**

将内部 `Message` 改为从 `ChatMessageRecord` 投影，保留：

```ts
type Message = Pick<ChatMessageRecord,
  'id' | 'role' | 'content' | 'state' | 'retryable' | 'messageType' | 'executionPlan'>
```

草稿文本仍是 `Record<chatId, string>`；另建 `pendingImages: Record<string, ChatImageUrlPart[]>`，并提供：

```ts
setPendingImages(chatId: string, images: ChatImageUrlPart[]): void
removePendingImage(chatId: string, index: number): void
composeUserContent(chatId: string): ChatMessageContent | null
```

`send()` 接收已组合的内容，允许仅图片。`lastUserMessage` 改为 `ChatMessageContent`，以便重试保留图文。`hydrate()`、`chat:completed` 和 `chat:changed` 都要复制并保留 `messageType` 与 `executionPlan`；绝不把内部字段作为模型 API 字段。助手 JSON 展示解析失败时把原字符串作为普通助手文本显示，不能让渲染器崩溃。

- [ ] **步骤 5：运行桥接和状态测试并提交。**

```powershell
npm test -- tests/unit/preload/api.test.ts tests/unit/renderer/global-chat.test.ts
git add src/preload/api.ts src/preload/index.ts src/renderer/src/stores/global-chat.ts tests/unit/preload/api.test.ts tests/unit/renderer/global-chat.test.ts
git commit -m "feat: expose plan actions to the AI workspace"
```

### 任务 7：实现 AI 工作区图片、计划、审计和围栏复核 UI

**文件：**

- 修改：`src/renderer/src/components/chat/GlobalChatPanel.vue`
- 修改：`src/renderer/src/views/WorkbenchView.vue`
- 修改：`tests/unit/renderer/v18-visual-contract.test.ts`
- 修改：`tests/unit/renderer/global-chat.test.ts`
- 修改：`tests/unit/renderer/shell-canvas.test.ts`
- 修改：`tests/fixtures/v18-prototype-actions.json`

- [ ] **步骤 1：先更新视觉契约测试。**

```ts
it('renders the AI workspace without autonomous mode and with plan-review controls', () => {
  const chat = rendererSource('components/chat/GlobalChatPanel.vue')
  expect(chat).toContain('人工确认执行')
  expect(chat).toContain('AI 原始命令')
  expect(chat).toContain('确认并执行')
  expect(chat).toContain('添加图片')
  expect(chat).not.toContain('全自动驾驶')
  expect(chat).not.toContain('再次执行')
})
```

同时更新引用 `.ai-mode-group`、`@upgrade`、`autonomousUpgrade` 和固定 `520` 的旧测试，使其表达新验收条件而非删除测试覆盖。

- [ ] **步骤 2：运行视觉契约测试，确认失败。**

```powershell
npm test -- tests/unit/renderer/v18-visual-contract.test.ts tests/unit/renderer/shell-canvas.test.ts
```

预期：现有组件仍包含全自动驾驶，缺少计划和图片 UI。

- [ ] **步骤 3：移除右侧可达的全自动驾驶 UI。**

在 `WorkbenchView.vue` 删除：

- `createAutonomousUpgradeStore` 引入及状态；
- `requestAutonomousUpgrade()`、`confirmAutonomousUpgrade()`；
- Escape 分支中的升级取消；
- `modal-open` 的升级状态；
- 向 `GlobalChatPanel` 传递的 `can-upgrade`、`@upgrade`；
- 全自动驾驶确认弹窗和相关 CSS。

在 `GlobalChatPanel.vue` 移除模式 fieldset、单选控件和 `Circle` 图标，仅保留紧凑、不可点击的：

```vue
<div class="execution-mode-badge">
  <strong>人工确认执行</strong>
  <span>AI 计划不会自动运行</span>
</div>
```

不要删除旧 agent/session-mode 模块；本任务只移除当前工作台的可达入口。

- [ ] **步骤 4：增加图片选择和多模态发送。**

使用隐藏的原生输入，不创建附件服务：

```vue
<input ref="imageInput" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden @change="selectImages" />
<button type="button" class="composer-tool-button" aria-label="添加图片" title="添加图片" @click="imageInput?.click()">
  <ImagePlus :size="14" aria-hidden="true" />
</button>
```

`selectImages()` 验证 MIME、读取为 Data URL、拒绝超出共享契约限制的图片，并将结果写入 `global-chat` 的 `pendingImages`。附件条只显示缩略预览、截断文件名和无障碍名称为“移除图片”的图标按钮。发送按钮在有文字或至少一张图片时可用；发送成功后清除草稿和待发图片。

- [ ] **步骤 5：实现消息分类和计划卡片。**

渲染优先级必须是：

1. `message.messageType === 'execution_audit'`：单独的审计消息样式，标题“执行审计”，只显示其正文。
2. assistant 有 `executionPlan`：安全解析 `content` 的 `reply`，先渲染普通 AI 回复，再渲染计划卡。
3. user 有内容块：渲染文本块和可点击/可加载的本地 Data URL 图片预览。
4. 其余消息：沿用当前普通文本消息。

计划卡逐步显示目标、说明、AI 原始命令、命中标签和本地风险说明。风险说明从 `step.fence.ruleName` 和 `step.originalCommand` 派生，不能读模型回复。计划顶部若有任一 `fence`，列出命中规则、目标 Shell、原始命令和风险说明。

待 `pending_review`：

- 修改按钮打开 textarea；保存调用 `window.terminalAgent.chat.plans.editStep()`；
- 删除按钮调用 `removeStep()`；仅剩一条步骤时，该调用将计划取消，按钮的 `title` 显示“删除后将取消计划”；
- 取消计划调用 `cancel()`；
- 主按钮文案为 `确认并执行 ${steps.length} 步`，调用 `execute()`，不弹出二次确认。

`executing`、`executed`、`partially_executed`、`execution_failed`、`cancelled` 均禁用编辑、删除、取消和确认。终态逐条显示“已发送”“发送失败”“未发送”；“已发送”只使用“已发送至目标 Shell”文案，禁止写成业务成功。不得渲染再次执行按钮。

- [ ] **步骤 6：修正上下文条、滚动条和窄宽度布局。**

- 上下文标题行以 `grid-template-columns: auto minmax(0, 1fr) auto` 放置摘要、百分比和“立即压缩”；在容器不足时摘要允许换行，按钮不遮挡。
- `.messages` 保持 `overflow-y: auto; scrollbar-gutter: stable; scrollbar-color: transparent transparent;`；仅 `.global-chat-panel:hover .messages` 显示主题滑块，WebKit 规则同样切换。
- 发送区使用 `min-width: 0`、图标按钮固定尺寸、摘要 `min-width: 0; text-overflow: ellipsis`，在小宽度用 `@container` 隐藏次要摘要文字，不隐藏添加图片、取消或发送控制。
- 图片、代码和长命令使用 `overflow-wrap: anywhere`、`max-width: 100%`，不允许导致工作台横向溢出。

- [ ] **步骤 7：运行渲染器测试并提交。**

```powershell
npm test -- tests/unit/renderer/global-chat.test.ts tests/unit/renderer/v18-visual-contract.test.ts tests/unit/renderer/shell-canvas.test.ts
git add src/renderer/src/components/chat/GlobalChatPanel.vue src/renderer/src/views/WorkbenchView.vue tests/unit/renderer tests/fixtures/v18-prototype-actions.json
git commit -m "feat: add AI workspace image and plan review UI"
```

### 任务 8：将 AI 工作区宽度上限改为客户区 45% 并消除页面溢出

**文件：**

- 修改：`src/shared/contracts.ts`
- 修改：`src/main/main.ts`
- 修改：`src/renderer/src/stores/layout-preferences.ts`
- 修改：`src/renderer/src/components/workbench/WorkbenchShell.vue`
- 修改：`src/renderer/src/components/chat/GlobalChatPanel.vue`
- 修改：`tests/unit/renderer/layout-preferences.test.ts`
- 修改：`tests/unit/main/chat-main-lifecycle.test.ts`
- 修改：`tests/unit/renderer/v18-visual-contract.test.ts`
- 修改：`tests/e2e/workbench.spec.ts`

- [ ] **步骤 1：写动态宽度的失败测试。**

```ts
it('caps the effective AI workspace width at 45 percent of the client width while retaining a saved preference', () => {
  expect(effectiveAiWorkspaceWidth(900, 520)).toBe(405)
  expect(effectiveAiWorkspaceWidth(1440, 520)).toBe(520)
  expect(effectiveAiWorkspaceWidth(1440, 900)).toBe(648)
})
```

端到端测试把旧 `rightWidth: 520` 静态断言改为：

```ts
expect(Number(await rightSeparator.getAttribute('aria-valuenow')))
  .toBeLessThanOrEqual(Math.floor((await page.viewportSize())!.width * 0.45))
```

并在 900×700 检查：`document.documentElement.scrollWidth <= clientWidth`、`scrollHeight <= clientHeight`、上下文压缩按钮、图片按钮和发送按钮都位于 `.global-chat-panel` 内。

主进程窗口测试还要断言 `createMainWindow()` 传给 `BrowserWindow` 的 `minWidth` 为 `900`；这样在任何可用客户区中，`45%` 都不少于 AI 工作区的 `340px` 最小宽度，两个约束不会相互冲突。

- [ ] **步骤 2：运行失败测试。**

```powershell
npm test -- tests/unit/renderer/layout-preferences.test.ts
npm run test:e2e -- --grep "collapse rails and separator keyboard bounds"
```

预期：有效宽度函数和动态 aria 数值尚不存在，旧测试仍要求 `520`。

- [ ] **步骤 3：实现运行时有效宽度。**

将持久化的 `WORKBENCH_RIGHT_WIDTH_MAX` 提升为仅用于数据校验的宽上限 `4096`，不再将它作为 UI 最大宽度。新增：

```ts
export function effectiveAiWorkspaceWidth(clientWidth: number, preferredWidth: number): number {
  const maximum = Math.floor(clientWidth * 0.45)
  return Math.max(WORKBENCH_RIGHT_WIDTH_MIN, Math.min(Math.round(preferredWidth), maximum))
}
```

`WorkbenchShell.vue` 用 `ref(window.innerWidth)` 和单个 `resize` 监听计算有效宽度，设置 CSS 变量和右分隔线的 `aria-valuenow`。右分隔线拖动和键盘调整以有效宽度为起点、以 `floor(clientWidth * .45)` 为上限，并保存用户拖拽的值；窗口变小时只缩小显示值，不覆盖原偏好，窗口变大后恢复可用的保存宽度。

在 `src/main/main.ts` 的 `createMainWindow()` 为 `BrowserWindow` 加 `minWidth: 900`。这不是新的布局偏好，而是保证 `340px` 最小宽度和客户区 `45%` 上限能同时成立的桌面窗口边界。

工作台主体改为不产生页面滚动的网格：

```css
.workbench-shell { width: 100%; height: 100dvh; min-width: 0; min-height: 0; overflow: hidden; }
.workspace { min-width: 0; min-height: 0; overflow: hidden; }
.side-content, .shell-region { min-width: 0; min-height: 0; overflow: hidden; }
```

不要把页面根部 `overflow` 改成 `auto`；真正可滚动的区域仍由 Shell 画布和 AI 消息区负责。

- [ ] **步骤 4：运行布局验证并提交。**

```powershell
npm test -- tests/unit/renderer/layout-preferences.test.ts tests/unit/renderer/v18-visual-contract.test.ts
npm run test:e2e -- --grep "collapse rails and separator keyboard bounds|workbench layout"
git add src/shared/contracts.ts src/main/main.ts src/renderer/src/stores/layout-preferences.ts src/renderer/src/components/workbench/WorkbenchShell.vue src/renderer/src/components/chat/GlobalChatPanel.vue tests/unit/renderer tests/unit/main/chat-main-lifecycle.test.ts tests/e2e/workbench.spec.ts
git commit -m "fix: constrain AI workspace to the client width"
```

### 任务 9：增加核心端到端流程并执行完整验证

**文件：**

- 修改：`tests/e2e/workbench.spec.ts`
- 修改：`tests/e2e/settings.spec.ts`（仅当模型配置测试需要展示 VLM 路由时）
- 修改：`RELEASE_NOTES.md`

- [ ] **步骤 1：为核心审批路径新增 Playwright 失败测试。**

扩展现有假 Ollama 服务，使它按请求顺序返回：首次无效 JSON、第二次包含三步计划的合法 JSON、执行审计后的下一轮合法纯聊天 JSON；服务记录每次请求中是否保留图片块与审计正文。复用 `startSshServer()`，为两个连接提供可观察的 `echo:<command>` 输出。

测试流程：

```ts
test('reviews one fenced plan, edits and removes steps, then audits its one-time Shell send', async ({ launchApp }) => {
  await configureCombinedLlmAndVlm(page, fakeOllama.endpoint)
  await page.locator('input[type="file"][accept="image/png,image/jpeg,image/gif,image/webp"]').setInputFiles({ name: 'screen.png', mimeType: 'image/png', buffer: pngBytes })
  await page.getByLabel('聊天输入').fill('检查截图并规划')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('安全围栏命中')).toBeVisible()
  await editPlanStep(page, 'rm -rf /tmp/cache', 'rm -r /tmp/cache')
  await removePlanStep(page, 3)
  await page.getByRole('button', { name: '确认并执行 2 步' }).click()
  await expect(page.getByText('执行审计')).toBeVisible()
  await expect(page.getByRole('button', { name: '再次执行' })).toHaveCount(0)
  await page.getByLabel('聊天输入').fill('继续总结已发送的命令')
  await page.getByRole('button', { name: '发送' }).click()
  expect(fakeOllama.requests.at(-1)?.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'user', content: expect.stringContaining('【执行审计】') }),
  ]))
  expect(JSON.stringify(fakeOllama.requests.at(-1))).not.toContain('messageType')
})
```

另增加单独的中途写入失败场景：第二个 Session `write` 被测试双桩抛错或连接关闭，断言后续步骤未发送、UI 显示部分执行、审计列出 sent/failed/not_sent。

- [ ] **步骤 2：运行新端到端测试，确认在功能尚未完成时失败。**

```powershell
npm run test:e2e -- --grep "reviews one fenced plan"
```

预期：失败，当前界面没有图片、计划审批或执行审计。

- [ ] **步骤 3：实现最小测试辅助和端到端断言。**

- 使用 Playwright `setInputFiles()` 注入一个内存 PNG，避免使用外部附件或用户路径。
- 用 role、label 和稳定 CSS 类定位计划，而不是依赖全部展示文案。
- 通过 IPC 读取持久化聊天验证内部字段，而不是仅靠截图。
- 对图片路由断言只检查假模型收到的模型名称/图片形式，不检查任何 API Key。
- 对 1440×900、1024×768 和 900×700 截图调用现有 `assertViewportPng()`，并检查页面横纵都无非业务溢出。

在同一测试文件定义上述流程使用的三个局部辅助函数，避免重复 locator 并保持其输入固定：

```ts
async function editPlanStep(page: Page, originalCommand: string, finalCommand: string): Promise<void> {
  const step = page.locator('[data-plan-step]').filter({ hasText: originalCommand })
  await step.getByRole('button', { name: '修改命令' }).click()
  await step.getByLabel('Shell 命令').fill(finalCommand)
  await step.getByRole('button', { name: '保存命令' }).click()
  await expect(step.getByText('人工修改')).toBeVisible()
}

async function removePlanStep(page: Page, ordinal: number): Promise<void> {
  await page.locator('[data-plan-step]').nth(ordinal - 1).getByRole('button', { name: '删除命令' }).click()
}

async function configureCombinedLlmAndVlm(page: Page, endpoint: string): Promise<void> {
  await page.evaluate(async ({ endpoint }) => {
    const llm = await window.terminalAgent.settings.models.save({ name: 'E2E LLM', kind: 'llm', provider: 'ollama', model: 'fake-llm', endpoint, contextLimit: 1_024 })
    const vlm = await window.terminalAgent.settings.models.save({ name: 'E2E VLM', kind: 'vlm', provider: 'ollama', model: 'fake-vlm', endpoint, maxImages: 8 })
    await window.terminalAgent.settings.models.activate(llm.id)
    await window.terminalAgent.settings.models.activate(vlm.id)
    await window.terminalAgent.settings.models.setRouting('combined')
  }, { endpoint })
}
```

- [ ] **步骤 4：更新发行说明。**

在 `RELEASE_NOTES.md` 顶部新增中文版本段落，准确说明：图片仅限图文聊天、历史图片触发 VLM、整组人工确认、围栏仅匹配 AI 原始命令、编辑不重检、执行审计和“已发送”不等同业务成功。明确写出不支持全自动驾驶、再次执行、退出码解析或通用附件。

- [ ] **步骤 5：运行分层验证。**

```powershell
npm test
npm run build
npm run test:integration
npm run test:e2e
```

预期：每条命令退出码为 `0`。若 Windows 打包工具或本地 SSH fixture 不可用，记录实际失败命令、错误原因和已通过的测试层级，不跳过其余可运行验证。

- [ ] **步骤 6：进行视觉复核。**

启动开发环境：

```powershell
npm run dev
```

在运行的 Electron 窗口中人工检查以下状态：

- 珍珠白与石墨黑主题；
- 默认 390px、340px 最小值、拖到客户区 45% 的 AI 工作区；
- 立即压缩按钮没有遮挡；
- 未悬浮和悬浮 AI 工作区时的滚动条；
- 图片预览、移除、纯图片发送；
- 纯回复、围栏计划、人工修改、删除、确认、全部发送和部分执行；
- 已执行计划的锁定与无再次执行入口；
- 900×700 的底部工具栏、最右侧和最下侧无页面滚动条。

- [ ] **步骤 7：提交端到端覆盖和发行说明。**

```powershell
git add tests/e2e/workbench.spec.ts tests/e2e/settings.spec.ts RELEASE_NOTES.md
git commit -m "test: cover AI workspace plan approval workflow"
```

## 3. 最终审查清单

在声称实现完成前，逐项核对：

- [ ] 所有生产代码调用的是 `@langchain/langgraph` 的 Node.js/TypeScript 包，不含 Python 依赖。
- [ ] 任何模型无效 JSON 在三次调用后只产生统一错误，原始无效输出没有进入 UI、消息库或 Shell。
- [ ] 纯文本历史仍可加载；多模态内容块只能来自 user 消息，带图片的任意历史任务后续稳定路由 VLM。
- [ ] 审计消息持久化为 `role: 'user'`、`messageType: 'execution_audit'`，传给模型时只保留 Chat Completions 合法 `role/content`。
- [ ] 计划 ID、步骤 ID、围栏结果、风险说明、`sessionId` 与发送状态完全由主进程产生或更新。
- [ ] 人工修改不会触发二次围栏，但没有任何计划可绕过整组确认。
- [ ] 目标仅从当前聊天关联且在线的 Shell 中选择；同名时选择其中最早连接者，锁定后不进行同名替换。
- [ ] 中途失败不重复发送、不等待输出、不判断退出码，并有完整审计。
- [ ] AI 工作区没有全自动驾驶入口、升级弹窗或再次执行按钮。
- [ ] 右栏默认 390px、最小 340px、最大客户区 45%，且 900×700、1024×768、1440×900 没有页面级右侧或底部滚动条。
- [ ] `npm test`、`npm run build`、`npm run test:integration`、`npm run test:e2e` 均有本次执行产生的成功输出。
