<script setup lang="ts">
import { onMounted, ref } from 'vue'
const endpoint = ref('https://api.openai.com/v1/chat/completions'); const model = ref('gpt-5'); const contextLimit = ref(12000); const hasApiKey = ref(false); const message = ref(''); const testing = ref(false)
onMounted(async () => { const saved = await window.terminalAgent.settings.getModel(); if (saved) { endpoint.value=saved.endpoint; model.value=saved.model; contextLimit.value=saved.contextLimit; hasApiKey.value=saved.hasApiKey } })
function input(){ return {endpoint:endpoint.value,model:model.value,contextLimit:Number(contextLimit.value)} }
async function save(){ message.value=''; try { await window.terminalAgent.settings.saveModel(input()); hasApiKey.value=(await window.terminalAgent.settings.getModel())?.hasApiKey ?? false;message.value='已保存'} catch(e){message.value=e instanceof Error?e.message:'保存失败'} }
async function test(){ message.value=''; testing.value=true; try { const result=await window.terminalAgent.settings.testModel(input()); message.value=`连接成功：${result.model}` } catch(e){ message.value=e instanceof Error?e.message:'模型连接测试失败' } finally { testing.value=false } }
</script>
<template><form class="settings-form" @submit.prevent="save"><p>OpenAI Chat Completions</p><label>接口地址<input v-model="endpoint" /></label><label>模型<input v-model="model" /></label><label>上下文长度<input v-model.number="contextLimit" type="number" /></label><p>API Key 由主进程安全存储；模型配置保存和测试不会传递明文密钥。</p><div class="actions"><button type="button" :disabled="testing" @click="test">{{testing?'正在测试…':'测试连接'}}</button><button type="submit" :disabled="testing">保存模型连接</button></div><p v-if="message" role="status">{{message}}</p></form></template>
<style scoped>.settings-form{display:grid;gap:12px;max-width:620px}.settings-form label{display:grid;gap:5px}.settings-form input{min-height:34px;padding:5px 8px}.actions{display:flex;gap:8px}.actions button{padding:8px 12px}</style>
