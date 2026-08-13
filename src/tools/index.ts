import type { CrmAdapter } from '../crm/adapter.js'
import type { Tool } from '../mcp/types.js'
import { markBadContactTool } from './mark-bad-contact.js'
import { scheduleCallbackTool } from './schedule-callback.js'
import { endCallTool } from './end-call.js'

export function getAllTools(adapter: CrmAdapter): Tool[] {
  return [
    markBadContactTool(adapter),
    scheduleCallbackTool(adapter),
    endCallTool(adapter),
  ]
}
