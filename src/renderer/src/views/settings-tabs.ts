export const SETTINGS_TABS = [
  { id: 'routing', label: '模型选择', status: 'ready' },
  { id: 'llm', label: '大语言模型配置', status: 'ready' },
  { id: 'vlm', label: '视觉语言模型配置', status: 'ready' },
  { id: 'fence', label: '安全围栏', status: 'ready' },
  { id: 'memory', label: '本地主机记忆', status: 'ready' },
  { id: 'appearance', label: '外观', status: 'ready' },
  { id: 'sso', label: '单点登录', status: 'ready' },
] as const
export type SettingsTabId = typeof SETTINGS_TABS[number]['id']

/**
 * v3.2 presents one active LLM configuration as the only model settings
 * surface.  Keep SETTINGS_TABS exported with its historical shape for plugin
 * compatibility, but do not expose the removed routing/VLM panels in the
 * settings navigation.
 */
export const SETTINGS_NAV_TABS = SETTINGS_TABS.filter(item => item.id !== 'routing' && item.id !== 'vlm')
export type SettingsNavTabId = typeof SETTINGS_NAV_TABS[number]['id']
