import { createClient } from '@supabase/supabase-js'
import { DEFAULT_PROMPT_CONFIG, type PromptConfig } from './agent.js'

// Sin SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY configuradas, el agente corre
// con el template de ejemplo (ver DEFAULT_PROMPT_CONFIG en agent.ts) — así
// el repo funciona out of the box sin depender de ninguna cuenta externa.
const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : undefined

// Cache en memoria del proceso worker con TTL corto: se refresca sola sin
// necesitar redeploy cuando alguien edita el prompt activo desde la
// dashboard, pero sin pegarle a la DB en cada turno de cada llamada.
const CACHE_TTL_MS = 5 * 60 * 1000

let cached: PromptConfig | undefined
let cachedAt = 0

async function fetchActivePromptConfig(): Promise<PromptConfig | undefined> {
  if (!supabase) return undefined

  const { data, error } = await supabase
    .from('prompt_versions')
    .select('system_prompt, keyterms')
    .eq('is_active', true)
    .maybeSingle()

  if (error) {
    console.error('prompt-config: fallo leyendo prompt activo de Supabase, uso el cacheado/default', error)
    return undefined
  }
  if (!data) return undefined

  return { template: data.system_prompt, keyterms: data.keyterms ?? [] }
}

/**
 * Carga el prompt activo. Se llama en el prewarm del worker (ver main.ts)
 * para no meter una llamada de red en el camino crítico del primer turno de
 * la primera llamada real.
 */
export async function loadPromptConfig(): Promise<PromptConfig> {
  const fresh = await fetchActivePromptConfig()
  if (fresh) {
    cached = fresh
    cachedAt = Date.now()
  }
  return cached ?? DEFAULT_PROMPT_CONFIG
}

/**
 * Config para usar en el arranque de un job: sirve la cacheada si sigue
 * dentro del TTL, si no relanza la carga (y mientras tanto sirve lo que haya
 * en caché, o el default si el proceso acaba de arrancar).
 */
export async function getPromptConfig(): Promise<PromptConfig> {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached
  return loadPromptConfig()
}
