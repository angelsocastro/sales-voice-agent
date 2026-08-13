import type { Tool, ToolContext } from './types.js'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
  id?: string | number | null
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  result?: unknown
  error?: { code: number; message: string }
  id: string | number | null
}

export function createMcpHandler(tools: Tool[]) {
  const toolMap = new Map(tools.map(t => [t.name, t]))

  return async (request: JsonRpcRequest): Promise<JsonRpcResponse> => {
    const id = request.id ?? null

    if (request.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'bdr-mcp-server', version: '1.0.0' },
        },
        id,
      }
    }

    if (request.method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        result: {
          tools: tools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
        id,
      }
    }

    if (request.method === 'tools/call') {
      const params = request.params as {
        name: string
        arguments: Record<string, unknown>
        _meta?: ToolContext
      }
      const tool = toolMap.get(params.name)
      if (!tool) {
        return {
          jsonrpc: '2.0',
          error: { code: -32601, message: `Tool not found: ${params.name}` },
          id,
        }
      }
      try {
        const result = await tool.handler(params.arguments as Record<string, unknown>, (params as { _meta?: Record<string, unknown> })._meta ?? {})
        return { jsonrpc: '2.0', result, id }
      } catch (err) {
        return {
          jsonrpc: '2.0',
          error: { code: -32603, message: err instanceof Error ? err.message : 'Internal error' },
          id,
        }
      }
    }

    return {
      jsonrpc: '2.0',
      error: { code: -32601, message: `Method not found: ${request.method}` },
      id,
    }
  }
}
