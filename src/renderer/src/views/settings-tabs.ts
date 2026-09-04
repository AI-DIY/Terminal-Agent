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
