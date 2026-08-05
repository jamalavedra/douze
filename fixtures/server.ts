/**
 * Fixture target app for the E2E suite. One file, no dependencies — it stands in for a real
 * authenticated dashboard so tests can assert on what the *server* saw, which is the only way
 * to prove claims like "the relay carried the session cookie" or "zero requests were issued".
 *
 * Control endpoints under /__test/ let a spec mutate behaviour mid-run (expire the session,
 * widen a response, add latency) without restarting.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

interface Order { id: number; item: string; qty: number; status: string; note?: string }

interface Control {
  /** Requests the server has seen, for zero-request and exactly-one-request assertions. */
  log: { method: string; path: string; headers: Record<string, string> }[]
  /** AC-EXE-002.1 — flip to make every authenticated route answer 401. */
  sessionValid: boolean
  /** AC-DRF-001.2 — add an optional field, to be classified schema_widened. */
  widenResponse: boolean
  /** AC-DRF-002.1 — drop a required field, to be classified breaking. */
  breakResponse: boolean
  /** AC-CON-003.1 — delay a read response to force progress notifications. */
  delayMs: number
  /** COV_EXE_001.2 — serve the page-state-token variant of the SPA. */
  pageStateAuth: boolean
}

const control: Control = {
  log: [],
  sessionValid: true,
  widenResponse: false,
  breakResponse: false,
  delayMs: 0,
  pageStateAuth: false,
}

const SESSION_COOKie = 'fixture_session'
const SESSION_VALUE = 's3ssion-fixture-value'
const CSRF_VALUE = 'csrf-fixture-value'
const PAGE_TOKEN = 'page-state-bearer-token-value'

let nextId = 1042
const orders: Order[] = [
  { id: nextId++, item: 'widget', qty: 2, status: 'open' },
  { id: nextId++, item: 'gasket', qty: 1, status: 'open' },
]
const issues: { id: string; title: string; state: string }[] = [{ id: 'I-1', title: 'login bug', state: 'open' }]

const json = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...extra })
  res.end(payload)
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
  })

/** Mirrors how a real dashboard authenticates: a session cookie, or a page-state bearer + CSRF. */
function authorized(req: IncomingMessage): boolean {
  if (!control.sessionValid) return false
  const cookie = req.headers.cookie ?? ''
  if (cookie.includes(`${SESSION_COOKie}=${SESSION_VALUE}`)) return true
  const auth = req.headers.authorization ?? ''
  if (auth === `Bearer ${PAGE_TOKEN}` && req.headers['x-csrf-token'] === CSRF_VALUE) return true
  return false
}

function shapeOrder(order: Order): Record<string, unknown> {
  const shaped: Record<string, unknown> = { ...order }
  if (control.widenResponse) shaped['priority'] = 'normal'
  if (control.breakResponse) delete shaped['status']
  return shaped
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const method = req.method ?? 'GET'

  // Test control plane is never logged — it is not traffic the app produced.
  if (path.startsWith('/__test/')) return handleControl(path, req, res)

  control.log.push({ method, path, headers: req.headers as Record<string, string> })

  if (path === '/' || path === '/index.html') return servePage(res)
  if (path === '/app.css') {
    res.writeHead(200, { 'content-type': 'text/css' })
    return res.end('body{font-family:system-ui}')
  }
  if (path === '/login' && method === 'POST') {
    return json(res, 200, { ok: true }, { 'set-cookie': `${SESSION_COOKie}=${SESSION_VALUE}; Path=/; SameSite=Lax` })
  }

  if (control.delayMs > 0 && method === 'GET') await new Promise((r) => setTimeout(r, control.delayMs))

  if (!authorized(req)) {
    // AC-EXE-002.1 — 401 is the signal the relay classifies as session_expired.
    return json(res, 401, { error: 'session expired' })
  }

  if (path === '/api/orders' && method === 'GET') {
    return json(res, 200, { data: { orders: orders.map(shapeOrder) }, meta: { total: orders.length } })
  }
  if (path === '/api/orders' && method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}')
    const order: Order = { id: nextId++, item: body.item ?? 'unknown', qty: body.qty ?? 1, status: 'open' }
    if (body.note !== undefined) order.note = body.note
    orders.push(order)
    return json(res, 201, { data: { order: shapeOrder(order) } })
  }
  const orderMatch = /^\/api\/orders\/(\d+)$/.exec(path)
  if (orderMatch) {
    const id = Number(orderMatch[1])
    const index = orders.findIndex((o) => o.id === id)
    if (index === -1) return json(res, 404, { error: 'not found' })
    if (method === 'GET') return json(res, 200, { data: { order: shapeOrder(orders[index]!) } })
    if (method === 'DELETE') {
      orders.splice(index, 1)
      return json(res, 200, { data: { deleted: id } })
    }
  }
  // A large payload with a small primary path, for AC-RUN-004.3 trimming and truncation.
  if (path === '/api/report' && method === 'GET') {
    const filler = Array.from({ length: 800 }, (_, i) => ({ i, blob: 'x'.repeat(48) }))
    return json(res, 200, { envelope: { trace: filler }, data: { summary: { open: orders.length } } })
  }
  if (path === '/api/poll' && method === 'GET') return json(res, 200, { data: { tick: Date.now() } })

  if (path === '/graphql' && method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}')
    const op = body.operationName as string | undefined
    if (op === 'CreateIssue') {
      // AC-INF-004.4 — a 200 carrying `errors` must not contribute to the response contract.
      if (body.variables?.title === '') return json(res, 200, { errors: [{ message: 'title required' }] })
      const issue = { id: `I-${issues.length + 1}`, title: body.variables?.title ?? '', state: 'open' }
      issues.push(issue)
      return json(res, 200, { data: { createIssue: issue } })
    }
    if (op === 'GetIssue') {
      return json(res, 200, { data: { issue: issues.find((i) => i.id === body.variables?.id) ?? issues[0] } })
    }
    return json(res, 200, { data: { issues } })
  }

  return json(res, 404, { error: 'not found' })
})

function handleControl(path: string, req: IncomingMessage, res: ServerResponse) {
  const key = path.replace('/__test/', '')
  if (key === 'log') return json(res, 200, control.log)
  if (key === 'reset') {
    control.log = []
    Object.assign(control, { sessionValid: true, widenResponse: false, breakResponse: false, delayMs: 0 })
    return json(res, 200, { ok: true })
  }
  if (key in control) {
    const value = new URL(req.url ?? '', 'http://x').searchParams.get('value')
    ;(control as Record<string, unknown>)[key] = value === null ? true : JSON.parse(value)
    return json(res, 200, { [key]: (control as Record<string, unknown>)[key] })
  }
  return json(res, 404, { error: `unknown control "${key}"` })
}

function servePage(res: ServerResponse) {
  const auth = control.pageStateAuth
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(`<!doctype html><html><head><title>Fixture Orders</title><link rel="stylesheet" href="/app.css"></head>
<body>
<h1>Orders</h1>
<button id="create">Create order</button>
<button id="list">List orders</button>
<button id="del">Delete order</button>
<button id="gql">Create issue</button>
<pre id="out"></pre>
<script>
${auth ? `window.__token = ${JSON.stringify(PAGE_TOKEN)}; localStorage.setItem('csrf', ${JSON.stringify(CSRF_VALUE)});` : ''}
const opts = () => (${auth}
  ? { headers: { 'content-type': 'application/json', authorization: 'Bearer ' + window.__token, 'x-csrf-token': localStorage.getItem('csrf') } }
  : { headers: { 'content-type': 'application/json' }, credentials: 'include' });
const show = (d) => document.getElementById('out').textContent = JSON.stringify(d);
document.getElementById('create').onclick = async () => {
  const o = opts(); show(await (await fetch('/api/orders', { method: 'POST', ...o, body: JSON.stringify({ item: 'widget', qty: 2 }) })).json());
};
document.getElementById('list').onclick = async () => show(await (await fetch('/api/orders', opts())).json());
document.getElementById('del').onclick = async () => {
  const list = await (await fetch('/api/orders', opts())).json();
  const id = list.data.orders[0].id;
  show(await (await fetch('/api/orders/' + id, { method: 'DELETE', ...opts() })).json());
};
document.getElementById('gql').onclick = async () => {
  const o = opts();
  show(await (await fetch('/graphql', { method: 'POST', ...o, body: JSON.stringify({ operationName: 'CreateIssue', query: 'mutation CreateIssue($title:String!){createIssue(title:$title){id title state}}', variables: { title: 'login bug' } }) })).json());
};
// Background polling, for AC-CAP-003.3 — no gesture precedes these.
setInterval(() => fetch('/api/poll', opts()).catch(() => {}), 1000);
// Noise traffic the capture filter must drop (AC-CAP-004.1).
fetch('https://www.google-analytics.com/g/collect', { mode: 'no-cors' }).catch(() => {});
</script></body></html>`)
}

const port = Number(process.env['FIXTURE_PORT'] ?? 4180)
server.listen(port, () => console.log(`fixture app on http://127.0.0.1:${port}`))
