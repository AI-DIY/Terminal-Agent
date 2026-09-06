import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function rendererSource(path: string): string {
  return readFileSync(new URL(`../../../src/renderer/src/${path}`, import.meta.url), 'utf8')
}

describe('V18 production visual contract', () => {
  it('keeps the approved product language in the panel that owns each action', () => {
    const sidebar = rendererSource('components/workbench/WorkbenchSessionSidebar.vue')
    const shellCanvas = rendererSource('components/workbench/ShellCanvas.vue')
    const sessionTabs = rendererSource('components/SessionTabs.vue')
    const chat = rendererSource('components/chat/GlobalChatPanel.vue')

    expect(sidebar).toContain('任务空间')
    expect(sidebar).toContain('任务与 SSH 记录')
    expect(sidebar).toContain('新建任务')
    expect(shellCanvas).toContain('新建 SSH 连接')
    expect(shellCanvas).toContain('SSH 窗口布局')
    expect(sessionTabs).not.toContain('辅助驾驶')
    expect(sessionTabs).not.toContain('全自动驾驶')
    expect(chat).toContain('AI工作区')
    expect(chat).not.toContain('辅助驾驶')
    expect(chat).not.toContain('全自动驾驶')
    expect(chat).not.toContain('type="file"')
    expect(chat).not.toContain('添加图片')
    expect(chat).not.toContain('重试')
    expect(chat).not.toContain('@change="editStep')
    expect(chat).toContain('editStep(')
    expect(chat).toContain('removeStep(')
    expect(chat).toContain('textarea class="plan-edit-input"')
    expect(chat).toContain('原始命令')
    expect(chat).toContain('修改后命令')
    expect(chat).toContain('删除命令')
    expect(chat).toContain('<Trash2')
    expect(chat).toContain('计划已取消，未执行任何命令')
    expect(chat).toContain('step.fence.ruleName')
    expect(chat).toContain('step.fence.ruleId')
    expect(chat).toContain('安全围栏')
    expect(chat).toContain('确认并执行')
    expect(chat).toContain('待确认')
  })

  it('uses the approved desktop frame and settings information architecture', () => {
    const app = rendererSource('App.vue')
    const shell = rendererSource('components/workbench/WorkbenchShell.vue')
    const settings = rendererSource('views/SettingsView.vue')

    expect(app).toContain('--chrome: #f0f3f6')
    expect(app).toContain('--terminal: #151a20')
    expect(shell).toContain('grid-template-rows: 48px minmax(0, 1fr)')
    expect(shell).toContain("'--left-width'")
    expect(shell).toContain("'--right-width'")
    expect(settings).toContain('settings-layout')
    expect(settings).toContain('settings-nav')
    expect(settings).toContain('settings-content')
    expect(settings).toContain('grid-template-columns: 216px minmax(0, 1fr)')
  })

  it('uses stable icon components for familiar workbench actions', () => {
    const shell = rendererSource('components/workbench/WorkbenchShell.vue')
    const shellCanvas = rendererSource('components/workbench/ShellCanvas.vue')
    const sessionTabs = rendererSource('components/SessionTabs.vue')
    const chat = rendererSource('components/chat/GlobalChatPanel.vue')

    expect(shell).toContain("from '@lucide/vue'")
    expect(shellCanvas).toContain("from '@lucide/vue'")
    expect(sessionTabs).toContain("from '@lucide/vue'")
    expect(chat).toContain("from '@lucide/vue'")
  })

  it('gives task history an accessible action menu, inline rename, and low-distraction scrollbar', () => {
    const sidebar = rendererSource('components/workbench/WorkbenchSessionSidebar.vue')

    expect(sidebar).toContain("MoreHorizontal, PanelLeftClose, Pencil, Pin, PinOff, Plus, Trash2")
    expect(sidebar).toContain('aria-label="任务名称"')
    expect(sidebar).toContain('maxlength="255"')
    expect(sidebar).toContain('@keydown.enter.prevent="saveRename(chat.id)"')
    expect(sidebar).toContain('@keydown.esc.prevent="cancelRename"')
    expect(sidebar).toContain('@blur="saveRename(chat.id)"')
    expect(sidebar).toContain('重命名')
    expect(sidebar).toContain("chat.pinnedAt ? '取消置顶' : '置顶'")
    expect(sidebar).toContain('aria-label="已置顶"')
    expect(sidebar).toContain('scrollbar-color: transparent transparent')
    expect(sidebar).toContain('nav:hover,nav:focus-within')
    expect(sidebar).toContain('::-webkit-scrollbar-button')
  })

  it('keeps working tasks on the normal row surface and highlights only the selected task', () => {
    const sidebar = rendererSource('components/workbench/WorkbenchSessionSidebar.vue')
    const activeRule = /\.history-item\.active\s*\{([^}]*)\}/.exec(sidebar)?.[1] ?? ''

    expect(sidebar).toContain("'has-online-shell': props.onlineChatIds?.has(chat.id)")
    expect(sidebar).toContain("'working-status'")
    expect(sidebar).toContain('.working-status { color: var(--red); }')
    expect(activeRule).toContain('background: var(--amber-soft)')
    expect(sidebar).not.toContain('.history-item.has-online-shell { background: var(--amber-soft)')
    expect(sidebar).not.toContain('.history-item.has-online-shell.active')
  })

  it('uses one title size for the task, SSH, and AI workspaces', () => {
    const sidebar = rendererSource('components/workbench/WorkbenchSessionSidebar.vue')
    const shellCanvas = rendererSource('components/workbench/ShellCanvas.vue')
    const chat = rendererSource('components/chat/GlobalChatPanel.vue')
    const sidebarSize = /\.panel-title strong\s*\{[^}]*font-size:\s*(\d+)px/.exec(sidebar)?.[1]
    const shellSize = /\.workspace-toolbar-title strong\s*\{[^}]*font-size:\s*(\d+)px/.exec(shellCanvas)?.[1]
    const chatSize = /\.ai-head-copy h3\s*\{[^}]*font-size:\s*(\d+)px/.exec(chat)?.[1]

    expect(sidebarSize).toBeDefined()
    expect(shellSize).toBe(sidebarSize)
    expect(chatSize).toBe(sidebarSize)
  })

  it('uses task-facing labels without renaming internal chat contracts', () => {
    const workbench = rendererSource('views/WorkbenchView.vue')
    const shell = rendererSource('components/workbench/WorkbenchShell.vue')
    const shellCanvas = rendererSource('components/workbench/ShellCanvas.vue')
    const store = rendererSource('stores/chat-workspaces.ts')

    expect(workbench).toContain("'未选择任务'")
    expect(workbench).not.toContain('此任务没有关联 SSH。')
    expect(workbench).toContain('<template #empty>')
    expect(workbench).toContain('<SshConnectionLauncher')
    expect(shell).toContain('当前任务')
    expect(shellCanvas).toContain('返回实时任务')
    expect(shellCanvas).toContain('<section v-if="currentSessions.length === 0" class="empty-slot"><slot name="empty" /></section>')
    expect(shellCanvas).not.toContain('<slot name="history"')
    expect(store).toContain('无法读取任务。')
    expect(store).toContain('无法新建任务。')
    expect(store).toContain('无法删除任务。')
  })

  it('anchors the current task beside the brand and separates the greeting from action buttons', () => {
    const shell = rendererSource('components/workbench/WorkbenchShell.vue')
    const header = shell.slice(shell.indexOf('<header class="app-header"'), shell.indexOf('</header>'))

    expect(header.indexOf('class="brand"')).toBeLessThan(header.indexOf('class="current-chat"'))
    expect(header.indexOf('class="current-chat"')).toBeLessThan(header.indexOf('class="header-welcome"'))
    expect(header.indexOf('class="header-welcome"')).toBeLessThan(header.indexOf('class="app-header-actions"'))
    expect(shell).toContain('.header-welcome { flex: 0 0 auto; margin-right: 12px;')
    expect(shell).toContain('.app-header-actions { display: flex; align-items: center; gap: 6px;')
    expect(shell).toContain('.current-chat .task-copy { display: none; }')
  })

  it('keeps the independent diagnostic tools ordered ahead of native window controls', () => {
    const workbench = rendererSource('views/WorkbenchView.vue')
    const shell = rendererSource('components/workbench/WorkbenchShell.vue')

    expect(workbench).toContain("import { Bug, Code2, Settings } from '@lucide/vue'")
    expect(workbench.indexOf('aria-label="设置"')).toBeLessThan(workbench.indexOf('aria-label="DevTools"'))
    expect(workbench.indexOf('aria-label="DevTools"')).toBeLessThan(workbench.indexOf('aria-label="Node Inspector"'))
    expect(workbench).toContain('window.terminalAgent.diagnostics.openRendererDevTools()')
    expect(workbench).toContain('window.terminalAgent.diagnostics.openNodeInspector()')
    expect(workbench).toContain('diagnostics.onError')
    expect(shell).toContain('@media (max-width: 1080px)')
    expect(shell).toContain('.app-header-actions :deep(.header-button span) { display: none; }')
  })

  it('keeps built-in skills visibly unavailable without changing the workbench frame', () => {
    const workbench = rendererSource('views/WorkbenchView.vue')
    const skills = rendererSource('views/SkillsView.vue')

    expect(workbench).toContain('未登录状态不能使用技能')
    expect(skills).toContain('未登录状态不能使用技能')
  })

  it('renders model routing as the approved V18 option cards', () => {
    const routing = rendererSource('components/settings/ModelRoutingSettings.vue')

    expect(routing).toContain('model-routing-options')
    expect(routing).toContain('type="radio"')
    expect(routing).toContain('大语言模型 + 视觉语言模型')
    expect(routing).toContain('纯视觉语言模型')
    expect(routing).toContain('当前模式')
    expect(routing).not.toContain('<select')
  })

  it('renders safety fence rules as the approved V18 table and tester', () => {
    const fence = rendererSource('components/settings/RegexFenceRules.vue')

    expect(fence).toContain('安全围栏')
    expect(fence).toContain('rules-table')
    expect(fence).toContain('<table')
    expect(fence).toContain('<th>规则名称</th>')
    expect(fence).toContain('class="rule-tester"')
    expect(fence).toContain('保存安全围栏规则')
    expect(fence).toContain('@media (max-width: 1060px)')
    expect(fence).toContain('.rules-table { min-width: 0; }')
  })

  it('uses the approved split list and editor for model connections', () => {
    const profiles = rendererSource('components/settings/ModelProfileManager.vue')
    const removedVlmKeyReferenceField = ['apiKey', 'ProfileId'].join('')

    expect(profiles).toContain('profile-list-head')
    expect(profiles).toContain('profile-editor')
    expect(profiles).toContain('primary-button')
    expect(profiles).toContain('新建连接')
    expect(profiles).toContain('测试连接')
    expect(profiles).toContain("const apiKey = ref('')")
    expect(profiles).toContain('const showApiKey = ref(false)')
    expect(profiles).toContain('v-model="apiKey"')
    expect(profiles).toContain('for="model-profile-api-key"')
    expect(profiles).toContain('id="model-profile-api-key"')
    expect(profiles).toContain("showApiKey ? 'text' : 'password'")
    expect(profiles).toContain('EyeOff')
    expect(profiles).toContain('Eye')
    expect(profiles).toContain('Trash2')
    expect(profiles).toContain('显示 API Key')
    expect(profiles).toContain('隐藏 API Key')
    expect(profiles).toContain('清除已保存密钥')
    expect(profiles).toContain('已配置密钥，留空则保留')
    expect(profiles).toContain('可选，Ollama 通常无需填写')
    expect(profiles).toContain('密钥仅在保存或测试时发送给主进程；已保存密钥不会回填。')
    expect(profiles).toContain('profileDraftInput(form, apiKey.value)')
    expect(profiles).toContain('clearTransientKey()')
    expect(profiles).toContain('.api-key-input-row')
    expect(profiles).toContain('.icon-button')
    expect(profiles).not.toContain(removedVlmKeyReferenceField)
  })

  it('uses the approved host-memory switch and scope grid', () => {
    const memory = rendererSource('components/settings/HostMemorySettings.vue')

    expect(memory).toContain('memory-toggle')
    expect(memory).toContain('switch-control')
    expect(memory).toContain('告知后将保存的内容')
    expect(memory).toContain('保存记忆设置')
  })

  it('uses full V18 workbench previews for both appearance themes', () => {
    const appearance = rendererSource('components/settings/AppearanceSettings.vue')

    expect(appearance).toContain('接近 IDEA Light 的冷白层次')
    expect(appearance).toContain('接近 IDEA Darcula 的深灰层次')
    expect(appearance).toContain('height: 92px')
  })
})
