#!/usr/bin/env node
/**
 * Lee por stdin la salida de `lk agent status --json` y decide si el rollout
 * está sano, ha fallado, o sigue en marcha.
 *
 * Códigos de salida (los usa deploy.sh para decidir si seguir esperando):
 *   0 — sano: todas las réplicas corriendo, y con la versión nueva si se pide
 *   2 — fallo explícito: algún estado de error/crash → no tiene sentido esperar
 *   3 — todavía desplegando, o estado desconocido → volver a intentar
 *
 * Con `--print-version` no evalúa nada: solo imprime la versión que está
 * corriendo ahora (cadena vacía si no se puede leer). deploy.sh lo usa antes de
 * desplegar para saber de qué versión venimos.
 *
 * Por qué el parseo es tolerante: el JSON viene de un proto serializado por el
 * CLI, así que los nombres de campo pueden llegar en camelCase o snake_case y
 * los estados pueden ser strings sueltos ("running") o enums con prefijo
 * ("AGENT_STATUS_RUNNING") según la versión del CLI. En vez de acoplarnos a un
 * formato concreto, se recogen todos los objetos que tengan un `status` de
 * texto y se clasifican por patrón. Si aparece un estado que no reconocemos,
 * NO se da por bueno: se sigue esperando y, si no cambia, el deploy acaba
 * fallando con el JSON crudo delante. Preferimos un falso rojo a dar por
 * desplegada una versión que no lo está.
 */

const HEALTHY = /(running|healthy|ready|active|available)/i
const FAILED = /(fail|error|crash|unhealthy|backoff|evict|terminated)/i

const expectNotVersion = process.env.EXPECT_NOT_VERSION ?? ''

function collectRows(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectRows(item, out)
    return out
  }
  if (node && typeof node === 'object') {
    if (typeof node.status === 'string') out.push(node)
    for (const value of Object.values(node)) collectRows(value, out)
  }
  return out
}

function versionOf(row) {
  return String(row.version ?? row.Version ?? '')
}

function replicasOf(row) {
  const raw = row.replicas ?? row.Replicas
  return typeof raw === 'number' ? raw : Number(raw ?? 0)
}

const input = await new Promise(resolve => {
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => (buf += chunk))
  process.stdin.on('end', () => resolve(buf))
})

const printVersionOnly = process.argv.includes('--print-version')

let parsed
try {
  parsed = JSON.parse(input)
} catch {
  if (printVersionOnly) {
    console.log('')
    process.exit(0)
  }
  console.log('estado: respuesta no parseable como JSON')
  process.exit(3)
}

const rows = collectRows(parsed)

if (printVersionOnly) {
  console.log(rows.map(versionOf).find(Boolean) ?? '')
  process.exit(0)
}

if (rows.length === 0) {
  console.log('estado: sin deployments en la respuesta')
  process.exit(3)
}

const summary = rows
  .map(r => `${r.region ?? r.Region ?? '?'}=${r.status} v${versionOf(r) || '?'} (${replicasOf(r)} réplicas)`)
  .join(', ')

if (rows.some(r => FAILED.test(r.status))) {
  console.log(`estado: FALLO — ${summary}`)
  process.exit(2)
}

const allHealthy = rows.every(r => HEALTHY.test(r.status) && replicasOf(r) >= 1)
if (!allHealthy) {
  console.log(`estado: desplegando — ${summary}`)
  process.exit(3)
}

// Sano, pero puede seguir sirviendo la versión anterior mientras rota: hasta
// que la versión cambie, el deploy no está realmente aplicado.
if (expectNotVersion && rows.some(r => versionOf(r) === expectNotVersion)) {
  console.log(`estado: aún en la versión anterior (${expectNotVersion}) — ${summary}`)
  process.exit(3)
}

console.log(`estado: OK — ${summary}`)
process.exit(0)
