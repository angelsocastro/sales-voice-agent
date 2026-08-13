# sdr-console

Dashboard del **Modelo B** (copiloto de voz humana): el operador habla, el
agente sugiere por texto. No es un producto — es la herramienta de un solo
usuario mientras está al teléfono.

Nace inspirado en [`agent-starter-react`](https://github.com/livekit-examples/agent-starter-react)
pero no es un fork suyo: esa plantilla trae un kit de componentes completo
(Rive, xyflow, shadcn/radix, Vercel AI SDK) pensado para una demo de
producción con avatar animado — más de 30 dependencias para un caso de uso
que no las necesita. Aquí solo se usa lo que de verdad hace falta:
`@livekit/components-react` para la conexión WebRTC (`LiveKitRoom`,
`RoomAudioRenderer`, `TrackToggle`) y `livekit-server-sdk` en las rutas de
servidor. Sin Tailwind, sin shadcn, sin registro externo que instalar — CSS
a mano en `app/globals.css`.

## Cómo funciona

1. `/` es la cola: lee los leads marcables de Attio (mismo filtro que
   `runDialer()`) y los pinta ordenados — nunca-llamados primero, luego el
   callback más vencido. "Llamar al siguiente" toma el primero sin elegir;
   cada fila también tiene su propio botón. Mismo patrón que un dialer de
   verdad (Salesloft/Outreach/Orum): la cola y el botón de llamar viven en
   la misma pantalla, nunca en una terminal aparte.
2. Al llamar, `/api/dial` marca al lead en modo `shadow` por defecto
   (el agente no habla, solo escucha y sugiere — mismo `triggerOutboundCall`
   que usa el resto del repo) y el navegador salta directo a `/call/[room]`.
   Hay un toggle secundario en la cola ("IA sola (test)") que cambia a modo
   `voice` — el agente lleva la llamada entera con TTS, sin que nadie hable
   por micrófono — pensado solo para comparar humano vs IA a propósito, no
   para el uso diario.
3. Ahí, el operador entra por micrófono de navegador (WebRTC) a la MISMA
   sala en la que ya está el lead por SIP — es el softphone, no un espectador.
4. El agente shadow manda cada sugerencia por un LiveKit text stream (topic
   `suggestions`); `SuggestionsPanel` la pinta, la última en grande.
5. "Colgar" llama a `/api/hangup` (que borra la sala del lado servidor,
   cortando también la pata SIP del lead) y solo entonces desconecta el
   navegador — nunca al revés.

El LLM nunca decide que la llamada termina (ver `opts.skipShutdown` en
`livekit-agent/src/agent.ts`): el corte real solo pasa por el botón de
colgar o por que el lead cuelgue su teléfono.

## Llamadas entrantes

Mismo modo shadow, sin Telnyx Call Control — el mecanismo ya se verificó
en producción en otro proyecto propio: un participante SIP entra a
la sala y publica audio en estado "ringing" **antes** de que la llamada se
conteste de verdad — LiveKit no manda el 200 OK al operador hasta que
**alguien se suscribe** a su audio. Así que "no contestar hasta que
responda alguien" no es código nuestro, es la consecuencia natural de que
nadie se haya suscrito todavía.

1. Llamada entra → trunk/dispatch rule de LiveKit (ver
   `scripts/ensure-inbound-trunk.ts`, sin `roomConfig.agents` — nada se
   despacha solo) → se crea la sala, nadie se suscribe todavía.
2. `src/server.ts` recibe el webhook (`src/webhooks/livekit-inbound.ts`),
   busca al que llama en Attio, y lo dejo pendiente en memoria. La página
   sondea `/api/incoming` cada 3s (sin aviso por push todavía — decisión
   explícita, ver conversación de diseño) y muestra un banner si hay algo.
3. "Contestar" reclama la llamada (atómico — solo el primer clic gana),
   dispatcha el agente shadow a la sala que YA existe, y te lleva a
   `/call/[room]` — mismo componente que outbound. En cuanto tu navegador
   se suscribe, se descuelga de verdad.
4. Si nadie contesta: el `ringingTimeout` de la dispatch rule cuelga la
   llamada sola. Cero código nuestro para ese caso.

No se toca la infraestructura ni la base de datos de ese otro proyecto —
solo se reutiliza el mecanismo (cómo funciona el trunk SIP de LiveKit). Ese
repo enruta llamadas de clientes a sus comerciales; esto enruta tus leads de
venta a ti. Modelos de datos y actores distintos, solo comparten el mismo
truco de LiveKit.

## Por qué cruza a `../src/` del repo raíz

`/api/queue` y `/api/dial` importan directo de `src/crm/attio.ts` y
`src/dialer/dial-script.ts` en vez de duplicar esa lógica (a diferencia de
`livekit-agent/src/crm-outcome.ts`, que sí duplica). La diferencia: este
paquete no tiene Dockerfile ni build context aislado — corre con el
monorepo entero presente en disco (`npm run dev`/`next start` desde un
checkout completo), así que no hay motivo real para tener dos copias del
cliente de Attio o de la lógica de marcado. Si algún día esto se despliega
con su propio Dockerfile, ese es el momento de o bien duplicar (mismo
patrón que livekit-agent) o extraer un paquete compartido — no antes.

## Desarrollo

Modelo B necesita tres procesos vivos a la vez: el server Hono de la raíz
(webhooks + estado de llamadas entrantes), el worker de `livekit-agent`
(el agente de voz) y este dashboard. Desde la raíz del repo, `npm run dev:all`
levanta los tres juntos, con logs prefijados por proceso.

```bash
cp .env.example .env.local  # rellenar con las mismas credenciales del repo raíz
npm install
npm run dev  # puerto 3100 — el 3000 lo usa el server Hono del repo raíz
```

## Deliberadamente fuera de esta v1

- Sin editar/descartar sugerencias, sin historial entre llamadas.
- Sin aviso de llamada entrante por push/SMS — hay que tener esta pestaña
  abierta para verla. Decisión explícita, se añade después.
