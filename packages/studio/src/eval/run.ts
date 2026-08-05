import { referenceCandidates } from './reference.js'
import { runEval, type EvalResult, type ToolDoc } from './selection.js'
import { REFERENCE_TASKS } from './tasks.js'

/**
 * T-006.4 — the COV_INF_006.3 number, end to end and offline: infer the reference session, write
 * its descriptions with no model, then score tool selection against the labeled task set.
 * `pnpm --filter @recon/studio eval` runs it and prints the accuracy.
 */
export function evaluateReference(): { tools: ToolDoc[]; result: EvalResult } {
  const tools = referenceCandidates().map((c) => ({ name: c.tool.name, description: c.tool.description }))
  return { tools, result: runEval(tools, REFERENCE_TASKS) }
}

export function formatEval(result: EvalResult): string {
  const lines = [`selection accuracy: ${(result.accuracy * 100).toFixed(1)}% (${result.correct}/${result.total})`]
  for (const miss of result.misses) {
    lines.push(`  MISS "${miss.task}" — expected ${miss.expected}, selected ${miss.selected ?? '<none>'}`)
  }
  return lines.join('\n')
}
