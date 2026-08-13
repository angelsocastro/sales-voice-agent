import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { verifyTelnyxSignature } from '../../src/webhooks/verify.js'

function makeKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  // Export public key as raw 32 bytes (strip SPKI prefix of 12 bytes)
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  const rawPublicKey = spkiDer.slice(12)
  const publicKeyBase64 = rawPublicKey.toString('base64')
  return { privateKey, publicKeyBase64 }
}

function sign(privateKey: any, message: string): string {
  return cryptoSign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64')
}

describe('verifyTelnyxSignature', () => {
  it('valid signature returns true', () => {
    const { privateKey, publicKeyBase64 } = makeKeypair()
    const timestamp = Math.floor(Date.now() / 1000).toString()
    const rawBody = '{"test":true}'
    const signature = sign(privateKey, `${timestamp}|${rawBody}`)
    expect(verifyTelnyxSignature(rawBody, signature, timestamp, publicKeyBase64)).toBe(true)
  })

  it('wrong signature returns false', () => {
    const { publicKeyBase64 } = makeKeypair()
    const timestamp = Math.floor(Date.now() / 1000).toString()
    expect(verifyTelnyxSignature('{"test":true}', 'invalidsig==', timestamp, publicKeyBase64)).toBe(false)
  })

  it('missing headers returns false', () => {
    const { publicKeyBase64 } = makeKeypair()
    expect(verifyTelnyxSignature('body', undefined, undefined, publicKeyBase64)).toBe(false)
  })

  it('timestamp too old returns false', () => {
    const { privateKey, publicKeyBase64 } = makeKeypair()
    const oldTimestamp = (Math.floor(Date.now() / 1000) - 400).toString()
    const rawBody = '{"test":true}'
    const signature = sign(privateKey, `${oldTimestamp}|${rawBody}`)
    expect(verifyTelnyxSignature(rawBody, signature, oldTimestamp, publicKeyBase64)).toBe(false)
  })
})
