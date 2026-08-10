# Terminal-Agent 产品蓝图单页实现计划

> **供执行型智能体使用：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐项执行本计划。步骤以复选框记录进度。

**目标：** 制作一张可直接打开、用于领导汇报的中文静态 HTML 页面，准确说明 Terminal-Agent 从告警分析与辅助驾驶基础，演进到嵌入终端、以驾驶模式控制执行的产品蓝图。

**架构：** 页面仅由 `docs/terminal-agent-blueprint.html` 承载，内嵌语义化 HTML 与 CSS，不使用 JavaScript、网络字体、图片或第三方资源。Playwright 通过 `file:` 地址加载该文件，验证页面核心文案、能力边界和安全说明；截图用于检查桌面与窄屏版式。

**技术栈：** 标准 HTML5、CSS3、Playwright。

---

## 文件结构

```text
Terminal-Agent-v2/
  docs/
    terminal-agent-blueprint.html              # 可直接打开的领导汇报单页
  tests/
    e2e/
      blueprint-page.spec.ts                   # 静态页面的内容与加载检查
  test-results/
    terminal-agent-blueprint-desktop.png       # 本地视觉核验截图，不提交
    terminal-agent-blueprint-mobile.png        # 本地视觉核验截图，不提交
```

### 任务 1：为产品蓝图页面建立可执行检查

**文件：**
- 新建：`tests/e2e/blueprint-page.spec.ts`
- 新建：`docs/terminal-agent-blueprint.html`

- [ ] **步骤 1：先写失败的静态页面检查**

新建 `tests/e2e/blueprint-page.spec.ts`：

```ts
import { expect, test } from '@playwright/test'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const pageUrl = pathToFileURL(join(process.cwd(), 'docs', 'terminal-agent-blueprint.html')).href

test('产品蓝图页准确呈现终端嵌入、驾驶模式和安全边界', async ({ page }) => {
  await page.goto(pageUrl)

  await expect(page).toHaveTitle('Terminal-Agent | 产品蓝图')
  await expect(page.getByRole('heading', { name: '让 Agent 真正进入系统管理员的工作现场' })).toBeVisible()
  await expect(page.getByText('自动巡检已经体现出实际价值')).toBeVisible()
  await expect(page.getByText('告警分析 Agent 具备基于 ReAct 的环境理解、推理与分析能力')).toBeVisible()
  await expect(page.getByText('SSH 终端与多主机工作台')).toBeVisible()
  await expect(page.getByText('辅助驾驶', { exact: true })).toBeVisible()
  await expect(page.getByText('全自动驾驶', { exact: true })).toBeVisible()
  await expect(page.getByText('安全边界')).toBeVisible()
  await expect(page.locator('link[rel="stylesheet"]')).toHaveCount(0)
})
```

- [ ] **步骤 2：运行检查，确认它因页面尚不存在而失败**

运行：

```powershell
npx playwright test tests/e2e/blueprint-page.spec.ts
```

预期：测试失败，原因是 `docs/terminal-agent-blueprint.html` 尚未创建，页面标题和标题文本无法找到。

- [ ] **步骤 3：制作独立的单页 HTML**

新建 `docs/terminal-agent-blueprint.html`，满足以下精确内容与结构：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terminal-Agent | 产品蓝图</title>
</head>
<body>
  <main>
    <header>
      <p>产品蓝图 / 开发中</p>
      <h1>让 Agent 真正进入系统管理员的工作现场</h1>
      <p>从自动巡检和告警分析的能力基础，走向嵌入终端工作流、受驾驶模式约束的协作执行。</p>
    </header>
    <section aria-labelledby="turning-point-title">
      <h2 id="turning-point-title">为什么要做这次升级</h2>
      <p>自动巡检已经体现出实际价值：Agent 能承担明确的检查工作，减少管理员的重复操作。</p>
      <p>现有告警分析 Agent 具备基于 ReAct 的环境理解、推理与分析能力。这是新方向的基础，而不是要被丢弃的旧方案。</p>
      <p>当前产品设计的重点，是将这部分能力放进系统管理员正在使用的终端环境。</p>
    </section>
    <section aria-labelledby="blueprint-title">
      <h2 id="blueprint-title">产品蓝图</h2>
      <ol>
        <li><strong>连接入口</strong><span>用户名 + 密码、私钥、AccessClient 兼容启动。</span></li>
        <li><strong>SSH 终端与多主机工作台</strong><span>承载终端会话、标签和多主机视图。</span></li>
        <li><strong>只读观察</strong><span>新建连接后获取稳定、可比较的环境事实。</span></li>
        <li><strong>主机事实</strong><span>按主机名保存结构化的软件、进程、服务和日志位置。</span></li>
        <li><strong>目标驱动调度</strong><span>结合用户目标、当前会话和相关事实安排下一步。</span></li>
        <li><strong>按驾驶模式执行</strong><span>在明确控制边界内推进操作。</span></li>
      </ol>
    </section>
    <section aria-labelledby="safety-title">
      <h2 id="safety-title">安全边界</h2>
      <article><h3>辅助驾驶</h3><p>默认模式。查询和观察可执行；变更命令需要用户确认。</p></article>
      <article><h3>全自动驾驶</h3><p>用户明确为当前会话升级后才启用。</p></article>
      <ul>
        <li>确认只绑定当前会话和一条精确的候选命令。</li>
        <li>本地正则安全围栏拦截辅助驾驶下命中的未确认命令。</li>
        <li>密码、私钥和临时连接参数不会进入主机事实或 AI 上下文。</li>
      </ul>
    </section>
    <footer>
      <p>保留已有 ReAct 环境理解和分析能力，将其放入真实终端工作流，使 Agent 能在安全边界内逐步分担系统管理员的工作。</p>
    </footer>
  </main>
</body>
</html>
```

在同一文件的 `<style>` 中实现以下视觉规则：浅色中性页面背景；深炭灰正文；蓝色与青绿色仅用于流程重点；辅助驾驶使用少量琥珀色标识；无渐变、无外部资源、无虚构指标。流程在宽屏保持六个等高步骤，窄于 `760px` 时变为一列；正文最大行宽为 `76rem`；页面边角圆角不超过 `8px`；所有文字在 `390px` 宽度下不溢出。

- [ ] **步骤 4：重新运行检查，确认页面内容和独立性通过**

运行：

```powershell
npx playwright test tests/e2e/blueprint-page.spec.ts
```

预期：测试通过，标题、转折叙事、六步蓝图、两种驾驶模式和安全边界均可见，且页面没有外部样式表依赖。

- [ ] **步骤 5：提交页面及其检查**

运行：

```powershell
git add docs/terminal-agent-blueprint.html tests/e2e/blueprint-page.spec.ts
git commit -m "docs: add terminal agent blueprint page"
```

预期：只提交单页 HTML 与页面检查，不包含工作区中其他正在进行的产品代码改动。

### 任务 2：核验实际汇报版式

**文件：**
- 修改：`docs/terminal-agent-blueprint.html`（仅当视觉检查发现阅读、间距或换行问题时）
- 生成：`test-results/terminal-agent-blueprint-desktop.png`
- 生成：`test-results/terminal-agent-blueprint-mobile.png`

- [ ] **步骤 1：截取桌面版和手机宽度版页面**

运行：

```powershell
npx playwright screenshot --device="Desktop Chrome" "file:///D:/project/github/Terminal-Agent-v2/docs/terminal-agent-blueprint.html" "test-results/terminal-agent-blueprint-desktop.png"
```

运行：

```powershell
npx playwright screenshot --device="iPhone 13" "file:///D:/project/github/Terminal-Agent-v2/docs/terminal-agent-blueprint.html" "test-results/terminal-agent-blueprint-mobile.png"
```

预期：两张截图均非空白；桌面版的六步流程易于横向扫描；手机版顺序清楚、文字没有截断或重叠。

- [ ] **步骤 2：检查截图并修正视觉问题**

检查两张截图，逐项确认：开头转折在首屏；六步流程不挤压；“辅助驾驶”和“全自动驾驶”清晰区分；安全边界区域没有夸张措辞；页尾结论可读。仅在出现文字溢出、对比度不足、元素重叠或流程顺序不清时修改 `docs/terminal-agent-blueprint.html` 的内嵌 CSS。

- [ ] **步骤 3：完成最终检查**

运行：

```powershell
npx playwright test tests/e2e/blueprint-page.spec.ts
git diff --check
```

预期：页面检查通过，`git diff --check` 没有空白错误。若步骤 2 修改了 HTML，将该修改单独提交：

```powershell
git add docs/terminal-agent-blueprint.html
git commit -m "style: refine blueprint page layout"
```

## 计划自检

### 设计覆盖

| 已确认设计要求 | 对应任务 |
| --- | --- |
| 自动巡检、ReAct 告警分析到终端嵌入的转折 | 任务 1，步骤 3 |
| 三类连接入口和终端多主机工作台 | 任务 1，步骤 3 |
| 只读观察、主机事实、目标驱动调度 | 任务 1，步骤 3 |
| 辅助驾驶、全自动驾驶与正则安全围栏 | 任务 1，步骤 3 |
| 不夸大、不依赖网络、无虚构数据 | 任务 1，步骤 1 和步骤 3 |
| 桌面及手机版式检查 | 任务 2 |

### 一致性检查

- 页面所有能力均来自 `docs/superpowers/specs/2026-08-09-terminal-agent-blueprint-page-design.md`。
- 自动巡检仅作为已验证的价值背景，不被写成自动修复或通用自动化能力。
- 全自动驾驶只在用户明确升级当前会话后启用。
- 安全区域说明具体控制机制，不使用“绝对安全”或“全领域兼容”等表述。
