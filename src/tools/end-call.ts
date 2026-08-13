import type { CrmAdapter } from '../crm/adapter.js'
import type { Tool, ToolResult } from '../mcp/types.js'

type Resultado = 'interesado' | 'reagendado' | 'no_disponible' | 'contacto_malo' | 'no_icp' | 'handoff'

const RESULTADO_TO_STATUS: Record<Resultado, string> = {
  interesado: 'Interested',
  handoff: 'Interested',
  reagendado: 'Called',
  no_disponible: 'Called',
  contacto_malo: 'Bad Fit',
  no_icp: 'Not Interested',
}

export function endCallTool(adapter: CrmAdapter): Tool {
  return {
    name: 'end_call',
    description: 'Finaliza la llamada. Registra el resultado, actualiza status en el CRM y guarda transcripción como nota.',
    inputSchema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', description: 'ID del lead en el CRM. Siempre pasar {{lead_id}}.' },
        resultado: {
          type: 'string',
          description: 'Resultado de la llamada.',
          enum: ['interesado', 'reagendado', 'no_disponible', 'contacto_malo', 'no_icp', 'handoff'],
        },
        transcript: { type: 'string', description: 'Resumen o transcripción de la conversación.' },
      },
      required: ['lead_id', 'resultado', 'transcript'],
    },
    async handler(args, _context): Promise<ToolResult> {
      const { lead_id, resultado, transcript } = args as {
        lead_id: string
        resultado: Resultado
        transcript: string
      }

      const statusLabel = RESULTADO_TO_STATUS[resultado]
      const note = `Resultado: ${resultado}\n\nTranscripción:\n${transcript}`

      try {
        const lead = await adapter.getLeadById(lead_id)
        const currentAttempts = typeof lead.custom?.call_attempts === 'number' ? lead.custom.call_attempts : 0
        const call_attempts = currentAttempts + 1

        await Promise.all([
          adapter.updateLead(lead_id, {
            statusLabel,
            custom: {
              call_attempts,
              ...(resultado === 'handoff' ? { managed_by: 'closer' } : {}),
            },
          }),
          adapter.createNote(lead_id, note),
        ])
        return { content: [{ type: 'text', text: `Llamada finalizada. Resultado: ${resultado}. Status → ${statusLabel}.` }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${String(err)}` }], isError: true }
      }
    },
  }
}
