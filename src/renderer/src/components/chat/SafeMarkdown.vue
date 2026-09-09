<script setup lang="ts">
import { computed } from 'vue'
import MarkdownInline from './MarkdownInline.vue'
import { parseSafeMarkdown } from './safe-markdown'
import type { MarkdownBlock } from './safe-markdown'

const props = defineProps<{
  content: string
}>()

const blocks = computed(() => parseSafeMarkdown(props.content))

function headingTag(level: Extract<MarkdownBlock, { type: 'heading' }>['level']): string {
  return `h${level}`
}
</script>

<template>
  <div class="safe-markdown" data-renderer="safe-markdown">
    <template v-for="(block, blockIndex) in blocks" :key="blockIndex">
      <component v-if="block.type === 'heading'" :is="headingTag(block.level)" class="markdown-heading"><MarkdownInline :segments="block.content" /></component>
      <pre v-else-if="block.type === 'code'" class="markdown-code-block"><code>{{ block.value }}</code></pre>
      <blockquote v-else-if="block.type === 'quote'" class="markdown-quote"><MarkdownInline :segments="block.content" /></blockquote>
      <ul v-else-if="block.type === 'unordered-list'" class="markdown-list markdown-unordered-list">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex"><MarkdownInline :segments="item" /></li>
      </ul>
      <ol v-else-if="block.type === 'ordered-list'" class="markdown-list markdown-ordered-list" :start="block.start">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex"><MarkdownInline :segments="item" /></li>
      </ol>
      <div v-else-if="block.type === 'table'" class="markdown-table-wrap">
        <table class="markdown-table">
          <thead><tr><th v-for="(cell, cellIndex) in block.header" :key="cellIndex"><MarkdownInline :segments="cell" /></th></tr></thead>
          <tbody><tr v-for="(row, rowIndex) in block.rows" :key="rowIndex"><td v-for="(cell, cellIndex) in row" :key="cellIndex"><MarkdownInline :segments="cell" /></td></tr></tbody>
        </table>
      </div>
      <hr v-else-if="block.type === 'thematic-break'" class="markdown-rule">
      <p v-else class="markdown-paragraph"><MarkdownInline :segments="block.content" /></p>
    </template>
  </div>
</template>

<style scoped>
.safe-markdown { min-width: 0; color: var(--text); font-size: 11px; line-height: 1.65; overflow-wrap: anywhere; }
.safe-markdown > :first-child { margin-top: 0; }.safe-markdown > :last-child { margin-bottom: 0; }
.markdown-paragraph { margin: 0 0 8px; white-space: normal; }
.markdown-heading { margin: 13px 0 7px; color: var(--text-strong); line-height: 1.35; }.markdown-heading:first-child { margin-top: 0; }h1.markdown-heading { font-size: 16px; }h2.markdown-heading { font-size: 14px; }h3.markdown-heading { font-size: 13px; }h4.markdown-heading,h5.markdown-heading,h6.markdown-heading { font-size: 11px; }
.markdown-list { margin: 0 0 8px; padding-left: 20px; }.markdown-list li + li { margin-top: 3px; }
.markdown-quote { margin: 0 0 8px; padding: 4px 0 4px 9px; border-left: 3px solid var(--accent); color: var(--muted); white-space: pre-line; }
.markdown-code-block { margin: 0 0 8px; padding: 9px 10px; overflow: auto; border: 1px solid var(--line); border-radius: 5px; background: var(--surface-soft); color: var(--text-strong); font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: 10px; line-height: 1.55; white-space: pre; }.markdown-code-block code { font: inherit; }
.safe-markdown :not(pre) > code { padding: 1px 4px; border: 1px solid var(--line); border-radius: 3px; background: var(--surface-soft); color: var(--text-strong); font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: .92em; }
.safe-markdown a { color: var(--focus); text-decoration: underline; text-underline-offset: 2px; }.safe-markdown a:hover { color: var(--accent); }
.markdown-rule { height: 1px; margin: 10px 0; border: 0; background: var(--line); }
.markdown-table-wrap { margin: 0 0 8px; overflow-x: auto; border: 1px solid var(--line); border-radius: 5px; }.markdown-table { width: 100%; min-width: max-content; border-collapse: collapse; font-size: 10px; }.markdown-table th,.markdown-table td { padding: 6px 8px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }.markdown-table th { color: var(--text-strong); background: var(--surface-soft); font-weight: 700; }.markdown-table tr > :last-child { border-right: 0; }.markdown-table tbody tr:last-child td { border-bottom: 0; }
</style>
