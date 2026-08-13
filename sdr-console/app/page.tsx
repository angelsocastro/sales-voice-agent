'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

interface QueuedLead {
  id: string
  displayName: string
  phone: string | null
  callAttempts: number
  nextAttempt: string | null
}

interface IncomingCall {
  roomName: string
  phone: string
  companyName?: string
  receivedAt: number
}

type CallMode = 'shadow' | 'voice'

const INCOMING_POLL_MS = 3000

// Cola en el propio dashboard, no un script de terminal aparte: mismo
// patrón que usan las herramientas de dialer de verdad (Salesloft/
// Outreach/Orum) — el rep tiene la lista y el botón de llamar en el mismo
// sitio, nunca dos pasos por dos herramientas distintas. "Llamar al
// siguiente" toma el primero de la cola (ya viene ordenada por el servidor:
// nunca-llamados primero, luego el callback más vencido) para no tener que
// elegir cada vez — ver /api/queue.
export default function Home() {
  const router = useRouter()
  const [leads, setLeads] = useState<QueuedLead[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialingId, setDialingId] = useState<string | null>(null)
  // Shadow (el operador habla, el agente sugiere) es el modo de trabajo normal —
  // voice (el agente habla solo, TTS) se deja como toggle secundario para
  // poder comparar humano vs IA a propósito, no para uso diario.
  const [mode, setMode] = useState<CallMode>('shadow')
  const [incoming, setIncoming] = useState<IncomingCall[]>([])
  const [answeringRoom, setAnsweringRoom] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/queue')
      .then(res => res.json())
      .then(data => {
        if (data.error) throw new Error(data.error)
        setLeads(data.leads)
      })
      .catch(err => setError(String(err)))
  }, [])

  // Sondeo simple — no hay aviso por push todavía (decisión explícita, ver
  // conversación de diseño). Solo te enteras de una llamada entrante si
  // tienes esta pestaña abierta.
  useEffect(() => {
    let cancelled = false
    const poll = () => {
      fetch('/api/incoming')
        .then(res => res.json())
        .then(data => {
          if (!cancelled) setIncoming(data.calls ?? [])
        })
        .catch(() => {})
    }
    poll()
    const interval = setInterval(poll, INCOMING_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  const dial = async (leadId: string) => {
    setDialingId(leadId)
    setError(null)
    try {
      const res = await fetch('/api/dial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadId, mode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Fallo al marcar')
      router.push(
        `/call/${encodeURIComponent(data.roomName)}?lead=${encodeURIComponent(data.leadName)}&mode=${data.mode}`,
      )
    } catch (err) {
      setError(String(err))
      setDialingId(null)
    }
  }

  const answer = useCallback(
    async (roomName: string) => {
      setAnsweringRoom(roomName)
      setError(null)
      try {
        const res = await fetch(`/api/incoming/${encodeURIComponent(roomName)}/claim`, { method: 'POST' })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'No se pudo contestar')
        router.push(`/call/${encodeURIComponent(data.roomName)}?lead=${encodeURIComponent(data.leadName)}`)
      } catch (err) {
        setError(String(err))
        setAnsweringRoom(null)
      }
    },
    [router],
  )

  return (
    <div style={{ padding: '2rem', maxWidth: 720, margin: '0 auto' }}>
      {incoming.map(call => (
        <div
          key={call.roomName}
          style={{
            background: 'var(--panel)',
            border: '2px solid var(--live)',
            borderRadius: 10,
            padding: '1rem 1.25rem',
            marginBottom: '1.5rem',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <div style={{ fontSize: '0.75rem', color: 'var(--live)', fontWeight: 700 }}>LLAMADA ENTRANTE</div>
            <div style={{ fontWeight: 600, fontSize: '1.1rem' }}>{call.companyName || call.phone}</div>
            {call.companyName && <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>{call.phone}</div>}
          </div>
          <button
            onClick={() => answer(call.roomName)}
            disabled={answeringRoom !== null}
            style={{
              background: 'var(--live)',
              color: 'white',
              border: 'none',
              borderRadius: 8,
              padding: '0.6rem 1.2rem',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {answeringRoom === call.roomName ? 'Entrando…' : 'Contestar'}
          </button>
        </div>
      ))}

      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '1rem' }}>
        <h1 style={{ fontSize: '1.25rem' }}>Cola de llamadas</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <ModeToggle mode={mode} onChange={setMode} disabled={dialingId !== null} />
          {leads && leads.length > 0 && (
            <button
              onClick={() => dial(leads[0].id)}
              disabled={dialingId !== null}
              style={{
                background: 'var(--accent)',
                color: 'white',
                border: 'none',
                borderRadius: 8,
                padding: '0.6rem 1.1rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {dialingId ? 'Marcando…' : 'Llamar al siguiente'}
            </button>
          )}
        </div>
      </header>

      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      {!leads && !error && <p style={{ color: 'var(--text-dim)' }}>Cargando cola…</p>}
      {leads?.length === 0 && <p style={{ color: 'var(--text-dim)' }}>No hay leads marcables ahora mismo.</p>}

      <ul style={{ listStyle: 'none', padding: 0, marginTop: '1.5rem' }}>
        {leads?.map(lead => (
          <li
            key={lead.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: '0.85rem 1.1rem',
              marginBottom: '0.6rem',
            }}
          >
            <div>
              <div style={{ fontWeight: 600 }}>{lead.displayName}</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>
                {lead.phone ?? 'sin teléfono'} · {lead.callAttempts} intentos
                {lead.nextAttempt && ` · desde ${new Date(lead.nextAttempt).toLocaleString('es-ES')}`}
              </div>
            </div>
            <button
              onClick={() => dial(lead.id)}
              disabled={dialingId !== null}
              style={{
                background: 'transparent',
                color: 'var(--accent)',
                border: '1px solid var(--accent)',
                borderRadius: 8,
                padding: '0.4rem 0.9rem',
                cursor: 'pointer',
              }}
            >
              {dialingId === lead.id ? 'Marcando…' : 'Llamar'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// Toggle secundario: shadow es el modo de trabajo real (el operador habla), voice
// deja que el agente lleve la llamada sola con TTS — solo para probar y
// comparar humano vs IA, no es la forma normal de marcar. Aplica al
// siguiente "Llamar"/"Llamar al siguiente" que se pulse, no a llamadas ya
// en curso.
function ModeToggle({
  mode,
  onChange,
  disabled,
}: {
  mode: CallMode
  onChange: (mode: CallMode) => void
  disabled: boolean
}) {
  const options: { value: CallMode; label: string }[] = [
    { value: 'shadow', label: 'Copiloto (tú hablas)' },
    { value: 'voice', label: 'IA sola (test)' },
  ]
  return (
    <div
      style={{
        display: 'flex',
        border: '1px solid var(--border)',
        borderRadius: 8,
        overflow: 'hidden',
        fontSize: '0.8rem',
      }}
    >
      {options.map(opt => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          disabled={disabled}
          title={opt.value === 'voice' ? 'El agente lleva la llamada sola con voz sintética, para comparar contra el modo copiloto' : undefined}
          style={{
            background: mode === opt.value ? 'var(--accent)' : 'transparent',
            color: mode === opt.value ? 'white' : 'var(--text-dim)',
            border: 'none',
            padding: '0.45rem 0.75rem',
            fontWeight: 600,
            cursor: disabled ? 'default' : 'pointer',
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
