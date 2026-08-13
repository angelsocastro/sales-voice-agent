/**
 * El veredicto del rollout decide si un deploy se da por bueno, así que se
 * testea igual que el código del agente. Lo que se protege aquí es la regla de
 * oro del script: **ante un estado que no reconocemos, no se da por sano**.
 */

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../scripts/rollout-status.mjs', import.meta.url))

function verdict(
  payload: unknown,
  env: Record<string, string> = {},
  args: string[] = [],
): { code: number; out: string } {
  try {
    const out = execFileSync('node', [SCRIPT, ...args], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      env: { ...process.env, ...env },
      encoding: 'utf8',
    })
    return { code: 0, out }
  } catch (err) {
    const e = err as { status: number; stdout: string }
    return { code: e.status, out: e.stdout }
  }
}

const running = (over: Record<string, unknown> = {}) => ({
  agents: [
    {
      agentId: 'CA_test',
      agentDeployments: [
        { region: 'eu-central', status: 'running', version: '42', replicas: 1, ...over },
      ],
    },
  ],
})

describe('rollout-status', () => {
  it('da OK con todas las réplicas corriendo', () => {
    expect(verdict(running()).code).toBe(0)
  })

  it('reconoce estados en formato enum del proto', () => {
    expect(verdict(running({ status: 'AGENT_STATUS_RUNNING' })).code).toBe(0)
  })

  it('falla rápido ante un estado de error', () => {
    const r = verdict(running({ status: 'CrashLoopBackOff' }))
    expect(r.code).toBe(2)
    expect(r.out).toContain('FALLO')
  })

  it('sigue esperando si no hay réplicas todavía', () => {
    expect(verdict(running({ replicas: 0 })).code).toBe(3)
  })

  it('sigue esperando si aún sirve la versión anterior', () => {
    expect(verdict(running(), { EXPECT_NOT_VERSION: '42' }).code).toBe(3)
    expect(verdict(running({ version: '43' }), { EXPECT_NOT_VERSION: '42' }).code).toBe(0)
  })

  it('no da por sano un estado desconocido', () => {
    expect(verdict(running({ status: 'Provisioning' })).code).toBe(3)
  })

  it('no da por sano un JSON vacío o ilegible', () => {
    expect(verdict({ agents: [] }).code).toBe(3)
    expect(verdict('no soy json').code).toBe(3)
  })

  it('exige que TODAS las regiones estén sanas, no solo una', () => {
    const mixed = {
      agents: [
        {
          agentDeployments: [
            { region: 'eu-central', status: 'running', version: '43', replicas: 1 },
            { region: 'us-east', status: 'deploying', version: '43', replicas: 0 },
          ],
        },
      ],
    }
    expect(verdict(mixed).code).toBe(3)
  })

  it('--print-version imprime la versión en curso sin evaluar nada', () => {
    expect(verdict(running(), {}, ['--print-version']).out.trim()).toBe('42')
    expect(verdict('roto', {}, ['--print-version']).code).toBe(0)
  })
})
