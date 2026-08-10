<script setup lang="ts">
import { onMounted, ref } from 'vue'
const endpoint = ref('https://api.openai.com/v1/chat/completions'); const model = ref('gpt-5'); const contextLimit = ref(12000); const apiKey = ref(''); const hasApiKey = ref(false); const message = ref('')
onMounted(async () => { const saved = await window.terminalAgent.settings.getModel(); if (saved) { endpoint.value=saved.endpoint; model.value=saved.model; contextLimit.value=saved.contextLimit; hasApiKey.value=saved.hasApiKey } })
async function save(){ message.value=''; try { await window.terminalAgent.settings.saveModel({endpoint:endpoint.value,model:model.value,contextLimit:Number(contextLimit.value),...(apiKey.value?{apiKey:apiKey.value}:{})}); apiKey.value='';hasApiKey.value=true;message.value='已保存'} catch(e){message.value=e instanceof Error?e.message:'保存失败'} }
</script>
<template><form class="settings-form" @submit.prevent="save"><p>OpenAI Chat Completions</p><label>接口地址<input v-model="endpoint" /></label><label>模型<input v-model="model" /></label><label>上下文长度<input v-model.number="contextLimit" type="number" /></label><label>API Key <input v-model="apiKey" type="password" :placeholder="hasApiKey?'已保存，留空则保持不变':'请输入 API Key'" /></label><button type="submit">保存模型连接</button><p v-if="message">{{message}}</p></form></template>
<style scoped>.settings-form{display:grid;gap:12px;max-width:620px}.settings-form label{display:grid;gap:5px}.settings-form input{min-height:34px;padding:5px 8px}</style>
