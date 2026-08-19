import { describe, it, expect, vi } from 'vitest'
import { handleMcpMessage, MCP_TOOLS, MCP_PROTOCOL_VERSION } from '../src/core/mcp-tools'

const dispatch = vi.fn(async (name: string, args: Record<string, unknown>) => {
  if (name === 'boom') throw new Error('kaboom')
  return { ok: name, args }
})

const opts = { version: '9.9.9', dispatch }

describe('MCP JSON-RPC handler', () => {
  it('initialize returns protocol version, tools capability, and server info', async () => {
    const r = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }, opts)
    expect(r).not.toBeNull()
    expect(r!.result).toMatchObject({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'redlog', version: '9.9.9' }
    })
  })

  it('tools/list returns all 19 tools', async () => {
    const r = await handleMcpMessage({ id: 2, method: 'tools/list' }, opts)
    const tools = (r!.result as { tools: unknown[] }).tools
    expect(tools).toHaveLength(MCP_TOOLS.length)
    expect(MCP_TOOLS.length).toBe(19)
    const names = MCP_TOOLS.map((t) => t.name)
    expect(names).toContain('redlog_whoami')
    expect(names).toContain('redlog_chain_upgrade')
    expect(names).toContain('redlog_session_register')
  })

  it('every tool has a name, description, and object input schema', () => {
    for (const t of MCP_TOOLS) {
      expect(t.name).toMatch(/^redlog_/)
      expect(t.description.length).toBeGreaterThan(10)
      expect((t.inputSchema as { type: string }).type).toBe('object')
    }
  })

  it('tools/call dispatches and wraps the result as MCP text content', async () => {
    const r = await handleMcpMessage(
      { id: 3, method: 'tools/call', params: { name: 'redlog_status', arguments: {} } },
      opts
    )
    const content = (r!.result as { content: Array<{ type: string; text: string }> }).content
    expect(content[0].type).toBe('text')
    expect(JSON.parse(content[0].text)).toEqual({ ok: 'redlog_status', args: {} })
  })

  it('tool errors come back as isError content, not a JSON-RPC error', async () => {
    const r = await handleMcpMessage(
      { id: 4, method: 'tools/call', params: { name: 'boom', arguments: {} } },
      opts
    )
    const result = r!.result as { content: Array<{ text: string }>; isError: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('kaboom')
  })

  it('notifications return null (202, no body)', async () => {
    expect(await handleMcpMessage({ method: 'notifications/initialized' }, opts)).toBeNull()
  })

  it('unknown method with an id returns method-not-found', async () => {
    const r = await handleMcpMessage({ id: 5, method: 'nope/nope' }, opts)
    expect((r!.error as { code: number }).code).toBe(-32601)
  })

  it('ping is answered', async () => {
    const r = await handleMcpMessage({ id: 6, method: 'ping' }, opts)
    expect(r!.result).toEqual({})
  })
})
