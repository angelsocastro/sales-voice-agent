#!/usr/bin/env tsx
/**
 * Debug local: ejercita el mismo LLM que usa el agente en producción
 * (createTelnyxKimiClient + OpenAILLM.withTelnyx, tal cual en agent.ts)
 * para confirmar que enable_thinking:false funciona a través de nuestro
 * propio código, no solo con curl suelto.
 *
 * Run: tsx --env-file=.env scripts/debug-kimi-latency.ts
 */

import { initializeLogger, llm } from '@livekit/agents'
import { LLM as OpenAILLM } from '@livekit/agents-plugin-openai'
import { createTelnyxKimiClient } from '../src/agent.js'

initializeLogger({ pretty: true, level: 'warn' })

async function main() {
  const model = OpenAILLM.withTelnyx({
    model: 'moonshotai/Kimi-K2.6',
    client: createTelnyxKimiClient(),
  })

  const chatCtx = llm.ChatContext.empty()
  chatCtx.addMessage({
    role: 'system',
    content: 'Eres un asistente virtual. Responde en español, breve.',
  })
  chatCtx.addMessage({ role: 'user', content: 'Hola.' })

  const t0 = performance.now()
  const stream = model.chat({ chatCtx })

  let firstChunkAt: number | null = null
  let text = ''
  for await (const chunk of stream) {
    if (firstChunkAt === null) firstChunkAt = performance.now()
    text += chunk.delta?.content ?? ''
  }
  const t1 = performance.now()

  console.log('TTFT (ms):', firstChunkAt !== null ? (firstChunkAt - t0).toFixed(0) : 'n/a')
  console.log('Total (ms):', (t1 - t0).toFixed(0))
  console.log('Response text:', JSON.stringify(text))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
