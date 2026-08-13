// Solo servidor — service role key, nunca exponer al cliente. Misma DB que
// lee livekit-agent/src/prompt-config.ts para cargar el prompt activo.
import { createClient } from '@supabase/supabase-js'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Falta ${name} en el entorno de sdr-console`)
  return value
}

export function getSupabaseAdmin() {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'))
}

export interface PromptVersion {
  id: string
  business_name: string
  system_prompt: string
  keyterms: string[]
  is_active: boolean
  created_at: string
}
