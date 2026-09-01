/*
 * The one Anthropic client factory, and the header that decides whether an identity-linked
 * key works at all.
 *
 * Tested through the SDK's own `fetch` option rather than by poking private fields: the
 * question is what goes on the wire, and a stubbed transport answers exactly that. No
 * network, no key that is real.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  WORKSPACE_HEADER,
  anthropicWorkspaceId,
  createAnthropicClient,
} from '../srv/lib/anthropic-client'

const MINIMAL_MESSAGE = {
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text: 'hi' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
}

/** Sends one request through a freshly built client and returns the headers it carried. */
async function headersSent(): Promise<Headers> {
  let captured: Headers | null = null
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    captured = new Headers(init?.headers)
    return new Response(JSON.stringify(MINIMAL_MESSAGE), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const client = createAnthropicClient({ apiKey: 'sk-ant-test', fetch, maxRetries: 0 })
  await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 8,
    messages: [{ role: 'user', content: 'hi' }],
  })
  if (captured === null) throw new Error('the stub transport was never called')
  return captured
}

describe('anthropicWorkspaceId', () => {
  const saved = process.env.ANTHROPIC_WORKSPACE_ID
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_WORKSPACE_ID
    else process.env.ANTHROPIC_WORKSPACE_ID = saved
  })

  it('is undefined when unset or blank, trimmed otherwise', () => {
    delete process.env.ANTHROPIC_WORKSPACE_ID
    expect(anthropicWorkspaceId()).toBeUndefined()
    process.env.ANTHROPIC_WORKSPACE_ID = '   '
    expect(anthropicWorkspaceId()).toBeUndefined()
    process.env.ANTHROPIC_WORKSPACE_ID = '  wrkspc_01ABC  '
    expect(anthropicWorkspaceId()).toBe('wrkspc_01ABC')
  })
})

describe('createAnthropicClient', () => {
  const saved = process.env.ANTHROPIC_WORKSPACE_ID
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_WORKSPACE_ID
    else process.env.ANTHROPIC_WORKSPACE_ID = saved
  })

  it('sends no workspace header when none is configured', async () => {
    delete process.env.ANTHROPIC_WORKSPACE_ID
    const headers = await headersSent()
    expect(headers.get(WORKSPACE_HEADER)).toBeNull()
    expect(headers.get('x-api-key')).toBe('sk-ant-test')
  })

  it('sends ANTHROPIC_WORKSPACE_ID on every request when it is set', async () => {
    process.env.ANTHROPIC_WORKSPACE_ID = 'wrkspc_01ABC'
    const headers = await headersSent()
    expect(headers.get(WORKSPACE_HEADER)).toBe('wrkspc_01ABC')
  })
})
