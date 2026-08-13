# sales-voice-agent

Agente de voz outbound para cold calling en español, con un modo de
**copiloto humano-IA**: un operador habla la llamada, el agente escucha en
paralelo y le sugiere qué decir por texto — la misma categoría de feature
que Aircall vende como "AI Assist Pro" (~$49/mes por agente). También puede
correr la llamada entera solo, con TTS, sin humano en el loop.

Stack: [LiveKit](https://livekit.io) (WebRTC + orquestación del agente),
Telnyx (SIP trunk saliente/entrante), Attio (CRM), Supabase (config del
guion de negocio).

## Arquitectura

Tres procesos independientes, cada uno con su propio deploy:

```
src/              → servidor central (Hono). Dialer + webhooks + estado
                    de llamadas entrantes.
livekit-agent/    → el agente de voz en sí. Deploy propio a LiveKit Cloud.
sdr-console/      → dashboard del operador (Next.js). Cola de leads,
                    pantalla de llamada en vivo, editor del guion.
```

**`src/`** — corre siempre encendido (no serverless): dispara llamadas
salientes respetando horario/ventanas y límite de reintentos
(`src/dialer/dial-script.ts`), recibe el webhook de insights post-llamada
de Telnyx y lo reconcilia contra Attio (`src/insights/`), y recibe el
webhook de llamadas entrantes de LiveKit — guarda la llamada pendiente en
memoria hasta que `sdr-console` la reclama (`src/webhooks/`). Ese estado
en memoria es la razón de que este proceso no pueda ser serverless: el
"claim" de una llamada entrante tiene que ser atómico entre quien la
recibe y quien la atiende.

**`livekit-agent/`** — el agente de voz. Dos modos:
- **shadow** (default): el operador humano habla, el agente solo escucha
  y sugiere texto — esto es el copiloto.
- **voice**: el agente lleva la llamada entera solo, con TTS. Pensado para
  comparar humano vs IA a propósito, no el camino normal.

El guion de negocio (system prompt + palabras clave) no está hardcodeado:
se carga desde Supabase (`livekit-agent/src/prompt-config.ts`, tabla
`prompt_versions`) con cache de 5 min en memoria, así se edita desde
`sdr-console` sin tocar código ni redeploy. Sin credenciales de Supabase
configuradas, corre con un guion de ejemplo genérico — funciona out of
the box sin depender de ninguna cuenta externa.

**`sdr-console/`** — dashboard de un solo usuario (el operador), no un
producto multiusuario. Cola de leads llamables, pantalla de llamada en
vivo (conexión WebRTC directa vía `@livekit/components-react`, sin
frameworks de más), y CRUD de versiones del guion de negocio
(`/prompts`).

## Por qué copiloto y no agente autónomo puro

Cold calling B2B tiene una tasa de objeciones y matices que un agente
100% autónomo maneja peor que un humano con un apuntador en tiempo real.
El modo shadow es el punto medio: el humano cierra, el agente hace de
memoria y de investigador en vivo.

## Setup

Cada proceso tiene sus propias variables de entorno — no hay un `.env`
centralizado a propósito, porque los tres se deployan a lugares distintos
(ver comentarios en cada `package.json`/`deploy.sh`).

- **`src/`**: variables de Attio, Telnyx y LiveKit — ver `src/config.ts`
  para la lista completa y validación (`zod`).
- **`livekit-agent/`**: deploya a LiveKit Cloud vía `lk agent deploy`;
  secretos salen de Doppler (`npm run deploy` = `doppler run -- ...`).
  Ver `livekit-agent/scripts/deploy.sh`.
- **`sdr-console/`**: Next.js estándar, `.env.local`. Necesita
  `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` (mismo proyecto Supabase que
  `livekit-agent`) y `SDR_CONSOLE_PASSWORD` (basic auth — no hay login
  real, es para un solo operador).

Migration de Supabase: `supabase/migrations/0001_prompt_versions.sql`.

### Correr todo en local

```bash
npm install
npm run dev:all   # server + livekit-agent + sdr-console en paralelo
```
