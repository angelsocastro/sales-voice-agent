import type { CrmAdapter } from '../crm/adapter.js'
import type { Tool, ToolResult } from '../mcp/types.js'
import { parseSpanishTime } from '../utils/time-parser.js'
import { format } from 'date-fns'
import { toZonedTime } from 'date-fns-tz'

const TZ = 'Europe/Madrid'

export function scheduleCallbackTool(adapter: CrmAdapter): Tool {
  return {
    name: 'schedule_callback',
    description: 'Agenda una llamada de seguimiento. Usa cuando el lead dice cuándo llamar o no está disponible ahora.',
    inputSchema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', description: 'ID del lead en el CRM. Siempre pasar {{lead_id}}.' },
        texto_hora: { type: 'string', description: 'Cuándo llamar, en texto español. Ej: "mañana a las 10", "el martes por la tarde".' },
        nombre: { type: 'string', description: 'Nombre de la persona con quien hablar (opcional).' },
      },
      required: ['lead_id', 'texto_hora'],
    },
    async handler(args, _context): Promise<ToolResult> {
      const { lead_id, texto_hora, nombre } = args as { lead_id: string; texto_hora: string; nombre?: string }

      const callAt = parseSpanishTime(texto_hora)
      if (!callAt) {
        return {
          content: [{ type: 'text', text: `No se pudo interpretar la hora: "${texto_hora}"` }],
          isError: true,
        }
      }

      const zoned = toZonedTime(callAt, TZ)
      const dueDate = format(zoned, 'yyyy-MM-dd')
      const dueTime = format(zoned, 'HH:mm:ss')
      const taskText = nombre
        ? `Llamar a ${nombre} — reagendado: ${texto_hora}`
        : `Llamar — reagendado: ${texto_hora}`

      try {
        await Promise.all([
          adapter.createTask({
            lead_id,
            text: taskText,
            due_date: dueDate,
            due_time: dueTime,
            is_complete: false,
            type: 'lead',
          }),
          adapter.updateLead(lead_id, {
            statusLabel: 'Called',
            custom: { next_attempt: callAt.toISOString() },
          }),
        ])
        return { content: [{ type: 'text', text: `Callback agendado para ${dueDate} ${dueTime} (Madrid).` }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${String(err)}` }], isError: true }
      }
    },
  }
}
