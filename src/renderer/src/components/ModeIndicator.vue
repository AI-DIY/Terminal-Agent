<script setup lang="ts">
import type { SessionMode } from '../../../shared/contracts'
defineProps<{ mode: SessionMode }>()
</script>
<template><span :class="['mode-indicator', mode]"><span>{{ mode === 'copilot' ? '辅助驾驶' : '全自动驾驶' }}</span><span class="mode-detail"> - {{ mode === 'copilot' ? '变更需人工确认' : 'AI 可按当前会话目标执行' }}</span></span></template>
<style scoped>
.mode-indicator { display: inline-flex; flex: 0 0 auto; padding: 5px 8px; border-radius: 4px; font-size: 13px; white-space: nowrap; }
.copilot { background: #fef3c7; color: #78350f; }
.autonomous { background: #dcfce7; color: #14532d; }
@media (max-width: 1060px) { .mode-detail { display: none; } }
</style>
