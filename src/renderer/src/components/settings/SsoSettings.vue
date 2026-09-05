<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { getSsoStore } from '../../stores/sso'
import type { SsoConfiguration } from '../../../../shared/sso-contracts'
import { getSsoDraftErrors, isDisabledWorkbenchReady, isEnabledContinueReady } from '../../sso-settings-model'

const emit = defineEmits<{ continue: []; workbench: [] }>()
const props = withDefaults(defineProps<{ embeddedLogin?: boolean }>(), { embeddedLogin: false })
const store = getSsoStore()
const draft = reactive<SsoConfiguration>({
  enabled: store.config.enabled,
  loginPageUrl: store.config.loginPageUrl,
  platformUrlMatcher: { ...store.config.platformUrlMatcher },
  userInfoUrlMatcher: { ...store.config.userInfoUrlMatcher },
  employeeIdField: store.config.employeeIdField,
  nameField: store.config.nameField,
})
const saving = ref(false)
const notice = ref('')
const platformMatcherMode = computed(() => draft.platformUrlMatcher.mode)
const userInfoMatcherMode = computed(() => draft.userInfoUrlMatcher.mode)
const errors = computed(() => getSsoDraftErrors(draft))
const formatsValid = computed(() => Object.keys(errors.value).length === 0)
const continueReady = computed(() => isEnabledContinueReady(draft))
const workbenchReady = computed(() => isDisabledWorkbenchReady(draft))

async function save(kind: 'draft' | 'continue' | 'workbench'): Promise<void> {
  if (!formatsValid.value) return
  saving.value = true
  notice.value = ''
  try {
    await store.saveConfig({ ...draft, platformUrlMatcher: { ...draft.platformUrlMatcher }, userInfoUrlMatcher: { ...draft.userInfoUrlMatcher } }, kind)
    if (kind === 'continue' && props.embeddedLogin) store.consumeAutoRetrySuppression()
    notice.value = '配置已保存'
    if (kind === 'continue' && continueReady.value) emit('continue')
    if (kind === 'workbench' && workbenchReady.value) emit('workbench')
  } catch (error) {
    notice.value = error instanceof Error ? error.message : '配置保存失败'
  } finally { saving.value = false }
}

onMounted(() => { void store.initialize().then(() => Object.assign(draft, store.config, { platformUrlMatcher: { ...store.config.platformUrlMatcher }, userInfoUrlMatcher: { ...store.config.userInfoUrlMatcher } })).catch(() => undefined) })
</script>

<template>
  <section class="settings-panel sso-settings" aria-labelledby="sso-title">
    <header class="panel-head"><div><h2 id="sso-title">单点登录</h2><p>配置登录门控与平台用户信息读取规则。</p></div><span class="save-state" role="status">{{ notice }}</span></header>
    <label class="toggle-row"><input v-model="draft.enabled" type="checkbox"><span>启用单点登录门控</span></label>
    <p v-if="!draft.enabled" class="warning" role="note">关闭登录门控后，应用将以未登录状态运行，内置技能不可使用。</p>
    <label class="field"><span>登录页 URL</span><input v-model="draft.loginPageUrl" type="url" placeholder="https://login.example.com"><small v-if="errors.loginPageUrl" class="error">{{ errors.loginPageUrl }}</small></label>
    <div class="matcher"><label class="field"><span>平台 URL 匹配方式</span><select v-model="draft.platformUrlMatcher.mode" :data-mode="platformMatcherMode"><option value="exact">精确匹配</option><option value="prefix">前缀匹配</option><option value="regex">正则匹配</option></select></label><label class="field"><span>平台 URL / 正则（含前缀）</span><input v-model="draft.platformUrlMatcher.value" type="text" placeholder="https://platform.example.com"><small class="hint">精确 URL、URL 前缀或正则表达式</small><small v-if="errors.platformUrlMatcher" class="error">{{ errors.platformUrlMatcher }}</small></label></div>
    <div class="matcher"><label class="field"><span>用户信息接口 URL 匹配方式</span><select v-model="draft.userInfoUrlMatcher.mode" :data-mode="userInfoMatcherMode"><option value="exact">精确匹配</option><option value="prefix">前缀匹配</option><option value="regex">正则匹配</option></select></label><label class="field"><span>用户信息接口 URL / 正则（含前缀）</span><input v-model="draft.userInfoUrlMatcher.value" type="text" placeholder="https://platform.example.com/api/me"><small class="hint">精确 URL、URL 前缀或正则表达式</small><small v-if="errors.userInfoUrlMatcher" class="error">{{ errors.userInfoUrlMatcher }}</small></label></div>
    <div class="matcher"><label class="field"><span>工号字段路径</span><input v-model="draft.employeeIdField" type="text" placeholder="data.employeeId"><small class="hint">Object Path 示例：data.employeeId、data.user[0].id</small><small v-if="errors.employeeIdField" class="error">{{ errors.employeeIdField }}</small></label><label class="field"><span>姓名字段路径</span><input v-model="draft.nameField" type="text" placeholder="data.name"><small class="hint">Object Path 示例：data.name、$.user['displayName']</small><small v-if="errors.nameField" class="error">{{ errors.nameField }}</small></label></div>
    <footer class="actions"><button type="button" :disabled="saving || !formatsValid" @click="save('draft')">保存草稿</button><button type="button" :disabled="saving || !continueReady" @click="save('continue')">保存并继续</button><button type="button" :disabled="saving || !workbenchReady" @click="save('workbench')">保存并进入工作台</button></footer>
  </section>
</template>

<style scoped>
.sso-settings { max-width: 860px; }.panel-head { display: flex; justify-content: space-between; gap: 20px; padding: 3px 2px 18px; }.panel-head h2,.panel-head p { margin: 0; }.panel-head p { margin-top: 5px; color: var(--muted); font-size: 11px; }.save-state { min-width: 84px; color: var(--accent); font-size: 11px; text-align: right; }.toggle-row { display: flex; align-items: center; gap: 8px; padding: 12px 2px; border-top: 1px solid var(--line); color: var(--text-strong); font-size: 12px; font-weight: 650; }.warning { margin: 0; padding: 10px 12px; border-left: 3px solid var(--amber-line); background: var(--amber-soft); color: var(--amber); font-size: 11px; }.field { display: grid; gap: 6px; min-width: 0; color: var(--muted); font-size: 10px; }.field input,.field select { min-height: 34px; padding: 5px 8px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text); }.matcher { display: grid; grid-template-columns: minmax(190px,.7fr) minmax(260px,1.3fr); gap: 14px; padding-top: 12px; }.hint { color: var(--faint); }.error { color: var(--red); }.actions { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 18px; border-top: 1px solid var(--line); }.actions button { min-height: 34px; padding: 0 12px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text); font-size: 11px; font-weight: 650; }.actions button:hover:not(:disabled) { border-color: var(--focus); background: var(--hover); }.actions button:last-child { border-color: var(--accent); background: var(--accent); color: white; }@media (max-width: 760px) { .matcher { grid-template-columns: 1fr; } }
</style>
