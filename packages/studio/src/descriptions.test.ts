import { describe, expect, it } from 'vitest'
import { infer } from './inference/engine.js'
import { disambiguate, nameCandidate } from './descriptions/naming.js'
import { createModelClient, modelFromEnv } from './descriptions/model-client.js'
import { buildModelPayload, buildPrompt, describe as writeDescription, describeSync, descriptionInput, limitSentences } from './descriptions/writer.js'
import { makeExchanges } from './testing.js'
import { findSurvivingSecrets } from '@douze/shared'
import type { ModelClient } from './descriptions/model-client.js'

const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0)

describe('AC-INF-006.1 naming', () => {
  it('emits verb-object snake_case from method and path', () => {
    const base = { sideEffect: 'read' as const, addressed: false }
    expect(nameCandidate({ ...base, method: 'GET', path: '/api/orders' })).toBe('list_orders')
    expect(nameCandidate({ ...base, method: 'GET', path: '/api/orders/{orderId}', addressed: true })).toBe('get_order')
    expect(nameCandidate({ ...base, method: 'POST', path: '/api/orders', sideEffect: 'write' })).toBe('create_order')
    expect(nameCandidate({ ...base, method: 'PATCH', path: '/api/orders/{orderId}', sideEffect: 'write', addressed: true })).toBe('update_order')
    expect(nameCandidate({ ...base, method: 'DELETE', path: '/api/orders/{orderId}', sideEffect: 'destructive', addressed: true })).toBe('delete_order')
  })

  it('names a GraphQL candidate from its operation', () => {
    expect(nameCandidate({ method: 'POST', path: '/graphql', sideEffect: 'read', addressed: false, graphqlOperation: 'GetIssue' })).toBe('get_issue')
  })

  it('takes the verb from an action segment and the noun from the resource it acts on', () => {
    expect(nameCandidate({ method: 'POST', path: '/api/orders/{orderId}/refund', sideEffect: 'destructive', addressed: false })).toBe('refund_order')
  })

  // AC-CAP-007.3 — the note outranks the button label as evidence.
  it('prefers an annotation verb over a provenance label', () => {
    const name = nameCandidate({
      method: 'POST',
      path: '/api/issues/{issueId}',
      sideEffect: 'write',
      addressed: true,
      annotation: 'transitions an issue to done',
      provenance: 'Save',
    })
    expect(name).toBe('transition_issue')
  })
})

// AC-INF-006.3 / COV_INF_006.3
describe('AC-INF-006.3 collision disambiguation', () => {
  it('disambiguates from a distinguishing parameter', () => {
    expect(
      disambiguate([
        { name: 'list_orders', parameters: ['status'] },
        { name: 'list_orders', parameters: ['customerId'] },
      ]),
    ).toEqual(['list_orders_by_status', 'list_orders_by_customer_id'])
  })

  it('falls back to an ordinal when nothing distinguishes them', () => {
    expect(
      disambiguate([
        { name: 'list_orders', parameters: [] },
        { name: 'list_orders', parameters: [] },
      ]),
    ).toEqual(['list_orders_1', 'list_orders_2'])
  })

  it('leaves unique names alone', () => {
    expect(disambiguate([{ name: 'get_order', parameters: ['orderId'] }])).toEqual(['get_order'])
  })

  it('produces unique names across a whole recipe', () => {
    const names = infer({
      exchanges: makeExchanges([
        { url: '/api/orders', response_body: { data: [] } },
        { url: '/api/orders/1', response_body: { data: { id: 1 } } },
        { url: '/api/orders/2', response_body: { data: { id: 2 } } },
        { method: 'POST', url: '/api/orders', request_body: { sku: 'a' }, response_body: { data: { id: 3 } } },
      ]),
    }).map((c) => c.tool.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('AC-INF-006.2 descriptions', () => {
  const transitionSession = () =>
    infer({
      exchanges: makeExchanges([
        {
          method: 'POST',
          url: '/api/issues/42/transition',
          request_body: { state: 'done' },
          response_body: { data: { id: 42, state: 'done' } },
          provenance: 'Save',
        },
        {
          method: 'POST',
          url: '/api/issues/43/transition',
          request_body: { state: 'done' },
          response_body: { data: { id: 43, state: 'done' } },
          provenance: 'Save',
        },
      ]),
      annotations: [
        { id: 's1', session_id: 'test-session', note: 'transitions an issue to done', start_position: 0, end_position: 1 },
      ],
    })

  // COV_INF_006.1
  it('reflects the span note rather than the button label', () => {
    const candidate = transitionSession()[0]
    expect(candidate?.evidence.provenance?.accessible_name).toBe('Save')
    expect(candidate?.tool.description.toLowerCase()).toContain('transitions an issue to done')
    expect(candidate?.tool.description).not.toContain('Save')
  })

  it('states what it does, what it returns, and when to use it in at most three sentences', () => {
    for (const candidate of infer({
      exchanges: makeExchanges([
        { url: '/api/orders', response_body: { data: [{ id: 1, status: 'open' }] } },
        { url: '/api/orders/1', response_body: { data: { id: 1, status: 'open' } } },
        { url: '/api/orders/2', response_body: { data: { id: 2, status: 'open' } } },
        { method: 'DELETE', url: '/api/orders/2', response_body: { data: { id: 2 } } },
      ]),
    })) {
      const parts = sentences(candidate.tool.description)
      expect(parts.length).toBeLessThanOrEqual(3)
      expect(parts.length).toBeGreaterThanOrEqual(2)
      expect(candidate.tool.description).toMatch(/Returns /)
      expect(candidate.tool.description).toMatch(/Use it /)
    }
  })

  it('truncates anything longer than three sentences', () => {
    expect(limitSentences('One. Two. Three. Four.')).toBe('One. Two. Three.')
  })

  it('works with no model configured', async () => {
    const candidate = transitionSession()[0]
    if (!candidate) throw new Error('no candidate')
    expect(await writeDescription(candidate)).toBe(
      describeSync(descriptionInput(candidate.tool, candidate.evidence.provenance?.accessible_name)),
    )
  })
})

describe('AC-INF-006.4 only redacted payloads reach a model', () => {
  const withCredential = () =>
    infer({
      exchanges: makeExchanges([
        {
          url: '/api/orders',
          request_headers: { authorization: 'Bearer sk_live_9aZq3mTb7YxK2wPn5RdV8LcE', cookie: 'sid=abc123def456' },
          response_body: { data: [{ id: 1 }] },
        },
      ]),
    })

  // COV_INF_006.2
  it('sends no original credential value to a recording model endpoint', async () => {
    const seen: string[] = []
    const model: ModelClient = {
      config: { endpoint: 'http://127.0.0.1:9/v1/chat/completions', model: 'local', local: true },
      complete: async (prompt) => {
        seen.push(prompt)
        return 'Lists orders. Returns a list. Use it to browse.'
      },
    }
    const candidate = withCredential()[0]
    if (!candidate) throw new Error('no candidate')
    await writeDescription(candidate, { model })

    expect(seen).toHaveLength(1)
    expect(seen[0]).not.toContain('sk_live_9aZq3mTb7YxK2wPn5RdV8LcE')
    expect(seen[0]).not.toContain('sid=abc123def456')
    expect(seen[0]).toContain('«redacted:')
  })

  /**
   * A credential under a key no list names is redacted by value shape before the payload is
   * assembled, so the gate has nothing to refuse and the description still gets written. It used
   * to throw — which is safe but useless: it meant a developer console, whose API returns keys by
   * design, produced no descriptions at all.
   */
  it('redacts a credential-shaped value the key list misses, and still builds the payload', () => {
    const candidate = infer({
      exchanges: makeExchanges([
        {
          url: '/api/handoff',
          response_body: {
            handoff: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
          },
        },
      ]),
    })[0]
    if (!candidate) throw new Error('no candidate')
    const payload = buildModelPayload(candidate)
    // TR-6 still holds: what a model sees carries the shape, never the value.
    expect(JSON.stringify(payload)).not.toContain('eyJhbGciOi')
    expect(JSON.stringify(payload)).toContain('«redacted:')
  })

  /** The gate is defence in depth, and still fires on anything that reaches it unredacted. */
  it('refuses to send a payload that was never redacted', () => {
    expect(findSurvivingSecrets({ handoff: 'sk_live_9f8e7d6c5b4a39281706' })).toEqual(['$.handoff'])
  })

  it('keeps the description when the model fails, rather than emitting nothing', async () => {
    const model: ModelClient = {
      config: { endpoint: 'http://127.0.0.1:9', model: 'local', local: true },
      complete: async () => {
        throw new Error('connection refused')
      },
    }
    const candidate = withCredential()[0]
    if (!candidate) throw new Error('no candidate')
    expect(await writeDescription(candidate, { model })).toContain('Returns')
  })

  it('trims a chatty model to three sentences', async () => {
    const model: ModelClient = {
      config: { endpoint: 'http://127.0.0.1:9', model: 'local', local: true },
      complete: async () => 'One. Two. Three. Four. Five.',
    }
    const candidate = withCredential()[0]
    if (!candidate) throw new Error('no candidate')
    expect(await writeDescription(candidate, { model })).toBe('One. Two. Three.')
  })

  it('builds a prompt containing only the redacted payload', () => {
    const candidate = withCredential()[0]
    if (!candidate) throw new Error('no candidate')
    expect(buildPrompt(buildModelPayload(candidate))).toContain('"name": "list_orders"')
  })
})

describe('AC-INF-006.5 local model endpoint', () => {
  it('prefers a configured local endpoint over a remote provider', () => {
    expect(
      modelFromEnv({
        DOUZE_LOCAL_MODEL_ENDPOINT: 'http://127.0.0.1:11434/v1/chat/completions',
        DOUZE_MODEL_ENDPOINT: 'https://api.example.com/v1/chat/completions',
        DOUZE_MODEL_API_KEY: 'sk-remote',
      }),
    ).toEqual({ endpoint: 'http://127.0.0.1:11434/v1/chat/completions', model: 'local', local: true })
  })

  it('uses the remote provider only when no local endpoint is configured', () => {
    expect(modelFromEnv({ DOUZE_MODEL_ENDPOINT: 'https://api.example.com/v1', DOUZE_MODEL_API_KEY: 'k' })).toEqual({
      endpoint: 'https://api.example.com/v1',
      model: 'claude-sonnet-5',
      local: false,
      api_key: 'k',
    })
  })

  it('reports no model when nothing is configured, which is a supported mode', () => {
    expect(modelFromEnv({})).toBeUndefined()
  })

  it('posts an OpenAI-compatible completion request', async () => {
    const calls: { url: string; body: unknown }[] = []
    const client = createModelClient({ endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen', local: true }, (async (
      url: string,
      init: RequestInit,
    ) => {
      calls.push({ url, body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
    }) as unknown as typeof fetch)

    expect(await client.complete('hello')).toBe('ok')
    expect(calls[0]?.url).toBe('http://127.0.0.1:11434/v1')
    expect(calls[0]?.body).toMatchObject({ model: 'qwen', temperature: 0 })
  })
})
