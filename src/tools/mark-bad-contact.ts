import type { CrmAdapter } from '../crm/adapter.js'
import type { Tool, ToolResult } from '../mcp/types.js'

export function markBadContactTool(adapter: CrmAdapter): Tool {
  return {
    name: 'mark_bad_contact',
    description: 'Marca el lead como contacto malo (número erróneo o no existe). Actualiza el CRM a Bad Fit.',
    inputSchema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', description: 'ID del lead en el CRM. Siempre pasar {{lead_id}} del contexto.' },
        motivo: {
          type: 'string',
          description: 'Motivo del contacto malo.',
          enum: ['numero_erroneo', 'no_existe', 'empresa_cerrada', 'otro'],
        },
      },
      required: ['lead_id', 'motivo'],
    },
    async handler(args, _context): Promise<ToolResult> {
      const { lead_id, motivo } = args as { lead_id: string; motivo: string }
      try {
        await adapter.updateLead(lead_id, { statusLabel: 'Bad Fit' })
        await adapter.createNote(lead_id, `Contacto malo — motivo: ${motivo}`)
        return { content: [{ type: 'text', text: `Lead ${lead_id} marcado como Bad Fit (${motivo}).` }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${String(err)}` }], isError: true }
      }
    },
  }
}
