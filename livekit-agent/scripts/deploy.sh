#!/usr/bin/env bash
#
# Despliega el agente a LiveKit Cloud y espera a que el rollout quede sano.
#
# Es el MISMO camino en local (`npm run deploy`) y en CI (workflow
# deploy-agent.yml), a propósito: si el deploy automático falla, se reproduce
# exactamente igual desde tu máquina.
#
# Autenticación: `lk agent deploy` habla con la API de Cloud Agents usando las
# credenciales del proyecto (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET).
# El build lo hace LiveKit Cloud a partir del Dockerfile — aquí no se construye
# ninguna imagen, solo se sube el directorio.
#
# Los secretos salen de Doppler, igual que en otro proyecto propio:
#   local  →  doppler run -- npm run deploy
#   CI     →  doppler run --token "$DOPPLER_TOKEN" -- npm run deploy:only
# El script no sabe nada de Doppler: solo lee del entorno. Así funciona igual
# con un `.env` a mano si algún día hace falta.
#
# Variables:
#   LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET  (obligatorias)
#   LK_CONFIG            opcional — fichero de config del agente.
#                        `livekit.toml` (prod) por defecto, `livekit.dev.toml` en dev
#   LK_AGENT_ID          opcional — por defecto, el `agent.id` de $LK_CONFIG
#   ROLLOUT_TIMEOUT_S    opcional — por defecto 600s de espera al rollout
#   ROLLOUT_POLL_S       opcional — por defecto 10s entre comprobaciones
set -euo pipefail

# Secretos que necesita el agente EN EJECUCIÓN, y que se suben a LiveKit en cada
# deploy. Es una lista explícita, no un prefijo ni "todo lo que haya en el
# entorno": con `doppler run` el proceso ve el config entero, y a LiveKit solo
# debe llegar lo que el agente usa de verdad.
#
# LIVEKIT_URL/API_KEY/API_SECRET NO van aquí a propósito: LiveKit Cloud los
# inyecta él mismo en el contenedor y no se pueden definir como secretos del
# agente.
# LIVEKIT_AGENT_NAME sí va: es lo que distingue al agente de dev del de
# producción a la hora de recibir llamadas (ver comentario en src/main.ts).
AGENT_SECRET_VARS=(TELNYX_API_KEY ATTIO_API_KEY CARTESIA_ES_VOICE_ID LIVEKIT_AGENT_NAME)

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$AGENT_DIR"

LK_CONFIG="${LK_CONFIG:-livekit.toml}"
ROLLOUT_TIMEOUT_S="${ROLLOUT_TIMEOUT_S:-600}"
ROLLOUT_POLL_S="${ROLLOUT_POLL_S:-10}"

fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

command -v lk >/dev/null || fail "El CLI 'lk' no está instalado. https://docs.livekit.io/home/cli/cli-setup/"

[ -f "$LK_CONFIG" ] || fail "No existe $LK_CONFIG en $AGENT_DIR. Ese fichero lo genera 'lk agent create' (una vez, en local, con credenciales reales) y va commiteado."

for var in LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET; do
  [ -n "${!var:-}" ] || fail "Falta $var. Sale de Doppler: 'doppler run -- npm run deploy'."
done

# El id del agente manda desde el fichero de config (CA_...): así el deploy
# siempre va al agente que este repo declara, y no al proyecto por defecto del
# CLI. Es también lo que separa dev de producción.
AGENT_ID="${LK_AGENT_ID:-$(sed -n 's/^[[:space:]]*id[[:space:]]*=[[:space:]]*"\(.*\)"/\1/p' "$LK_CONFIG" | head -1)}"
[ -n "$AGENT_ID" ] || fail "No se pudo leer agent.id de $LK_CONFIG (ni LK_AGENT_ID)."

echo "▸ Config:   $LK_CONFIG"
echo "▸ Agente:   $AGENT_ID"
echo "▸ Proyecto: $LIVEKIT_URL"
echo "▸ Se registrará como: ${LIVEKIT_AGENT_NAME:-outbound-agent}"

# Versión actual, para poder distinguir "rollout terminado" de "sigue sirviendo
# la de antes". Si falla (agente nuevo, permisos), se sigue sin ella.
PREVIOUS_VERSION="$(lk agent status --id "$AGENT_ID" --config "$LK_CONFIG" --json 2>/dev/null \
  | node scripts/rollout-status.mjs --print-version || true)"
[ -n "$PREVIOUS_VERSION" ] && echo "▸ Versión actual: $PREVIOUS_VERSION"

# Fichero efímero de secretos para LiveKit: nunca se commitea, se borra pase lo
# que pase (incluido si el deploy revienta a medias).
SECRETS_FILE=""
cleanup() { [ -n "$SECRETS_FILE" ] && rm -f "$SECRETS_FILE"; return 0; }
trap cleanup EXIT

DEPLOY_ARGS=()
PRESENT=()
for var in "${AGENT_SECRET_VARS[@]}"; do
  [ -n "${!var:-}" ] && PRESENT+=("$var")
done

if [ ${#PRESENT[@]} -gt 0 ]; then
  SECRETS_FILE="$(mktemp)"
  chmod 600 "$SECRETS_FILE"
  for var in "${PRESENT[@]}"; do
    printf '%s=%s\n' "$var" "${!var}" >> "$SECRETS_FILE"
  done
  DEPLOY_ARGS+=(--secrets-file "$SECRETS_FILE")
  echo "▸ Secretos del agente: ${PRESENT[*]}"
else
  echo "▸ Sin secretos en el entorno — se despliega solo código y se dejan los que ya tenga el agente."
  echo "  (¿Olvidaste 'doppler run --'? El agente no arrancará si nunca se le han subido.)"
fi

echo
echo "▸ Desplegando…"
# Sin --id: `lk agent deploy` no acepta ese flag, resuelve el agente desde el
# livekit.toml del directorio de trabajo (por eso el cd de arriba importa).
# La expansión rara es para bash 3.2 (el de macOS): con `set -u`, expandir un
# array vacío como "${arr[@]}" aborta el script.
lk agent deploy . --config "$LK_CONFIG" ${DEPLOY_ARGS[@]+"${DEPLOY_ARGS[@]}"} \
  || fail "El deploy falló (ver el log del build arriba)."

echo
echo "▸ Esperando al rollout (máx ${ROLLOUT_TIMEOUT_S}s)…"
DEADLINE=$(( $(date +%s) + ROLLOUT_TIMEOUT_S ))
LAST_JSON=""

while :; do
  LAST_JSON="$(lk agent status --id "$AGENT_ID" --config "$LK_CONFIG" --json 2>/dev/null || true)"

  set +e
  VERDICT="$(printf '%s' "$LAST_JSON" | EXPECT_NOT_VERSION="$PREVIOUS_VERSION" node scripts/rollout-status.mjs)"
  CODE=$?
  set -e

  echo "  $VERDICT"

  case "$CODE" in
    0) echo; echo "✓ Agente desplegado y sirviendo."; exit 0 ;;
    2)
      echo
      printf '%s\n' "$LAST_JSON" >&2
      fail "El rollout ha fallado. Revisa 'lk agent logs --id $AGENT_ID --log-type deploy' y considera 'lk agent rollback --id $AGENT_ID --version $PREVIOUS_VERSION'."
      ;;
  esac

  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo
    printf '%s\n' "$LAST_JSON" >&2
    fail "Timeout esperando el rollout. La versión desplegada NO se ha confirmado como sana: comprueba el estado antes de dar por buena la llamada de producción."
  fi

  sleep "$ROLLOUT_POLL_S"
done
