/**
 * Real agent tool-selection accuracy — PRD 1.5's primary metric.
 *
 *   node e2e/eval/agent-selection.mjs
 *
 * The offline harness in `packages/studio/src/eval/` scores a BM25 lexical retriever. That is a
 * useful proxy (if a weak retriever can pick correctly, the descriptions carry the distinguishing
 * information) but it is NOT what the PRD measures: "agent tool-selection accuracy — the metric
 * that decides whether the product is useful". This script puts the same labeled tasks in front of
 * an actual model, using the local `claude` CLI so no API key is needed.
 *
 * Tasks are shuffled and tool order is randomised per run so position cannot be a cue. One batched
 * call keeps the cost to a single request; each task is presented independently within it.
 */
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'

const REPO = resolve(import.meta.dirname, '../..')
const BAR = 0.9

const { REFERENCE_TASKS } = await import(join(REPO, 'packages/studio/src/eval/tasks.ts'))
const { referenceCandidates } = await import(join(REPO, 'packages/studio/src/eval/reference.ts'))

const tools = referenceCandidates().map((c) => ({ name: c.tool.name, description: c.tool.description }))

// Deterministic shuffle so a run is reproducible but order is not the alphabetical default.
const seeded = (seed) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const shuffle = (items, rand) => {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

const rand = seeded(20260806)
const shuffledTools = shuffle(tools, rand)
const shuffledTasks = shuffle(REFERENCE_TASKS, rand)

const prompt = `You are choosing which tool to call. Below is a tool catalog, then a numbered list of user requests.

For EACH request, choose exactly one tool name from the catalog — the one you would actually call. Judge only from the tool names and descriptions. Treat every request independently.

<catalog>
${shuffledTools.map((t) => `- ${t.name}: ${t.description}`).join('\n')}
</catalog>

<requests>
${shuffledTasks.map((t, i) => `${i + 1}. ${t.task}`).join('\n')}
</requests>

Reply with ONLY a JSON array of ${shuffledTasks.length} strings, the chosen tool name for each request in order. No prose, no code fence.`

console.log(`Asking the model to choose among ${shuffledTools.length} tools for ${shuffledTasks.length} tasks...`)

const raw = execFileSync('claude', ['-p', prompt], { encoding: 'utf8', maxBuffer: 1 << 22 })
const match = raw.match(/\[[\s\S]*\]/)
if (!match) {
  console.error('Could not parse a JSON array from the model reply:\n', raw.slice(0, 800))
  process.exit(1)
}

const choices = JSON.parse(match[0])
if (choices.length !== shuffledTasks.length) {
  console.error(`Expected ${shuffledTasks.length} choices, got ${choices.length}`)
  process.exit(1)
}

const known = new Set(tools.map((t) => t.name))
let correct = 0
const misses = []
for (const [i, task] of shuffledTasks.entries()) {
  const picked = choices[i]
  if (picked === task.expect) correct += 1
  else misses.push({ task: task.task, expected: task.expect, picked, hallucinated: !known.has(picked) })
}

const accuracy = correct / shuffledTasks.length
console.log(`\nagent selection accuracy: ${(accuracy * 100).toFixed(1)}% (${correct}/${shuffledTasks.length})`)
if (misses.length) {
  console.log('\nmisses:')
  for (const m of misses) {
    console.log(`  "${m.task}"\n    expected ${m.expected}, picked ${m.picked}${m.hallucinated ? '  [NOT IN CATALOG]' : ''}`)
  }
}
console.log(`\n${accuracy >= BAR ? 'PASS' : 'FAIL'} — PRD 1.5 bar is ${BAR * 100}%`)
process.exit(accuracy >= BAR ? 0 : 1)
