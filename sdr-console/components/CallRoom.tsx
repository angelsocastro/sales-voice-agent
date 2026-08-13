'use client'

import { useEffect, useState } from 'react'
import { LiveKitRoom, RoomAudioRenderer, TrackToggle, useRoomContext } from '@livekit/components-react'
import { Track } from 'livekit-client'
import { SuggestionsPanel } from './SuggestionsPanel'

interface ConnectionDetails {
  serverUrl: string
  token: string
}

type CallMode = 'shadow' | 'voice'

// Softphone: el operador entra por micrófono de navegador (WebRTC) a la
// MISMA sala que scripts/call-assisted.ts ya creó y en la que ya está el
// lead por SIP. En modo shadow el agente nunca publica audio, solo sugiere
// por texto (ver SuggestionsPanel); en modo voice (toggle de prueba para
// comparar humano vs IA, ver app/page.tsx) es el agente quien habla con TTS,
// así que el mic del operador no se autopublica al conectar — solo
// observa/escucha salvo que decida intervenir a mano con TrackToggle.
// roomName viene de la URL, nunca se genera aquí.
export function CallRoom({
  roomName,
  leadName,
  mode = 'shadow',
}: {
  roomName: string
  leadName?: string
  mode?: CallMode
}) {
  const [details, setDetails] = useState<ConnectionDetails | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/connection-details?room=${encodeURIComponent(roomName)}`)
      .then(res => {
        if (!res.ok) throw new Error(`connection-details respondió ${res.status}`)
        return res.json()
      })
      .then((data: { serverUrl: string; token: string }) => {
        if (!cancelled) setDetails(data)
      })
      .catch(err => {
        if (!cancelled) setError(String(err))
      })
    return () => {
      cancelled = true
    }
  }, [roomName])

  if (error) {
    return (
      <div style={{ padding: '2rem', color: 'var(--danger)' }}>
        No se pudo conectar a {roomName}: {error}
      </div>
    )
  }
  if (!details) {
    return <div style={{ padding: '2rem', color: 'var(--text-dim)' }}>Conectando…</div>
  }

  return (
    <LiveKitRoom
      serverUrl={details.serverUrl}
      token={details.token}
      connect
      audio={mode === 'shadow'}
      video={false}
    >
      <RoomAudioRenderer />
      <CallLayout roomName={roomName} leadName={leadName} mode={mode} />
    </LiveKitRoom>
  )
}

function CallLayout({ roomName, leadName, mode }: { roomName: string; leadName?: string; mode: CallMode }) {
  const room = useRoomContext()
  const [hangingUp, setHangingUp] = useState(false)

  // El botón hace las dos cosas: pide al servidor que borre la sala (corta
  // de verdad la pata SIP del lead — ver /api/hangup) y solo entonces se
  // desconecta el navegador. Desconectarse sin más dejaría al lead a solas
  // en la sala con un agente mudo.
  const hangUp = async () => {
    setHangingUp(true)
    try {
      await fetch('/api/hangup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: roomName }),
      })
    } finally {
      room.disconnect()
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <header
        style={{
          padding: '1rem 1.5rem',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
            En llamada con · {mode === 'voice' ? 'IA sola (test)' : 'Copiloto'}
          </div>
          <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>{leadName ?? roomName}</div>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <TrackToggle source={Track.Source.Microphone} />
          <button
            onClick={hangUp}
            disabled={hangingUp}
            style={{
              background: 'var(--danger)',
              color: 'white',
              border: 'none',
              borderRadius: 8,
              padding: '0.5rem 1rem',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            {hangingUp ? 'Colgando…' : 'Colgar'}
          </button>
        </div>
      </header>
      {mode === 'shadow' ? (
        <SuggestionsPanel />
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)' }}>
          Modo IA — el agente lleva la llamada sola. Sin sugerencias que leer, solo audio.
        </div>
      )}
    </div>
  )
}
