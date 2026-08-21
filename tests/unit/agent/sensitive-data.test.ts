import { describe, expect, it } from 'vitest'
import { containsSensitiveMaterial, redactSensitiveText, SensitiveTextStreamRedactor } from '../../../src/main/agent/sensitive-data'

describe('sensitive data', () => {
  it('detects and redacts generic OpenAI sk credentials', () => {
    const genericOpenAiToken = 'sk-' + 'A'.repeat(32)

    expect(containsSensitiveMaterial(genericOpenAiToken)).toBe(true)
    expect(redactSensitiveText(`credential ${genericOpenAiToken}`).includes(genericOpenAiToken)).toBe(false)
    expect(redactSensitiveText(`credential ${genericOpenAiToken}`)).toContain('[REDACTED SENSITIVE CONTENT]')
  })

  it('detects and redacts a generic OpenAI credential adjacent to an identifier', () => {
    const genericOpenAiToken = 'sk-' + 'A'.repeat(32)
    const adjacentValue = `prefixX${genericOpenAiToken}`

    expect(containsSensitiveMaterial(adjacentValue)).toBe(true)
    expect(redactSensitiveText(adjacentValue).includes(genericOpenAiToken)).toBe(false)
  })

  it.each(['/', '+', '='])('detects and redacts a 40-character Base64 credential ending in %s', ending => {
    const base64Credential = 'A'.repeat(39) + ending

    expect(containsSensitiveMaterial(base64Credential)).toBe(true)
    expect(redactSensitiveText(base64Credential).includes(base64Credential)).toBe(false)
  })

  it('redacts Base64-like credentials longer than 40 characters without leaving a suffix', () => {
    const paddedCredential = 'A'.repeat(43) + '='
    const extendedCredential = 'A'.repeat(45) + '+/='

    for (const credential of [paddedCredential, extendedCredential]) {
      expect(redactSensitiveText(`credential ${credential}`).includes(credential)).toBe(false)
    }

    const redactor = new SensitiveTextStreamRedactor()
    redactor.push(extendedCredential.slice(0, 40))
    const terminalChunk = redactor.push(`${extendedCredential.slice(40)} `)

    expect(terminalChunk.includes(extendedCredential.slice(40))).toBe(false)
  })

  it('detects and redacts synthetic temporary and private-key filesystem paths', () => {
    const temporaryPath = `tmp:${['C:', 'synthetic', 'AppData', 'Local', 'Temp', 'access', 'profile.conf'].join('\\')}`
    const privateKeyPath = ['C:', 'synthetic', '.ssh', 'id_rsa'].join('\\')
    const pemPath = ['C:', 'synthetic', 'keys', 'identity.pem'].join('\\')

    for (const path of [temporaryPath, privateKeyPath, pemPath]) {
      expect(containsSensitiveMaterial(path)).toBe(true)
      expect(redactSensitiveText(`path ${path}`).includes(path)).toBe(false)
    }

    const redactor = new SensitiveTextStreamRedactor()
    const emitted = [
      redactor.push('result '),
      redactor.push(temporaryPath.slice(0, 4)),
      redactor.push(temporaryPath.slice(4)),
      redactor.push(' tail'),
      redactor.finish(),
    ]
    expect(emitted.every(content => !content.includes(temporaryPath))).toBe(true)
  })

  it('redacts wildcard .ssh id_* filenames before static or separator-terminated stream output', () => {
    const customIdentity = '/home/synthetic/.ssh/id_custom'
    const redactor = new SensitiveTextStreamRedactor()

    expect(containsSensitiveMaterial(customIdentity)).toBe(true)
    expect(redactSensitiveText(`path ${customIdentity}`)).not.toContain(customIdentity)
    expect(redactor.push(`before ${customIdentity}`)).toBe('')
    const released = `${redactor.push(' ')}${redactor.finish()}`
    expect(released).not.toContain(customIdentity)
    expect(released).toContain('[REDACTED SENSITIVE CONTENT]')
  })

  it('holds partial sensitive filesystem paths after JSON and Markdown punctuation until they can be redacted', () => {
    const temporaryPath = ['C:', 'synthetic', 'AppData', 'Local', 'Temp', 'AccessClient', 'profile.conf'].join('\\')
    const cases = [
      { path: ['C:', 'synthetic', '.ssh', 'id_rsa'].join('\\'), opening: 'JSON {"path":"', closing: '"} ' },
      { path: ['C:', 'synthetic', 'keys', 'identity.pem'].join('\\'), opening: 'Markdown **"', closing: '"** ' },
      { path: ['C:', 'synthetic', 'keys', 'identity.ppk'].join('\\'), opening: 'JSON {"path":"', closing: '"} ' },
      { path: ['C:', 'synthetic', 'keys', 'identity.key'].join('\\'), opening: 'Markdown **"', closing: '"** ' },
      { path: temporaryPath, opening: 'JSON {"path":"', closing: '"} ' },
      { path: `tmp:${temporaryPath}`, opening: 'Markdown **"', closing: '"** ' },
    ]

    for (const { path, opening, closing } of cases) {
      const redactor = new SensitiveTextStreamRedactor()
      const split = Math.max(1, Math.floor(path.length / 2))
      const releases = [
        redactor.push(`response ${opening}${path.slice(0, split)}`),
        redactor.push(`${path.slice(split)}${closing}`),
        redactor.finish(),
      ]
      const partial = path.slice(0, split)

      expect(releases.every(release => !release.includes(path))).toBe(true)
      expect(releases.every(release => !release.includes(partial))).toBe(true)
      expect(releases.join('')).not.toContain(path)
      expect(releases.join('')).toContain('[REDACTED SENSITIVE CONTENT]')
    }
  })

  it('releases a normal quoted filesystem path after its terminating delimiter', () => {
    const normalPath = ['C:', 'synthetic', 'project', 'notes.txt'].join('\\')
    const redactor = new SensitiveTextStreamRedactor()
    const first = redactor.push(`JSON {"path":"${normalPath}`)
    const second = redactor.push('"} ')

    expect(`${first}${second}${redactor.finish()}`).toBe(`JSON {"path":"${normalPath}"} `)
  })

  it('redacts a sk-proj credential split across deltas while preserving surrounding stream text', () => {
    const redactor = new SensitiveTextStreamRedactor()
    const token = 'sk-proj-' + 'A'.repeat(32)

    expect(redactor.push('ordinary text ')).toBe('ordinary text ')
    expect(redactor.push(token.slice(0, 5))).toBe('')
    const terminal = redactor.push(token.slice(5) + ' tail')
    expect(terminal).toContain('[REDACTED SENSITIVE CONTENT]')
    const final = redactor.finish()

    expect(`${terminal}${final}`).toContain(' tail')
    expect(`${terminal}${final}`).not.toContain(token)
  })

  it('redacts every simulated OpenAI project credential in one value', () => {
    const firstToken = 'sk-proj-' + 'A'.repeat(32)
    const secondToken = 'sk-proj-' + 'B'.repeat(32)
    const redacted = redactSensitiveText(`first ${firstToken} second ${secondToken}`)

    expect(redacted).not.toContain(firstToken)
    expect(redacted).not.toContain(secondToken)
    expect(redacted.match(/\[REDACTED SENSITIVE CONTENT\]/g)).toHaveLength(2)
  })

  it('redacts every simulated OpenAI project credential across stream chunks', () => {
    const firstToken = 'sk-proj-' + 'A'.repeat(32)
    const secondToken = 'sk-proj-' + 'B'.repeat(32)
    const redactor = new SensitiveTextStreamRedactor()
    const redacted = [
      redactor.push(`first ${firstToken} second ${secondToken.slice(0, 12)}`),
      redactor.push(`${secondToken.slice(12)} tail`),
      redactor.finish(),
    ].join('')

    expect(redacted).not.toContain(firstToken)
    expect(redacted).not.toContain(secondToken)
    expect(redacted.match(/\[REDACTED SENSITIVE CONTENT\]/g)).toHaveLength(2)
  })

  it.each([
    ['a JSON-quoted .ssh identity path', ['C:', 'synthetic', '.ssh', 'id_ed25519'].join('\\'), 'JSON {"path":"', '"} '],
    ['a Markdown-quoted .pem path', ['C:', 'synthetic', 'keys', 'identity.pem'].join('\\'), 'Markdown **"', '"** '],
    ['a JSON-quoted .ppk path', ['C:', 'synthetic', 'keys', 'identity.ppk'].join('\\'), 'JSON {"path":"', '"} '],
    ['a Markdown-quoted .key path', ['C:', 'synthetic', 'keys', 'identity.key'].join('\\'), 'Markdown **"', '"** '],
    ['a JSON-quoted tmp reference', `tmp:${['C:', 'synthetic', 'AppData', 'Local', 'Temp', 'AccessClient', 'profile.conf'].join('\\')}`, 'JSON {"path":"', '"} '],
    ['a Markdown-quoted Windows Temp AccessClient path', ['C:', 'synthetic', 'AppData', 'Local', 'Temp', 'AccessClient', 'profile.conf'].join('\\'), 'Markdown **"', '"** '],
    ['a JSON-quoted short-prefix OpenAI project credential', 'sk-proj-' + 'A'.repeat(32), 'JSON {"key":"', '"} '],
    ['a Markdown-quoted dynamic Base64-like value', 'A'.repeat(43) + '=', 'Markdown **"', '"** '],
  ])('holds every boundary of %s before any fragment can reach the stream', (_description, value, opening, closing) => {
    for (let cut = 1; cut < value.length; cut += 1) {
      const redactor = new SensitiveTextStreamRedactor()
      const prefix = value.slice(0, cut)
      const emitted = [redactor.push(`${opening}${prefix}`)]

      expect(emitted[0].endsWith(prefix)).toBe(false)

      emitted.push(redactor.push(`${value.slice(cut)}${closing}`), redactor.finish())
      const released = emitted.join('')
      expect(released).not.toContain(value)
      expect(released).toContain('[REDACTED SENSITIVE CONTENT]')
    }
  })
})
