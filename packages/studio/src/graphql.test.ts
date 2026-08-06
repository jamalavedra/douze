import { describe, expect, it } from 'vitest'
import { infer } from './inference/engine.js'
import { splitOperations } from './inference/graphql.js'
import { graphqlBody, makeExchanges } from './testing.js'
import type { JsonSchema } from './types.js'

const GET_ISSUE = 'query GetIssue($id: ID!) { issue(id: $id) { id title state } }'
const CREATE_ISSUE = 'mutation CreateIssue($title: String!) { createIssue(title: $title) { id title } }'

const session = () =>
  makeExchanges([
    {
      method: 'POST',
      url: '/graphql',
      request_body: graphqlBody(GET_ISSUE, { id: 'ISS-1' }, 'GetIssue'),
      response_body: { data: { issue: { id: 'ISS-1', title: 'Broken login', state: 'open' } } },
      provenance: 'Issue',
    },
    {
      method: 'POST',
      url: '/graphql',
      request_body: graphqlBody(CREATE_ISSUE, { title: 'New bug' }, 'CreateIssue'),
      response_body: { data: { createIssue: { id: 'ISS-2', title: 'New bug' } } },
      provenance: 'Create issue',
    },
    {
      method: 'POST',
      url: '/graphql',
      request_body: graphqlBody(GET_ISSUE, { id: 'ISS-2' }, 'GetIssue'),
      response_body: { data: { issue: { id: 'ISS-2', title: 'New bug', state: 'open' } } },
    },
  ])

describe('REQ-INF-004 GraphQL operation splitting', () => {
  // COV_INF_004.1
  it('yields one candidate per operation with variables-derived input schemas', () => {
    const candidates = infer({ exchanges: session() })
    expect(candidates.map((c) => c.tool.name)).toEqual(['create_issue', 'get_issue'])

    const get = candidates[1]
    expect(get?.tool.observations).toBe(2)
    const getInput = get?.tool.request.input_schema as JsonSchema
    expect(getInput['required']).toEqual(['id'])
    expect(Object.keys(getInput['properties'] as object)).toEqual(['id', 'raw'])

    const createInput = candidates[0]?.tool.request.input_schema as JsonSchema
    expect(createInput['required']).toEqual(['title'])
  })

  // AC-INF-004.2
  it('stores the operation document with the recipe', () => {
    const candidates = infer({ exchanges: session() })
    expect(candidates[1]?.tool.request.graphql).toEqual({ operation: 'GetIssue', document: GET_ISSUE })
    expect(candidates[0]?.tool.request.graphql?.operation).toBe('CreateIssue')
  })

  it('classifies a query as read and a mutation as write', () => {
    const candidates = infer({ exchanges: session() })
    expect(candidates[0]?.tool.side_effect).toBe('write')
    expect(candidates[1]?.tool.side_effect).toBe('read')
  })

  it('labels a destructive operation name destructive', () => {
    const candidates = infer({
      exchanges: makeExchanges([
        {
          method: 'POST',
          url: '/graphql',
          request_body: graphqlBody('mutation DeleteIssue($id: ID!) { deleteIssue(id: $id) { id } }', { id: '1' }),
          response_body: { data: { deleteIssue: { id: '1' } } },
        },
      ]),
    })
    expect(candidates[0]?.tool.side_effect).toBe('destructive')
  })

  // COV_INF_004.2
  it('excludes a 200 carrying an errors array from the response contract', () => {
    const exchanges = [
      ...session(),
      ...makeExchanges([
        {
          position: 3,
          method: 'POST',
          url: '/graphql',
          // Omits `title` entirely — the very reason the server rejected it.
          request_body: graphqlBody(CREATE_ISSUE, {}, 'CreateIssue'),
          status: 200,
          response_body: { data: null, errors: [{ message: 'title must not be empty', code: 'VALIDATION' }] },
        },
      ]),
    ]
    const create = infer({ exchanges }).find((c) => c.tool.name === 'create_issue')
    if (!create) throw new Error('no create_issue candidate')

    // The failing exchange contributed no fields and did not count as a contract observation.
    const output = create.tool.response.output_schema as JsonSchema
    expect(Object.keys(output['properties'] as object)).toEqual(['id', 'title'])
    expect(JSON.stringify(output)).not.toContain('errors')
    expect(create.tool.observations).toBe(1)
    expect(create.tool.flags.sparse).toBe(true)

    /**
     * AC-INF-004.4 — "shall exclude it from schema inference", input schema included. The failed
     * call omitted `title`; had it reached input inference, `title` would be optional here and the
     * tool would advertise that an agent may reproduce exactly the request the server rejected.
     */
    expect((create.tool.request.input_schema as JsonSchema)['required']).toEqual(['title'])
  })

  // AC-INF-004.3
  it('derives a name from the root field of an anonymous operation and flags it', () => {
    const candidates = infer({
      exchanges: makeExchanges([
        {
          method: 'POST',
          url: '/graphql',
          request_body: graphqlBody('{ viewer { id email } }', {}),
          response_body: { data: { viewer: { id: '1', email: 'a@b.c' } } },
        },
      ]),
    })
    expect(candidates[0]?.tool.name).toBe('viewer')
    expect(candidates[0]?.tool.flags.derived_name).toBe(true)
  })

  it('groups by operation name across differing documents', () => {
    const operations = splitOperations(
      makeExchanges([
        { method: 'POST', url: '/graphql', request_body: graphqlBody(GET_ISSUE, { id: '1' }, 'GetIssue') },
        { method: 'POST', url: '/graphql', request_body: graphqlBody(GET_ISSUE, { id: '2' }, 'GetIssue') },
        { method: 'POST', url: '/graphql', request_body: graphqlBody(CREATE_ISSUE, { title: 'x' }, 'CreateIssue') },
      ]),
    )
    expect(operations.map((o) => [o.operation, o.exchanges.length])).toEqual([
      ['CreateIssue', 1],
      ['GetIssue', 2],
    ])
  })

  it('selects the payload path past the data envelope', () => {
    const candidates = infer({ exchanges: session() })
    expect(candidates[1]?.tool.response.primary_payload_path).toBe('$.data.issue')
  })
})
