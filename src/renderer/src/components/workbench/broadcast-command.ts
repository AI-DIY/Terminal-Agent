/**
 * Converts a broadcast editor draft into the exact terminal bytes to send.
 * The expanded editor may contain visual line breaks. When its last line has
 * no terminator, complete that last command without changing pasted terminal
 * control sequences such as Ctrl+C or ANSI escapes.
 */
export function broadcastCommandPayload(value: string, completeMultilineCommand = false): string | null {
  const containsControl = hasTerminalControlCharacter(value)
  if (!value || (!value.trim() && !containsControl)) return null

  const endsWithLineTerminator = /[\r\n]$/.test(value)
  const hasRawTerminalControl = hasRawTerminalControlCharacter(value)
  if (completeMultilineCommand && value.includes('\n') && !endsWithLineTerminator && !hasRawTerminalControl) {
    return `${value}\r`
  }

  return containsControl ? value : `${value}\r`
}

function hasTerminalControlCharacter(value: string): boolean {
  return containsCharacterCode(value, (code) => code <= 0x1f || code === 0x7f)
}

function hasRawTerminalControlCharacter(value: string): boolean {
  return containsCharacterCode(
    value,
    (code) => code <= 0x09 || (code >= 0x0b && code <= 0x1f) || code === 0x7f
  )
}

function containsCharacterCode(value: string, matches: (code: number) => boolean): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (matches(value.charCodeAt(index))) return true
  }
  return false
}
