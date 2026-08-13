/**
 * Telemetría de latencia por turno.
 *
 * El agente Python original logueaba `metrics_collected` en cada turno
 * (livekit-agent-py.bak/agent.py) — el port a TypeScript se dejó eso por el
 * camino, así que desde la migración no había forma de medir la latencia real
 * en producción salvo abriendo el dashboard llamada por llamada.
 *
 * Aquí se reconstruye, y además se agrega por turno: LiveKit emite las
 * métricas sueltas (EOU, LLM, TTS) en eventos separados, pero lo que importa
 * para "¿cuánto tarda el agente en contestar?" es la suma de las tres — el hueco
 * entre que el lead calla y sale audio del agente:
 *
 *   EOU (detección de fin de turno) + TTFT del LLM + TTFB del TTS
 *
 * Se loguea una línea `LATENCY_TURN` por turno con ese desglose. También se
 * loguean las predicciones del turn detector (`eot_prediction`) porque son el
 * dato con el que se calibran `endpointing.minDelay/maxDelay`, y las falsas
 * interrupciones — que en telefonía ruidosa son la señal de que el ruido de
 * fondo está cortando al agente a mitad de frase.
 */

import { AgentSessionEventTypes, log, type voice } from '@livekit/agents'

interface TurnTiming {
  startedAt: number
  eouDelayMs?: number
  transcriptionDelayMs?: number
  llmTtftMs?: number
  ttsTtfbMs?: number
}

/** Se descartan turnos incompletos más viejos que esto (tool calls sin TTS, turnos interrumpidos). */
const TURN_TTL_MS = 60_000

export function attachSessionObservability(
  session: voice.AgentSession,
  context: Record<string, unknown> = {},
): void {
  const logger = log().child({ component: 'voice-agent', ...context })
  const turns = new Map<string, TurnTiming>()

  const timing = (speechId: string | undefined): TurnTiming => {
    const key = speechId ?? 'unknown'
    const now = Date.now()
    for (const [id, t] of turns) {
      if (now - t.startedAt > TURN_TTL_MS) turns.delete(id)
    }
    let entry = turns.get(key)
    if (!entry) {
      entry = { startedAt: now }
      turns.set(key, entry)
    }
    return entry
  }

  // Un turno se considera medido cuando ya se sabe cuándo empezó a salir audio:
  // TTFB del TTS es el último eslabón de la cadena.
  const flushIfComplete = (speechId: string | undefined, entry: TurnTiming) => {
    if (entry.ttsTtfbMs === undefined || entry.llmTtftMs === undefined) return
    const totalMs =
      (entry.eouDelayMs ?? 0) + entry.llmTtftMs + entry.ttsTtfbMs
    logger.info(
      {
        speechId,
        eouDelayMs: entry.eouDelayMs,
        transcriptionDelayMs: entry.transcriptionDelayMs,
        llmTtftMs: entry.llmTtftMs,
        ttsTtfbMs: entry.ttsTtfbMs,
        totalMs,
      },
      'LATENCY_TURN',
    )
    turns.delete(speechId ?? 'unknown')
  }

  session.on(AgentSessionEventTypes.MetricsCollected, ev => {
    const m = ev.metrics
    switch (m.type) {
      case 'eou_metrics': {
        const entry = timing(m.speechId)
        entry.eouDelayMs = m.endOfUtteranceDelayMs
        entry.transcriptionDelayMs = m.transcriptionDelayMs
        flushIfComplete(m.speechId, entry)
        break
      }
      case 'llm_metrics': {
        if (m.cancelled) break // generación preemptiva descartada: no es un turno real
        const entry = timing(m.speechId)
        entry.llmTtftMs = m.ttftMs
        flushIfComplete(m.speechId, entry)
        break
      }
      case 'tts_metrics': {
        if (m.cancelled) break
        const entry = timing(m.speechId)
        entry.ttsTtfbMs = m.ttfbMs
        flushIfComplete(m.speechId, entry)
        break
      }
      default:
        break
    }
  })

  // Dato de calibración del endpointing: si `probability` queda por debajo de
  // `threshold` de forma sistemática, el agente está esperando `maxDelay` en
  // cada turno y hay que revisar el modelo de turnos, no subir el delay.
  session.on(AgentSessionEventTypes.EotPrediction, ev => {
    logger.debug(
      {
        probability: ev.probability,
        threshold: ev.threshold,
        inferenceDurationMs: ev.inferenceDurationMs,
        delayMs: ev.delayMs,
      },
      'EOT_PREDICTION',
    )
  })

  // Señal directa de "el ruido de fondo me está cortando": el agente se calló
  // por una interrupción que resultó no ser voz del lead.
  session.on(AgentSessionEventTypes.AgentFalseInterruption, ev => {
    logger.warn({ resumed: ev.resumed }, 'FALSE_INTERRUPTION')
  })

  session.on(AgentSessionEventTypes.Error, ev => {
    // `ev.source` es la instancia del modelo (STT/LLM/TTS) — se loguea solo su
    // nombre de clase, no el objeto entero.
    logger.error({ err: ev.error, source: ev.source?.constructor?.name }, 'SESSION_ERROR')
  })

  session.once(AgentSessionEventTypes.Close, ev => {
    logger.info({ reason: ev.reason, usage: session.usage }, 'SESSION_CLOSED')
    turns.clear()
  })
}
