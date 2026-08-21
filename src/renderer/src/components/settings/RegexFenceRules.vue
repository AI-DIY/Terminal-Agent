<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { RegexFenceRule } from '../../../../main/agent/regex-fence-service'
import { testRegexFenceRules, validateRegexFenceRules } from './regex-fence-rule-tester'
const rules=ref<RegexFenceRule[]>([]);const tester=ref('');const testResult=ref('');const message=ref('')
onMounted(async()=>{rules.value=await window.terminalAgent.settings.getRegexRules()})
function add(){rules.value.push({id:`rule-${Date.now()}`,name:'新规则',pattern:'',enabled:true})} function test(){testResult.value=testRegexFenceRules(rules.value,tester.value)} async function save(){const validation=validateRegexFenceRules(rules.value);if(!validation.valid){message.value=validation.error;return}try{await window.terminalAgent.settings.saveRegexRules(rules.value);message.value='已保存'}catch(e){message.value=e instanceof Error?e.message:'保存失败'}}
</script>
<template><section class="rules"><div v-for="(rule,index) in rules" :key="rule.id" class="rule"><input v-model="rule.enabled" type="checkbox" :aria-label="`${rule.name} 已启用`"/><input v-model="rule.name" aria-label="规则名称"/><input v-model="rule.pattern" aria-label="正则表达式"/><span>命中即拦截</span><button type="button" aria-label="删除规则" @click="rules.splice(index,1)">删除</button></div><button type="button" @click="add">新增规则</button><label>测试命令<input v-model="tester"/></label><button type="button" @click="test">测试匹配</button><p>{{testResult}}</p><button type="button" @click="save">保存安全围栏规则</button><p>{{message}}</p></section></template>
<style scoped>.rules{display:grid;gap:10px}.rule{display:grid;grid-template-columns:auto minmax(100px,1fr) minmax(180px,2fr) auto auto;gap:8px;align-items:center}.rules input{min-height:32px;padding:4px 7px}@media(max-width:700px){.rule{grid-template-columns:auto 1fr}.rule span{grid-column:2}}</style>
