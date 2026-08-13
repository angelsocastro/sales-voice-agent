/**
 * Escritor mínimo de resultado de llamada en Attio — versión autocontenida
 * para el agente LiveKit (deploy Docker aislado, no puede importar
 * `../src/crm/attio.ts` del repo raíz: distinto rootDir, distinto build
 * context). Replica solo lo que hace falta de `src/crm/attio.ts` y
 * `src/tools/end-call.ts` / `schedule-callback.ts` (el MCP viejo que
 * invocaba el Telnyx AI Assistant y que dejó de dispararse al migrar).
 *
 * Object/campos iguales a los del adapter del repo raíz — mismo workspace
 * de Attio, mismos api_slug ya creados (status, call_attempts, next_attempt,
 * managed_by).
 */

const BASE = 'https://api.attio.com/v2'
const OBJECT = 'companies'

export type CallOutcome =
  | 'piloto_agendado' // dolor confirmado, el operador llamará con el piloto ya montado
  | 'descalificado' // sin dolor en ningún ángulo, o señal de descalificación rápida
  | 'no_decisor' // no se consiguió pasar con el decisor tras los intentos permitidos
  | 'callback' // el lead dio fecha/hora concreta para volver a llamar
  | 'opt_out' // "no me llaméis más" — LOPDGDD/Ley 11/2022, bloqueo permanente
  | 'contacto_malo' // número equivocado / no es el negocio correcto
  | 'buzon_voz' // contestador/IVR, no habló nadie — no lo genera el LLM, lo detecta el AMD

const OUTCOME_TO_STATUS: Record<CallOutcome, string> = {
  piloto_agendado: 'Interested',
  descalificado: 'Not Interested',
  no_decisor: 'Called',
  callback: 'Called',
  opt_out: 'Not Interested',
  contacto_malo: 'Bad Fit',
  buzon_voz: 'Called',
}

// Horas mínimas entre reintentos cuando no hay fecha explícita del lead —
// espeja MIN_HOURS_BETWEEN de dial-script.ts en el repo raíz.
const DEFAULT_RETRY_HOURS = 3
// Bloqueo duro para opt_out/contacto_malo: por encima de cualquier
// MAX_RETRIES real para que getDialableLeads los descarte para siempre.
const HARD_BLOCK_ATTEMPTS = 999

export interface RecordOutcomeInput {
  leadId: string
  outcome: CallOutcome
  resumen: string
  /** Solo para 'callback': fecha/hora ISO que dio el lead. */
  nextAttemptISO?: string
  /** Solo para 'callback': texto para la tarea de seguimiento. */
  taskText?: string
}

interface AttioRecord {
  values: Record<string, Array<{ value?: unknown }>>
}

async function attioFetch(apiKey: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    throw new Error(`Attio ${method} ${path} failed: ${res.status} ${await res.text()}`)
  }
  return res.status === 204 ? null : res.json()
}

async function getCurrentCallAttempts(apiKey: string, leadId: string): Promise<number> {
  const record = (await attioFetch(apiKey, 'GET', `/objects/${OBJECT}/records/${leadId}`)) as {
    data: AttioRecord
  }
  const raw = record.data.values.call_attempts?.[0]?.value
  return typeof raw === 'number' ? raw : 0
}

export async function recordCallOutcome(apiKey: string, input: RecordOutcomeInput): Promise<void> {
  const { leadId, outcome, resumen, nextAttemptISO, taskText } = input

  const currentAttempts = await getCurrentCallAttempts(apiKey, leadId)

  const values: Record<string, unknown> = {
    status: OUTCOME_TO_STATUS[outcome],
  }

  if (outcome === 'opt_out' || outcome === 'contacto_malo') {
    values.call_attempts = HARD_BLOCK_ATTEMPTS
  } else if (outcome === 'piloto_agendado') {
    values.call_attempts = currentAttempts + 1
    values.managed_by = 'closer' // el operador lo lleva ahora — fuera del auto-dialer
  } else {
    values.call_attempts = currentAttempts + 1
    const next =
      nextAttemptISO ?? new Date(Date.now() + DEFAULT_RETRY_HOURS * 60 * 60 * 1000).toISOString()
    values.next_attempt = next
  }

  const writes: Promise<unknown>[] = [
    attioFetch(apiKey, 'PATCH', `/objects/${OBJECT}/records/${leadId}`, { data: { values } }),
    attioFetch(apiKey, 'POST', '/notes', {
      data: {
        parent_object: OBJECT,
        parent_record_id: leadId,
        title: 'Nota',
        format: 'plaintext',
        content: `Resultado: ${outcome}\n\n${resumen}`,
      },
    }),
  ]

  if (outcome === 'callback' && taskText && nextAttemptISO) {
    const deadline = nextAttemptISO
    writes.push(
      attioFetch(apiKey, 'POST', '/tasks', {
        data: {
          content: taskText,
          deadline_at: deadline,
          is_completed: false,
          linked_records: [{ target_object: OBJECT, target_record_id: leadId }],
        },
      }),
    )
  }

  if (outcome === 'piloto_agendado' && taskText && nextAttemptISO) {
    writes.push(
      attioFetch(apiKey, 'POST', '/tasks', {
        data: {
          content: taskText,
          deadline_at: nextAttemptISO,
          is_completed: false,
          linked_records: [{ target_object: OBJECT, target_record_id: leadId }],
        },
      }),
    )
  }

  await Promise.all(writes)
}
