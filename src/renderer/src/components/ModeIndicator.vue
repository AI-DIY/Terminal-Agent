<script setup lang="ts">
import type { SessionMode } from '../../../shared/contracts'
defineProps<{ mode: SessionMode }>()
</script>
<template><span :class="['mode-indicator', mode]">{{ mode === 'copilot' ? '辅助驾驶 - 变更需人工确认' : '全自动驾驶 - AI 可按当前会话目标执行' }}</span></template>
<style scoped>.mode-indicator{padding:5px 8px;border-radius:4px;font-size:13px}.copilot{background:#fef3c7;color:#78350f}.autonomous{background:#dcfce7;color:#14532d}</style>
