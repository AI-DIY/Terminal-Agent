import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { utils } from 'ssh2'
import { describe, expect, it } from 'vitest'
import { PpkToOpenSshConverter, PrivateKeyLoader } from '../../../src/main/ssh/private-key-loader'

const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'keys', 'rsa-1024-v2-pass.ppk')

describe('PrivateKeyLoader', () => {
  it('returns OpenSSH and PEM content directly without sending it to the PPK converter', async () => {
    const loader = new PrivateKeyLoader({ convert: async () => { throw new Error('unexpected PPK conversion') } })
    const openssh = '-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----'
    const pem = '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----'

    await expect(loader.load({ fileName: 'id_ed25519', content: openssh })).resolves.toBe(openssh)
    await expect(loader.load({ fileName: 'id_rsa.pem', content: pem })).resolves.toBe(pem)
  })

  it('requires a passphrase before accepting an encrypted PEM key', async () => {
    const loader = new PrivateKeyLoader({ convert: async () => 'unused' })
    const encryptedPem = '-----BEGIN ENCRYPTED PRIVATE KEY-----\ntest\n-----END ENCRYPTED PRIVATE KEY-----'

    await expect(loader.load({ fileName: 'encrypted.pem', content: encryptedPem })).rejects.toThrow('Private key passphrase is required')
    await expect(loader.load({ fileName: 'encrypted.pem', content: encryptedPem, passphrase: 'test123' })).resolves.toBe(encryptedPem)
  })

  it('converts an encrypted PPK fixture with its supplied passphrase', async () => {
    const content = await readFile(fixturePath, 'utf8')
    const loader = new PrivateKeyLoader(new PpkToOpenSshConverter())

    const key = await loader.load({ fileName: 'rsa-1024-v2-pass.ppk', content, passphrase: 'test123' })

    expect(key).toContain('-----BEGIN RSA PRIVATE KEY-----')
    expect(utils.parseKey(key)).not.toBeInstanceOf(Error)
  })

  it('rejects the encrypted PPK fixture without a passphrase', async () => {
    const content = await readFile(fixturePath, 'utf8')
    const loader = new PrivateKeyLoader(new PpkToOpenSshConverter())

    await expect(loader.load({ fileName: 'rsa-1024-v2-pass.ppk', content })).rejects.toThrow()
  })
})
