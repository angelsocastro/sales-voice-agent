#!/usr/bin/env tsx
/**
 * Compara TTFT con el system prompt completo de producción vs uno mínimo,
 * para aislar si el TTFT alto de Kimi K2.6 viene de prefill del prompt
 * largo o de otra cosa (red, cold start, etc.)
 *
 * Run: tsx --env-file=.env scripts/debug-prompt-length.ts
 */

import { initializeLogger, llm } from '@livekit/agents'
import { LLM as OpenAILLM } from '@livekit/agents-plugin-openai'
import { createTelnyxKimiClient, buildSystemPrompt, TEST_LEAD_CONTEXT } from '../src/agent.js'

initializeLogger({ pretty: true, level: 'warn' })

async function timedTurn(systemPrompt: string, userMsg: string) {
  const model = OpenAILLM.withTelnyx({
    model: 'moonshotai/Kimi-K2.6',
    client: createTelnyxKimiClient(),
  })
  const chatCtx = llm.ChatContext.empty()
  chatCtx.addMessage({ role: 'system', content: systemPrompt })
  chatCtx.addMessage({ role: 'user', content: userMsg })

  const t0 = performance.now()
  const stream = model.chat({ chatCtx })
  let firstChunkAt: number | null = null
  for await (const chunk of stream) {
    if (firstChunkAt === null) firstChunkAt = performance.now()
    void chunk
  }
  return firstChunkAt !== null ? firstChunkAt - t0 : -1
}

async function main() {
  const SHORT_PROMPT = 'Eres un asistente virtual. Responde en español, breve.'
  console.log(`SYSTEM_PROMPT largo: ${buildSystemPrompt(TEST_LEAD_CONTEXT).length} chars (~${Math.round(buildSystemPrompt(TEST_LEAD_CONTEXT).length / 4)} tokens aprox)`)
  console.log(`SHORT_PROMPT: ${SHORT_PROMPT.length} chars\n`)

  console.log('--- Prompt corto (3 runs) ---')
  for (let i = 0; i < 3; i++) {
    const ttft = await timedTurn(SHORT_PROMPT, 'Hola.')
    console.log(`  run ${i + 1}: TTFT ${ttft.toFixed(0)}ms`)
  }

  console.log('\n--- Prompt largo de producción (3 runs) ---')
  for (let i = 0; i < 3; i++) {
    const ttft = await timedTurn(buildSystemPrompt(TEST_LEAD_CONTEXT), 'Hola.')
    console.log(`  run ${i + 1}: TTFT ${ttft.toFixed(0)}ms`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
