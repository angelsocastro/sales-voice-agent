import { describe, it, expect, vi } from 'vitest'
import { createMcpHandler } from '../../src/mcp/handler.js'
import type { Tool } from '../../src/mcp/types.js'

function makeTool(name: string, response: string): Tool {
  return {
    name,
    description: `Test tool ${name}`,
    inputSchema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', description: 'lead id' },
      },
      required: ['lead_id'],
    },
    handler: vi.fn().mockResolvedValue({
      content: [{ type: 'text' as const, text: response }],
    }),
  }
}

describe('MCP handler', () => {
  it('responds to initialize', async () => {
    const handle = createMcpHandler([])
    const res = await handle({
      jsonrpc: '2.0',
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'telnyx', version: '1' } },
      id: 1,
    })
    expect(res.result).toMatchObject({
      protocolVersion: '2025-03-26',
      serverInfo: { name: 'bdr-mcp-server' },
    })
    expect(res.error).toBeUndefined()
  })

  it('responds to tools/list', async () => {
    const tool = makeTool('test_tool', 'ok')
    const handle = createMcpHandler([tool])
    const res = await handle({ jsonrpc: '2.0', method: 'tools/list', id: 2 })
    expect((res.result as { tools: unknown[] }).tools).toHaveLength(1)
    expect((res.result as { tools: Array<{ name: string }> }).tools[0].name).toBe('test_tool')
  })

  it('dispatches tools/call to correct tool', async () => {
    const tool = makeTool('mark_bad_contact', 'done')
    const handle = createMcpHandler([tool])
    const res = await handle({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'mark_bad_contact',
        arguments: { lead_id: 'lead_x' },
        _meta: { telnyx_conversation_id: 'conv_123' },
      },
      id: 3,
    })
    expect(tool.handler).toHaveBeenCalledWith(
      { lead_id: 'lead_x' },
      { telnyx_conversation_id: 'conv_123' }
    )
    expect(res.error).toBeUndefined()
  })

  it('returns error for unknown tool', async () => {
    const handle = createMcpHandler([])
    const res = await handle({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'nonexistent', arguments: {}, _meta: {} },
      id: 4,
    })
    expect(res.error).toBeDefined()
    expect(res.error?.code).toBe(-32601)
  })

  it('returns error for unknown method', async () => {
    const handle = createMcpHandler([])
    const res = await handle({ jsonrpc: '2.0', method: 'unknown/method', id: 5 })
    expect(res.error?.code).toBe(-32601)
  })

  it('passes _meta as context to tool', async () => {
    const tool = makeTool('end_call', 'done')
    const handle = createMcpHandler([tool])
    await handle({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'end_call',
        arguments: { lead_id: 'lead_y', resultado: 'interesado', transcript: 'ok' },
        _meta: { telnyx_conversation_id: 'conv_456', extra: 'data' },
      },
      id: 6,
    })
    expect(tool.handler).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ telnyx_conversation_id: 'conv_456' })
    )
  })
})
