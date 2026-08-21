export const MAX_MODEL_API_KEY_BYTES = 4_096

const pemPrivateKeyPattern = /-----BEGIN [^-]*PRIVATE KEY-----/

export function validateModelApiKey(apiKey: string): string {
  const value = apiKey.trim()
  if (!value) throw new Error('API key file is empty')
  if (Buffer.byteLength(value, 'utf8') > MAX_MODEL_API_KEY_BYTES) {
    throw new Error('API key exceeds the maximum supported size')
  }
  if (pemPrivateKeyPattern.test(value)) {
    throw new Error('API key file contains private key material')
  }
  return value
}
