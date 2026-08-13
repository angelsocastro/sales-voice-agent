import { NextResponse } from 'next/server'
// Cross-import directo desde src/ del repo raíz — a diferencia de
// livekit-agent (que se despliega con su propio Dockerfile y build context
// aislado, ver livekit-agent/src/crm-outcome.ts), sdr-console no tiene
// Dockerfile propio: corre con el monorepo entero presente en disco, así
// que no hay motivo para duplicar el cliente de Attio ni la lógica de
// marcado — una sola fuente de verdad para "qué es un lead marcable".
import { createAttioAdapter } from '../../../../src/crm/attio'

// Mismos defaults que runDialer()/scripts/call.ts --batch (dial-script.ts).
const MAX_RETRIES = 3
const MIN_HOURS_BETWEEN = 3

export async function GET() {
  const apiKey = process.env.ATTIO_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'Falta ATTIO_API_KEY' }, { status: 500 })
  }

  const adapter = await createAttioAdapter(apiKey)
  const leads = await adapter.getDialableLeads(MAX_RETRIES, MIN_HOURS_BETWEEN)

  // getDialableLeads no ordena (ver su comentario en src/crm/attio.ts) — el
  // orden de la cola sí importa aquí, así que se ordena solo para mostrar:
  // nunca-llamados primero, luego el callback más vencido. No toca la
  // función compartida ni cambia el comportamiento de runDialer().
  const sorted = [...leads].sort((a, b) => {
    const nextA = (a.custom.next_attempt as string | null) ?? null
    const nextB = (b.custom.next_attempt as string | null) ?? null
    if (!nextA && !nextB) return 0
    if (!nextA) return -1
    if (!nextB) return 1
    return new Date(nextA).getTime() - new Date(nextB).getTime()
  })

  return NextResponse.json({
    leads: sorted.map(lead => ({
      id: lead.id,
      displayName: lead.display_name ?? lead.id,
      phone: lead.contacts.flatMap(c => c.phones).find(p => p.phone)?.phone ?? null,
      callAttempts: (lead.custom.call_attempts as number) ?? 0,
      nextAttempt: (lead.custom.next_attempt as string | null) ?? null,
    })),
  })
}
