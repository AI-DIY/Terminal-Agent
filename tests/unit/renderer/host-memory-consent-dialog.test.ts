import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('HostMemoryConsentDialog', () => {
  it('dismisses on Escape while preserving the existing focus-restoration lifecycle', () => {
    const source = readFileSync(new URL('../../../src/renderer/src/components/workbench/HostMemoryConsentDialog.vue', import.meta.url), 'utf8')
    expect(source).toContain("event.key === 'Escape'")
    expect(source).toContain("event.preventDefault(); emit('close'); return")
    expect(source).toContain('onBeforeUnmount(() => previous?.focus())')
  })

  it('locks both consent actions while acknowledgement is being submitted', () => {
    const source = readFileSync(new URL('../../../src/renderer/src/components/workbench/HostMemoryConsentDialog.vue', import.meta.url), 'utf8')
    expect(source).toContain('submitting: boolean')
    expect(source).toContain(':aria-busy="props.submitting"')
    expect(source.match(/:disabled="props\.submitting"/g)).toHaveLength(2)
    expect(source).toContain("if (props.submitting) return")
  })

  it('guards duplicate acknowledgement attempts in the workbench', () => {
    const source = readFileSync(new URL('../../../src/renderer/src/views/WorkbenchView.vue', import.meta.url), 'utf8')
    expect(source).toContain('const hostMemorySubmitting = ref(false)')
    expect(source).toContain('if (!disclosure || hostMemorySubmitting.value) return')
    expect(source).toContain('hostMemorySubmitting.value = true')
    expect(source).toContain('finally { hostMemorySubmitting.value = false }')
    expect(source).toContain(':submitting="hostMemorySubmitting"')
  })
})
