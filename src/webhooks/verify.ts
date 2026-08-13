import { verify as cryptoVerify } from 'node:crypto'

export function verifyTelnyxSignature(
  rawBody: string,
  signature: string | undefined,
  timestamp: string | undefined,
  publicKeyBase64: string
): boolean {
  if (!signature || !timestamp) return false

  const ts = parseInt(timestamp, 10)
  if (isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false

  try {
    const message = `${timestamp}|${rawBody}`
    const publicKeyRaw = Buffer.from(publicKeyBase64, 'base64')
    const signatureBuffer = Buffer.from(signature, 'base64')
    const messageBuffer = Buffer.from(message, 'utf8')

    // Wrap raw 32-byte Ed25519 key in SPKI DER format for Node crypto
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')
    const spkiKey = Buffer.concat([spkiPrefix, publicKeyRaw])

    return cryptoVerify(null, messageBuffer, { key: spkiKey, format: 'der', type: 'spki' }, signatureBuffer)
  } catch {
    return false
  }
}
