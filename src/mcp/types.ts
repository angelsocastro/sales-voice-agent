export interface ToolContext {
  telnyx_conversation_id?: string
  [key: string]: unknown
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export interface ToolSchema {
  type: 'object'
  properties: Record<string, {
    type: string
    description: string
    enum?: string[]
  }>
  required: string[]
}

export interface Tool {
  name: string
  description: string
  inputSchema: ToolSchema
  handler(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>
}
