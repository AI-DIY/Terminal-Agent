import { extname } from 'node:path'
import { PPKParser, type PPKParserOptions } from 'ppk-to-openssh'

export type PrivateKeyInput = {
  fileName: string
  content: string | Buffer
  passphrase?: string
}

export interface PpkConverter {
  convert(content: string, passphrase?: string): Promise<string | Buffer>
}

export class PpkToOpenSshConverter implements PpkConverter {
  async convert(content: string, passphrase?: string): Promise<string> {
    // The package's default OpenSSH encoder is not accepted by ssh2 for this
    // RSA PPK fixture. Its legacy PEM encoder is accepted by ssh2 and remains
    // a valid OpenSSH-compatible private-key representation for this transport.
    const parser = new PPKParser({ outputFormat: 'pem' } as unknown as PPKParserOptions)
    return (await parser.parse(content, passphrase)).privateKey
  }
}

export class PrivateKeyLoader {
  constructor(private readonly ppkConverter: PpkConverter) {}

  async load(input: PrivateKeyInput): Promise<string | Buffer> {
    const content = input.content
    const text = typeof content === 'string' ? content : content.toString('utf8')

    if (isPpk(input.fileName, text)) {
      return this.ppkConverter.convert(text, input.passphrase)
    }

    if (!isSupportedPrivateKey(text)) {
      throw new Error('Unsupported private key format')
    }
    if (isEncryptedPem(text) && !input.passphrase) {
      throw new Error('Private key passphrase is required')
    }

    return content
  }
}

function isPpk(fileName: string, content: string): boolean {
  return extname(fileName).toLowerCase() === '.ppk' || content.startsWith('PuTTY-User-Key-File-')
}

function isSupportedPrivateKey(content: string): boolean {
  return /^-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/m.test(content)
}

function isEncryptedPem(content: string): boolean {
  return content.includes('-----BEGIN ENCRYPTED PRIVATE KEY-----') || /Proc-Type:\s*4,ENCRYPTED/i.test(content)
}
