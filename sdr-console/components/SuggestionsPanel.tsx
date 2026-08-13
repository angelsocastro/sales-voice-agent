'use client'

import { useEffect, useRef, useState } from 'react'
import { useRoomContext } from '@livekit/components-react'

interface Suggestion {
  id: string
  text: string
}

// Único canal de esta pantalla: se suscribe al topic 'suggestions' que
// emite el agente shadow (ver suggestionTtsNode en
// livekit-agent/src/agent.ts) en vez de hablar por TTS. No hay audio propio
// del agente que renderizar aquí — quien habla de verdad es el operador.
export function SuggestionsPanel() {
  const room = useRoomContext()
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Tipo inferido del propio método en vez de importar TextStreamReader a
    // mano — así no hay que acertar el nombre/ruta exacta del tipo exportado.
    const handler: Parameters<typeof room.registerTextStreamHandler>[1] = async reader => {
      const text = await reader.readAll()
      if (!text.trim()) return
      setSuggestions(prev => [...prev, { id: `${Date.now()}-${Math.random()}`, text }])
    }
    room.registerTextStreamHandler('suggestions', handler)
    return () => room.unregisterTextStreamHandler('suggestions')
  }, [room])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [suggestions])

  return (
    <div
      ref={listRef}
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '1.5rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.75rem',
      }}
    >
      {suggestions.length === 0 && (
        <div style={{ color: 'var(--text-dim)' }}>Esperando la primera sugerencia…</div>
      )}
      {suggestions.map((s, i) => {
        const isLast = i === suggestions.length - 1
        return (
          <div
            key={s.id}
            style={{
              background: 'var(--panel)',
              border: `1px solid ${isLast ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 12,
              padding: '1rem 1.25rem',
              fontSize: isLast ? '1.4rem' : '1rem',
              opacity: isLast ? 1 : 0.55,
              lineHeight: 1.4,
            }}
          >
            {s.text}
          </div>
        )
      })}
    </div>
  )
}
