/**
 * T-006.4 — offline eval harness for tool-selection accuracy (AC-INF-006.3, COV_INF_006.3).
 *
 * The selector is a BM25 retriever over a canonicalised vocabulary — a deliberately weak stand-in for
 * an agent choosing a tool. A weak selector is the point: if a lexical baseline can pick the right
 * tool from the name and description alone, the descriptions carry the distinguishing information,
 * which is what the 90% bar is actually measuring. Running it needs no model and no network.
 */

export interface LabeledTask {
  task: string
  /** Tool name the task should select. */
  expect: string
}

export interface ToolDoc {
  name: string
  description: string
}

export interface EvalResult {
  total: number
  correct: number
  accuracy: number
  misses: { task: string; expected: string; selected: string | undefined }[]
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'of', 'to', 'in', 'on', 'for', 'from', 'by',
  'with', 'as', 'at', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these',
  'those', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'they', 'them', 'their', 'do', 'does', 'did',
  'can', 'could', 'should', 'would', 'will', 'shall', 'please', 'just', 'need', 'want', 'use', 'used',
  'when', 'whom', 'how', 'why', 'not', 'no', 'so', 'up', 'out', 'about', 'into',
  'only', 'one', 'all', 'any', 'some', 'has', 'have', 'had', 'there', 'here', 'now', 'again',
])

/**
 * Vocabulary canonicalisation, applied to queries *and* to tool documents so both sides speak one
 * dialect. Generic and recipe-independent: nothing here names a tool. Canonicalising rather than
 * expanding matters — an expansion adds a rare token like "shopper" to the query, and BM25 then
 * rewards whichever description happens to contain that rare word.
 */
const CANONICAL: Record<string, string> = {
  // A question is a read. `show`/`see`/`view` are deliberately absent: they are neutral in
  // English ("show me order 1042" is a fetch, "show me the orders" is a list) and the
  // singular/plural signal already separates those two cases.
  what: 'read',
  which: 'read',
  who: 'read',
  where: 'read',
  browse: 'list',
  every: 'list',
  lookup: 'get',
  pull: 'get',
  fetch: 'get',
  retrieve: 'get',
  add: 'create',
  make: 'create',
  new: 'create',
  place: 'create',
  submit: 'create',
  change: 'update',
  edit: 'update',
  modify: 'update',
  mark: 'update',
  attach: 'update',
  scrap: 'cancel',
  abort: 'cancel',
  stop: 'cancel',
  reimburse: 'refund',
  repay: 'refund',
  money: 'refund',
  buyer: 'customer',
  shopper: 'customer',
  client: 'customer',
  account: 'customer',
  purchase: 'order',
  sale: 'order',
  catalog: 'product',
  inventory: 'product',
  stock: 'product',
  sku: 'product',
  shipping: 'shipment',
  delivery: 'shipment',
  parcel: 'shipment',
  package: 'shipment',
  carrier: 'shipment',
}

/**
 * Emits the canonical singular for every word, plus a canonical plural when the surface form was
 * plural. Plurality is the signal that separates a list tool from a fetch-one tool — "who are our
 * shoppers" and "look up that shopper" share every other word — so stemming it away, as a normal
 * retriever would, throws out the only evidence those two requests differ.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length < 2 || STOPWORDS.has(word)) continue
    const base = stem(word)
    const canonical = CANONICAL[base] ?? base
    tokens.push(canonical)
    if (base !== word && PLURAL.test(word)) tokens.push(`${canonical}s`)
  }
  return tokens
}

const PLURAL = /(?:ies|es|s)$/

/** Crude suffix stripping — enough to make "orders"/"order" and "refunded"/"refund" agree. */
function stem(token: string): string {
  for (const suffix of ['ing', 'ies', 'ed', 'es', 's']) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
      return suffix === 'ies' ? `${token.slice(0, -3)}y` : token.slice(0, -suffix.length)
    }
  }
  return token
}

const K1 = 1.2
const B = 0.75

/** Field boost: an agent reads the tool name first, so name terms count for more than prose. */
const NAME_WEIGHT = 3

export function selectTool(task: string, tools: readonly ToolDoc[]): string | undefined {
  if (tools.length === 0) return undefined
  const docs = tools.map((tool) => [
    ...Array.from({ length: NAME_WEIGHT }, () => tokenize(tool.name)).flat(),
    ...tokenize(tool.description),
  ])
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length
  const query = [...new Set(tokenize(task))]

  let best: { name: string; score: number } | undefined
  for (const [index, doc] of docs.entries()) {
    const counts = new Map<string, number>()
    for (const token of doc) counts.set(token, (counts.get(token) ?? 0) + 1)
    let score = 0
    for (const term of query) {
      const frequency = counts.get(term) ?? 0
      if (frequency === 0) continue
      const containing = docs.filter((d) => d.includes(term)).length
      const idf = Math.log(1 + (docs.length - containing + 0.5) / (containing + 0.5))
      score += (idf * (frequency * (K1 + 1))) / (frequency + K1 * (1 - B + (B * doc.length) / avgLength))
    }
    const name = tools[index]?.name
    if (name !== undefined && (best === undefined || score > best.score)) best = { name, score }
  }
  return best !== undefined && best.score > 0 ? best.name : undefined
}

export function runEval(tools: readonly ToolDoc[], tasks: readonly LabeledTask[]): EvalResult {
  const misses: EvalResult['misses'] = []
  let correct = 0
  for (const task of tasks) {
    const selected = selectTool(task.task, tools)
    if (selected === task.expect) correct += 1
    else misses.push({ task: task.task, expected: task.expect, selected })
  }
  return {
    total: tasks.length,
    correct,
    accuracy: tasks.length === 0 ? 0 : correct / tasks.length,
    misses,
  }
}
