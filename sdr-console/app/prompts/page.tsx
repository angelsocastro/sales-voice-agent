'use client'

import { useEffect, useState } from 'react'

interface PromptVersion {
  id: string
  business_name: string
  system_prompt: string
  keyterms: string[]
  is_active: boolean
  created_at: string
}

// CRUD mínimo: guardar siempre crea una versión nueva (inactiva), activar es
// un paso aparte — así nunca se pisa el prompt en producción sin querer al
// editar un borrador. livekit-agent recoge la versión activa con hasta 5min
// de retraso (cache en memoria, ver livekit-agent/src/prompt-config.ts).
export default function PromptsPage() {
  const [versions, setVersions] = useState<PromptVersion[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [businessName, setBusinessName] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [keytermsInput, setKeytermsInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [activatingId, setActivatingId] = useState<string | null>(null)

  const load = () => {
    fetch('/api/prompts')
      .then(res => res.json())
      .then(data => {
        if (data.error) throw new Error(data.error)
        setVersions(data.versions)
      })
      .catch(err => setError(String(err)))
  }

  useEffect(load, [])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const keyterms = keytermsInput
        .split(',')
        .map(k => k.trim())
        .filter(Boolean)
      const res = await fetch('/api/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessName, systemPrompt, keyterms }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'No se pudo guardar')
      setSystemPrompt('')
      setKeytermsInput('')
      load()
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  const activate = async (id: string) => {
    setActivatingId(id)
    setError(null)
    try {
      const res = await fetch(`/api/prompts/${id}/activate`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'No se pudo activar')
      load()
    } catch (err) {
      setError(String(err))
    } finally {
      setActivatingId(null)
    }
  }

  return (
    <div style={{ padding: '2rem', maxWidth: 780, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.25rem', marginBottom: '1.5rem' }}>Prompts</h1>

      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      <div
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: '1.1rem',
          marginBottom: '2rem',
        }}
      >
        <h2 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>Nueva versión</h2>
        <input
          placeholder="Nombre del negocio"
          value={businessName}
          onChange={e => setBusinessName(e.target.value)}
          style={{ width: '100%', marginBottom: '0.6rem', padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border)' }}
        />
        <textarea
          placeholder="System prompt completo"
          value={systemPrompt}
          onChange={e => setSystemPrompt(e.target.value)}
          rows={12}
          style={{
            width: '100%',
            marginBottom: '0.6rem',
            padding: '0.5rem',
            borderRadius: 6,
            border: '1px solid var(--border)',
            fontFamily: 'monospace',
            fontSize: '0.85rem',
          }}
        />
        <input
          placeholder="Keyterms para el STT, separados por coma"
          value={keytermsInput}
          onChange={e => setKeytermsInput(e.target.value)}
          style={{ width: '100%', marginBottom: '0.75rem', padding: '0.5rem', borderRadius: 6, border: '1px solid var(--border)' }}
        />
        <button
          onClick={save}
          disabled={saving || !businessName || !systemPrompt}
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
          {saving ? 'Guardando…' : 'Guardar como borrador'}
        </button>
      </div>

      {!versions && !error && <p style={{ color: 'var(--text-dim)' }}>Cargando…</p>}

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {versions?.map(v => (
          <li
            key={v.id}
            style={{
              background: 'var(--panel)',
              border: v.is_active ? '2px solid var(--live)' : '1px solid var(--border)',
              borderRadius: 10,
              padding: '0.85rem 1.1rem',
              marginBottom: '0.6rem',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 600 }}>
                  {v.business_name} {v.is_active && <span style={{ color: 'var(--live)' }}>· activo</span>}
                </div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>
                  {new Date(v.created_at).toLocaleString('es-ES')} · {v.system_prompt.length} caracteres
                </div>
              </div>
              {!v.is_active && (
                <button
                  onClick={() => activate(v.id)}
                  disabled={activatingId !== null}
                  style={{
                    background: 'transparent',
                    color: 'var(--accent)',
                    border: '1px solid var(--accent)',
                    borderRadius: 8,
                    padding: '0.4rem 0.9rem',
                    cursor: 'pointer',
                  }}
                >
                  {activatingId === v.id ? 'Activando…' : 'Activar'}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
