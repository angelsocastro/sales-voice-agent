-- El agente carga el system prompt real desde aquí en vez de tenerlo
-- hardcodeado en el código (ver livekit-agent/src/prompt-config.ts). Permite
-- editar/versionar el guion de negocio sin tocar el repo ni redesplegar.

create table if not exists prompt_versions (
  id uuid primary key default gen_random_uuid(),
  business_name text not null,
  system_prompt text not null,
  keyterms text[] not null default '{}',
  is_active boolean not null default false,
  created_at timestamptz not null default now()
);

-- Como mucho una fila activa a la vez: el agente hace
-- .eq('is_active', true).maybeSingle() y rompe si hay más de una.
create unique index if not exists prompt_versions_one_active
  on prompt_versions (is_active)
  where is_active;
