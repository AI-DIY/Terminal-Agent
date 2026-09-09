<script setup lang="ts">
import type { MarkdownInline as MarkdownInlineSegment } from './safe-markdown'

defineOptions({ name: 'MarkdownInline' })

defineProps<{
  segments: MarkdownInlineSegment[]
}>()
</script>

<template>
  <template v-for="(segment, index) in segments" :key="index">
    <strong v-if="segment.type === 'strong'"><MarkdownInline :segments="segment.children" /></strong>
    <em v-else-if="segment.type === 'emphasis'"><MarkdownInline :segments="segment.children" /></em>
    <s v-else-if="segment.type === 'strikethrough'"><MarkdownInline :segments="segment.children" /></s>
    <a v-else-if="segment.type === 'link'" :href="segment.href" target="_blank" rel="noopener noreferrer"><MarkdownInline :segments="segment.children" /></a>
    <code v-else-if="segment.type === 'code'">{{ segment.value }}</code>
    <br v-else-if="segment.type === 'line-break'">
    <template v-else>{{ segment.value }}</template>
  </template>
</template>
