type ComposerKeyEvent = Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'isComposing' | 'key' | 'metaKey' | 'shiftKey'>

export function shouldSendOnPlainEnter(event: ComposerKeyEvent): boolean {
  return event.key === 'Enter'
    && !event.isComposing
    && !event.shiftKey
    && !event.ctrlKey
    && !event.altKey
    && !event.metaKey
}

/**
 * Modified Enter is an explicit line-break shortcut in the chat composer.
 * Handling it in the component (rather than relying on browser defaults)
 * keeps Ctrl/Alt/Shift+Enter consistent across Chromium/Windows builds.
 * Meta+Enter is intentionally left to the platform because it is not one of
 * the documented Windows shortcuts.
 */
export function shouldInsertNewlineOnModifiedEnter(event: ComposerKeyEvent): boolean {
  return event.key === 'Enter'
    && !event.isComposing
    && !event.metaKey
    && (event.shiftKey || event.ctrlKey || event.altKey)
}
