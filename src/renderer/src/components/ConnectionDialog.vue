<script setup lang="ts">
import type { RendererSessionRequest, SavedDirectSessionInput } from '../../../shared/contracts'
import type { DirectSessionSummary } from '../../../main/ssh/direct-session-repository'
import DirectSshForm from './connections/DirectSshForm.vue'
import type { DirectSshConnectRequest, PrivateKeySelection } from './connections/DirectSshForm.vue'

export type ConnectionDialogRequest = { connection: RendererSessionRequest; profile?: SavedDirectSessionInput }

const props = defineProps<{ editingProfile?: DirectSessionSummary | null }>()
const emit = defineEmits<{
  connect: [request: ConnectionDialogRequest]
  saveProfile: [profile: SavedDirectSessionInput]
  selectPrivateKey: [accept: (selection: PrivateKeySelection | null) => void]
}>()

function connect(request: DirectSshConnectRequest): void {
  emit('connect', request)
}
</script>

<template>
  <section class="connection-dialog">
    <DirectSshForm
      :mode="props.editingProfile?.authKind ?? 'password'"
      :editing-profile="props.editingProfile"
      @connect="connect"
      @save-profile="emit('saveProfile', $event)"
      @select-private-key="emit('selectPrivateKey', $event)"
    />
  </section>
</template>

<style scoped>
.connection-dialog { color: var(--text, #e2e8f0); }
</style>
