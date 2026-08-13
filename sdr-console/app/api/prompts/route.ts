import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '../../../lib/supabase-server'

export async function GET() {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('prompt_versions')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ versions: data })
}

// Crea una versión nueva, siempre inactiva — activarla es un paso aparte
// (POST /api/prompts/[id]/activate) para no pisar la que está en producción
// sin querer al guardar un borrador.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}))
  const businessName = typeof body.businessName === 'string' ? body.businessName : undefined
  const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt : undefined
  const keyterms = Array.isArray(body.keyterms) ? body.keyterms.filter((k: unknown) => typeof k === 'string') : []

  if (!businessName || !systemPrompt) {
    return NextResponse.json({ error: 'Faltan businessName o systemPrompt' }, { status: 400 })
  }

  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('prompt_versions')
    .insert({ business_name: businessName, system_prompt: systemPrompt, keyterms, is_active: false })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ version: data })
}
