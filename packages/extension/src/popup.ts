import type { PopupCommand, PopupStatus, SiteTool, SiteToolsResult } from './messages.js'

/**
 * T-001.8 — one screen, one primary button, no port and no token.
 *
 * WO-015 T-015.1 — and no "can't reach the service" screen either: recording writes to the
 * extension's own store, so there is nothing to be running, nothing to pair with, and no state
 * where the button has to be withheld. What is left is whether Douze can watch THIS page.
 *
 * `chrome.permissions.request` must be the first statement in a click handler, so the active
 * tab and its origin are cached at popup load rather than read on click.
 */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const el = {
  unsupported: $<HTMLElement>('unsupported'),
  ready: $<HTMLElement>('ready'),
  watching: $<HTMLElement>('watching'),
  finished: $<HTMLElement>('finished'),
  hostname: $<HTMLParagraphElement>('hostname'),
  name: $<HTMLInputElement>('name'),
  watch: $<HTMLButtonElement>('watch'),
  toolsSummary: $<HTMLParagraphElement>('tools-summary'),
  tools: $<HTMLUListElement>('tools'),
  watchingName: $<HTMLHeadingElement>('watching-name'),
  count: $<HTMLParagraphElement>('count'),
  note: $<HTMLTextAreaElement>('note'),
  addNote: $<HTMLButtonElement>('add-note'),
  noted: $<HTMLParagraphElement>('noted'),
  done: $<HTMLButtonElement>('done'),
  finishedText: $<HTMLParagraphElement>('finished-text'),
  finishedAction: $<HTMLButtonElement>('finished-action'),
  error: $<HTMLParagraphElement>('error'),
  connect: $<HTMLButtonElement>('connect'),
  useDebugger: $<HTMLInputElement>('use-debugger'),
  noise: $<HTMLTextAreaElement>('noise'),
  saveNoise: $<HTMLButtonElement>('save-noise'),
}

/** Subdomains that name the deployment, not the product: `app.linear.app` is Linear. */
const GENERIC_LABELS = new Set(['www', 'app', 'my', 'go', 'dashboard', 'console', 'admin'])

/** The name we suggest: the site's own word, capitalised. Never blocking — always editable. */
function defaultName(hostname: string): string {
  const labels = hostname.split('.')
  const first = labels.find((label) => !GENERIC_LABELS.has(label)) ?? labels[0] ?? hostname
  return first.charAt(0).toUpperCase() + first.slice(1)
}

/** AC-CAP-001.3 — the live count, in words rather than a bare number. */
function countPhrase(count: number): string {
  if (count === 0) return 'Nothing yet — use the site as you normally would'
  return count === 1 ? '1 thing so far' : `${count} things so far`
}

let activeTab: chrome.tabs.Tab | undefined
let activeOrigin = ''
let activeHostname = ''
/** The session that just stopped, so the review page can be opened after it is gone from status. */
let finished: { id: string; name: string; count: number; origins: string[] } | null = null

const send = async (command: PopupCommand): Promise<PopupStatus & { error?: string }> =>
  (await chrome.runtime.sendMessage(command)) as PopupStatus & { error?: string }

function showError(message: string | null): void {
  el.error.hidden = message === null
  el.error.textContent = message ?? ''
}

function show(state: 'unsupported' | 'ready' | 'watching' | 'finished'): void {
  for (const name of ['unsupported', 'ready', 'watching', 'finished'] as const) {
    el[name].hidden = name !== state
  }
}

function render(status: PopupStatus & { error?: string }): void {
  if (status.error) showError(status.error)
  if (document.activeElement !== el.noise) el.noise.value = status.noiseHosts.join('\n')

  if (status.session) {
    // Captured while the session is live: once it stops, status carries none of it, and the
    // origins are what the permission request on the next screen is made of.
    finished = {
      id: status.session.id,
      name: status.session.name,
      count: status.count,
      origins: status.seenOrigins,
    }
    el.watchingName.textContent = `Watching ${status.session.name}`
    el.count.textContent = countPhrase(status.count)
    return show('watching')
  }
  if (finished) {
    renderFinished(status)
    return show('finished')
  }
  if (!activeOrigin) return show('unsupported')
  return show('ready')
}

function renderFinished(status: PopupStatus): void {
  const session = finished
  if (!session) return
  if (session.count === 0) {
    el.finishedText.textContent =
      "Nothing was recorded. That usually means the site didn't load new data while Douze was watching — try again and click around the part you want it to handle."
    el.finishedAction.textContent = 'Try again'
    el.finishedAction.onclick = (): void => {
      finished = null
      showError(null)
      render(status)
    }
    return
  }
  el.finishedText.textContent = `Recorded ${session.count} things on ${session.name}.`
  el.finishedAction.textContent = 'Set up what this site can do →'
  el.finishedAction.onclick = (): void => {
    // First statement, and nothing awaited before it: `permissions.request` needs the click that
    // is running right now, and any await spends that gesture.
    //
    // The hosts a dashboard calls are rarely its own — `dashboard.example.com` asks
    // `api.example.com` — and the relay replays inside a tab on the origin it is calling. Without
    // this the actions would be recorded, approved, and then fail the first time they ran.
    // Chrome prompts for nothing already granted, so a site that serves its own API sees no
    // dialog at all.
    void chrome.permissions.request({ origins: session.origins.map((origin) => `${origin}/*`) })
    // Sent, not awaited, and never chained onto the line above: showing that prompt CLOSES this
    // popup, so a continuation here would never run — which looked exactly like a dead button.
    // The message is already on its way by then, and the worker opens the page whatever the
    // user answers, because the recording is finished either way.
    void chrome.runtime.sendMessage({ type: 'douze:review', sessionId: session.id })
  }
}

/** The same words the review page uses, so the category never rides on the border colour alone. */
const KIND_WORD: Record<SiteTool['side_effect'], string> = {
  read: 'Reads information',
  write: 'Makes changes',
  destructive: 'Deletes things',
}

/** What is already set up here — shown quietly, so a repeat recording has context. */
function renderTools(tools: SiteTool[]): void {
  el.toolsSummary.hidden = tools.length === 0
  el.toolsSummary.textContent = `${tools.length} things are already set up here`
  el.tools.replaceChildren(
    ...tools.slice(0, 5).map((tool) => {
      const item = document.createElement('li')
      item.dataset['effect'] = tool.side_effect
      const kind = document.createElement('span')
      kind.className = 'kind'
      kind.textContent = KIND_WORD[tool.side_effect]
      item.append(kind, ` — ${tool.description}`)
      return item
    }),
  )
}

el.watch.addEventListener('click', async () => {
  // First statement: any await before this consumes the user gesture and the request rejects.
  //
  // `debugger` is optional and nothing else ever asks for it, so ticking the box used to start a
  // session whose attach failed on a permission that had never been granted. It goes in this one
  // request because a second one would need a second gesture, and there is only ever one click.
  const granted = await chrome.permissions.request({
    origins: [`${activeOrigin}/*`],
    ...(el.useDebugger.checked ? { permissions: ['debugger'] } : {}),
  })
  if (!granted) {
    return showError('Douze needs your permission to watch this site. Nothing is recorded until you allow it.')
  }
  if (activeTab?.id === undefined) {
    return showError("Douze couldn't find the page. Close this popup, click the site's tab, and try again.")
  }
  showError(null)
  finished = null
  render(
    await send({
      type: 'douze:start',
      name: el.name.value.trim() || activeHostname,
      origins: [activeOrigin],
      tabId: activeTab.id,
      useDebugger: el.useDebugger.checked,
    }),
  )
  return undefined
})

// Sent, not awaited: the worker opens the tab, and opening one closes this popup — so a
// continuation here would never run, which is exactly what made the review button look dead.
// Offered whatever else the popup is showing; the page is served by the extension itself, so
// there is nothing that has to be up first.
el.connect.addEventListener('click', () => {
  void chrome.runtime.sendMessage({ type: 'douze:connect' })
})

el.done.addEventListener('click', async () => {
  render(await send({ type: 'douze:stop' }))
})

el.addNote.addEventListener('click', async () => {
  if (!el.note.value.trim()) return
  render(await send({ type: 'douze:annotate', note: el.note.value }))
  el.note.value = ''
  el.noted.hidden = false
})

/** AC-CAP-004.3 — additions apply to subsequent sessions, not the one already running. */
el.saveNoise.addEventListener('click', async () => {
  const hosts = el.noise.value
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean)
  render(await send({ type: 'douze:noise', hosts }))
})

async function boot(): Promise<void> {
  ;[activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
  try {
    const url = new URL(activeTab?.url ?? '')
    activeOrigin = url.protocol.startsWith('http') ? url.origin : ''
    activeHostname = url.hostname
  } catch {
    activeOrigin = ''
    activeHostname = ''
  }
  el.hostname.textContent = activeHostname
  el.name.value = defaultName(activeHostname)

  render(await send({ type: 'douze:status' }))
  if (activeOrigin) {
    const answer = (await chrome.runtime.sendMessage({
      type: 'douze:site-tools',
      origin: activeOrigin,
    })) as SiteToolsResult
    renderTools(answer.tools)
  }
  setInterval(async () => render(await send({ type: 'douze:status' })), 1000)
}

void boot()
