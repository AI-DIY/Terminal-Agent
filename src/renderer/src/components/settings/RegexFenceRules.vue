<script setup lang="ts">
import { Plus, Trash2 } from '@lucide/vue'
import { onMounted, ref } from 'vue'
import type { RegexFenceRule } from '../../../../main/agent/regex-fence-service'
import { testRegexFenceRules, validateRegexFenceRules } from './regex-fence-rule-tester'

const rules = ref<RegexFenceRule[]>([])
const tester = ref('')
const testResult = ref('')
const message = ref('')

onMounted(async () => { rules.value = await window.terminalAgent.settings.getRegexRules() })

function add(): void {
  rules.value.push({ id: `rule-${Date.now()}`, name: '新规则', pattern: '', enabled: true })
}

function test(): void {
  testResult.value = testRegexFenceRules(rules.value, tester.value)
}

async function save(): Promise<void> {
  const validation = validateRegexFenceRules(rules.value)
  if (!validation.valid) { message.value = validation.error; return }
  try {
    await window.terminalAgent.settings.saveRegexRules(rules.value)
    message.value = '安全围栏规则已保存'
  } catch (error) {
    message.value = error instanceof Error ? error.message : '保存失败'
  }
}
</script>

<template>
  <section class="settings-panel rules" aria-labelledby="regex-fence-title">
    <header class="settings-lead">
      <h2 id="regex-fence-title">安全围栏</h2>
      <p>辅助驾驶下，未通过确认或命中本地正则规则的命令不会发送到 Shell。</p>
    </header>

    <div class="rules-table-wrap">
      <table class="rules-table">
        <thead><tr><th>启用</th><th>规则名称</th><th>正则表达式</th><th>处理</th><th><span class="sr-only">操作</span></th></tr></thead>
        <tbody>
          <tr v-for="(rule,index) in rules" :key="rule.id">
            <td><input v-model="rule.enabled" type="checkbox" :aria-label="`启用${rule.name}规则`"></td>
            <td><input v-model="rule.name" aria-label="规则名称"></td>
            <td><input v-model="rule.pattern" aria-label="正则表达式" spellcheck="false"></td>
            <td><strong>命中即拦截</strong></td>
            <td><button type="button" class="icon-button danger" aria-label="删除规则" title="删除规则" @click="rules.splice(index,1)"><Trash2 :size="15" aria-hidden="true" /></button></td>
          </tr>
        </tbody>
      </table>
    </div>

    <button type="button" class="add-rule" @click="add"><Plus :size="14" aria-hidden="true" /><span>新增规则</span></button>

    <section class="rule-tester" aria-labelledby="rule-tester-title">
      <label id="rule-tester-title" for="fence-test-command">测试命令</label>
      <div><input id="fence-test-command" v-model="tester"><button type="button" @click="test">测试匹配</button></div>
      <p v-if="testResult" role="status">{{ testResult }}</p>
    </section>

    <div class="settings-actions">
      <button type="button" class="primary-button" @click="save">保存安全围栏规则</button>
      <span v-if="message" role="status">{{ message }}</span>
    </div>
  </section>
</template>

<style scoped>
.rules { display: grid; align-content: start; gap: 14px; min-width: 0; }.rules h2,.rules p { margin: 0; }
.settings-lead { display: grid; gap: 6px; }.settings-lead h2 { color: var(--text-strong); font-size: 19px; }.settings-lead p { color: var(--muted); font-size: 11px; line-height: 1.6; }
.rules-table-wrap { min-width: 0; overflow-x: auto; }.rules-table { width: 100%; min-width: 680px; border-collapse: collapse; table-layout: fixed; }.rules-table th,.rules-table td { padding: 9px 8px; border-bottom: 1px solid var(--line-soft); text-align: left; }.rules-table th { color: var(--muted); font-size: 10px; font-weight: 650; }.rules-table th:first-child,.rules-table td:first-child { width: 56px; }.rules-table th:nth-child(2) { width: 30%; }.rules-table th:nth-child(3) { width: 42%; }.rules-table th:nth-child(4) { width: 120px; }.rules-table th:last-child,.rules-table td:last-child { width: 42px; text-align: right; }
.rules-table input:not([type="checkbox"]),.rule-tester input { box-sizing: border-box; width: 100%; min-width: 0; height: 34px; padding: 0 9px; border: 1px solid var(--line); border-radius: 5px; outline: 0; background: var(--surface-soft); color: var(--text); font: 11px Inter,"Segoe UI",sans-serif; }.rules-table input:not([type="checkbox"]):focus,.rule-tester input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }.rules-table input[type="checkbox"] { width: 15px; height: 15px; accent-color: var(--accent); }.rules-table td strong { color: var(--amber); font-size: 10px; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 32px; padding: 0 11px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text); font-size: 11px; }.add-rule { width: fit-content; }.icon-button { width: 28px; min-height: 28px; padding: 0; }.icon-button.danger { color: var(--red); }.icon-button:hover,.add-rule:hover,.rule-tester button:hover { border-color: var(--focus); background: var(--hover); color: var(--text-strong); }
.rule-tester { display: grid; gap: 8px; margin-top: 8px; padding-top: 18px; border-top: 1px solid var(--line); }.rule-tester > label { color: var(--text-strong); font-size: 11px; font-weight: 650; }.rule-tester > div { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 8px; }.rule-tester p { color: var(--green); font-size: 10px; }
.settings-actions { display: flex; align-items: center; gap: 12px; }.settings-actions span { color: var(--accent); font-size: 11px; }.primary-button { border-color: var(--accent); background: var(--accent); color: #fff; font-weight: 650; }.primary-button:hover { background: color-mix(in srgb,var(--accent) 88%,#000); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
@media (max-width: 1060px) { .rules-table { min-width: 0; }.rules-table th,.rules-table td { padding-right: 6px; padding-left: 6px; }.rules-table th:first-child,.rules-table td:first-child { width: 44px; }.rules-table th:nth-child(2) { width: 28%; }.rules-table th:nth-child(3) { width: 43%; }.rules-table th:nth-child(4) { width: 88px; }.rules-table th:last-child,.rules-table td:last-child { width: 34px; } }
@media (max-width: 760px) { .rule-tester > div { grid-template-columns: 1fr; }.rule-tester button { justify-self: start; } }
</style>
