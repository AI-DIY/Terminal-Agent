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

    expect(sidebar).toContain('任务历史区')
    expect(sidebar).toContain('聊天与 Shell 记录')
    expect(sidebar).toContain('新建聊天')
    expect(shellCanvas).toContain('新建 SSH 连接')
    expect(shellCanvas).toContain('Shell 布局')
    expect(sessionTabs).not.toContain('辅助驾驶')
    expect(sessionTabs).not.toContain('全自动驾驶')
    expect(chat).toContain('AI工作区')
    expect(chat).toContain('辅助驾驶')
    expect(chat).toContain('全自动驾驶')
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
    expect(profiles).not.toContain('导入密钥')
    expect(profiles).not.toContain('LLM 密钥引用')
    expect(profiles).not.toContain('apiKeyProfileId')
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
