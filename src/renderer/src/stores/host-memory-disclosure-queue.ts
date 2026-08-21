import { computed, ref } from 'vue'
import type { HostMemoryDisclosure } from '../../../shared/contracts'

export function createHostMemoryDisclosureQueue() {
  const disclosures = ref<HostMemoryDisclosure[]>([])
  const current = computed(() => disclosures.value[0] ?? null)
  function enqueue(disclosure: HostMemoryDisclosure): void {
    if (!disclosures.value.some(item => item.token === disclosure.token)) disclosures.value.push(disclosure)
  }
  function remove(token: string): void {
    const index = disclosures.value.findIndex(item => item.token === token)
    if (index >= 0) disclosures.value.splice(index, 1)
  }
  return { disclosures, current, enqueue, remove }
}
