import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '../../../../../lib/supabase-server'

// Dos updates en vez de una transacción: el índice único parcial
// (prompt_versions_one_active, ver supabase/migrations) solo permite una fila
// activa, así que primero hay que soltarla. Hay una ventana breve sin ninguna
// activa entre ambos updates — aceptable aquí (herramienta de un solo
// usuario, y livekit-agent sirve el último valor cacheado mientras tanto,
// ver prompt-config.ts) — no lo asumas seguro en una herramienta multiusuario.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = getSupabaseAdmin()

  const deactivate = await supabase.from('prompt_versions').update({ is_active: false }).eq('is_active', true)
  if (deactivate.error) return NextResponse.json({ error: deactivate.error.message }, { status: 500 })

  const activate = await supabase.from('prompt_versions').update({ is_active: true }).eq('id', id).select().single()
  if (activate.error) return NextResponse.json({ error: activate.error.message }, { status: 500 })

  return NextResponse.json({ version: activate.data })
}
