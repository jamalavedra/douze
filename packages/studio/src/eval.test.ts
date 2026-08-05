import { describe, expect, it } from 'vitest'
import { evaluateReference, formatEval } from './eval/run.js'
import { runEval, selectTool, tokenize } from './eval/selection.js'
import { REFERENCE_TASKS } from './eval/tasks.js'
import { referenceCandidates } from './eval/reference.js'

describe('COV_INF_006.3 selection accuracy', () => {
  const { tools, result } = evaluateReference()

  it('infers the reference orders recipe from the reference session', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([
      'cancel_order',
      'create_order',
      'get_customer',
      'get_order',
      'list_customers',
      'list_orders',
      'list_products',
      'list_shipments',
      'refund_order',
      'update_order',
    ])
  })

  it('reports selection accuracy of at least 90% over the labeled task set', () => {
    console.log(formatEval(result))
    expect(result.total).toBe(REFERENCE_TASKS.length)
    expect(result.accuracy, `misses: ${JSON.stringify(result.misses, null, 2)}`).toBeGreaterThanOrEqual(0.9)
  })

  it('labels every task with a tool that exists', () => {
    const names = new Set(tools.map((t) => t.name))
    for (const task of REFERENCE_TASKS) expect(names.has(task.expect), task.expect).toBe(true)
  })

  it('covers every inferred tool with at least one task', () => {
    const labelled = new Set(REFERENCE_TASKS.map((t) => t.expect))
    for (const tool of tools) expect(labelled.has(tool.name), tool.name).toBe(true)
  })
})

describe('selector behaviour', () => {
  it('canonicalises vocabulary on both sides and keeps plurality', () => {
    expect(tokenize('shoppers')).toEqual(['customer', 'customers'])
    expect(tokenize('purchase')).toEqual(['order'])
    expect(tokenize('what is')).toEqual(['read'])
  })

  it('returns nothing when no tool shares a term with the task', () => {
    expect(selectTool('deploy the kubernetes cluster', [{ name: 'list_orders', description: 'Lists orders.' }])).toBeUndefined()
  })

  it('scores an empty task set as zero rather than dividing by zero', () => {
    expect(runEval([], []).accuracy).toBe(0)
  })

  it('degrades when descriptions carry no distinguishing information', () => {
    const blind = referenceCandidates().map((c, i) => ({ name: `tool_${i}`, description: 'Does something.' }))
    expect(runEval(blind, REFERENCE_TASKS).accuracy).toBeLessThan(0.9)
  })
})
