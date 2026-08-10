import { describe, expect, it, vi } from 'vitest'
import { KeyMaterialStore } from '../../../src/main/ssh/key-material-store'

describe('KeyMaterialStore', () => {
  it('returns only a reference and file name, then consumes the private key exactly once', async () => {
    const readFile = vi.fn().mockResolvedValue(Buffer.from('PRIVATE KEY CONTENT'))
    const store = new KeyMaterialStore({
      showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: ['C:\\keys\\prod.ppk'] }),
      readFile,
      createId: () => 'key-reference',
    })

    await expect(store.select()).resolves.toEqual({ id: 'key-reference', fileName: 'prod.ppk' })
    expect(readFile).toHaveBeenCalledWith('C:\\keys\\prod.ppk')

    expect(store.take('key-reference', 'passphrase')).toEqual({
      fileName: 'prod.ppk',
      content: Buffer.from('PRIVATE KEY CONTENT'),
      passphrase: 'passphrase',
    })
    expect(() => store.take('key-reference')).toThrow('私钥引用已失效')
  })

  it('clears expired and explicitly cleared key references without returning their content', async () => {
    let now = 1_000
    const store = new KeyMaterialStore({
      showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: ['C:\\keys\\expired.pem'] }),
      readFile: vi.fn().mockResolvedValue(Buffer.from('PRIVATE KEY CONTENT')),
      createId: () => 'expired-reference',
      now: () => now,
      ttlMs: 100,
    })

    await store.select()
    now += 101
    expect(() => store.take('expired-reference')).toThrow('私钥引用已失效')

    await store.select()
    store.clear()
    expect(() => store.take('expired-reference')).toThrow('私钥引用已失效')
  })
})
