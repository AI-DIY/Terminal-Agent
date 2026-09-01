type ComposerKeyEvent = Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'isComposing' | 'key' | 'metaKey' | 'shiftKey'>

export function shouldSendOnPlainEnter(event: ComposerKeyEvent): boolean {
  return event.key === 'Enter'
    && !event.isComposing
    && !event.shiftKey
    && !event.ctrlKey
    && !event.altKey
    && !event.metaKey
}
