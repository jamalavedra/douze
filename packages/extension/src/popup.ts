import { DEFAULT_PORT } from '@recon/shared'
import type { PopupCommand, PopupStatus } from './messages.js'

/**
 * T-001.8 — start/stop, session naming, live count, annotation, and the daemon connection
 * settings. `chrome.permissions.request` must be the first statement in a click handler, so
 * the active tab and its origin are cached at popup load rather than read on click.
 */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const el = {
  connection: $<HTMLSpanElement>('connection'),
  idle: $<HTMLElement>('idle'),
  active: $<HTMLElement>('active'),
  name: $<HTMLInputElement>('name'),
  origin: $<HTMLDivElement>('origin'),
  useDebugger: $<HTMLInputElement>('use-debugger'),
  start: $<HTMLButtonElement>('start'),
  sessionName: $<HTMLDivElement>('session-name'),
  count: $<HTMLSpanElement>('count'),
  note: $<HTMLTextAreaElement>('note'),
  annotate: $<HTMLButtonElement>('annotate'),
  stop: $<HTMLButtonElement>('stop'),
  error: $<HTMLParagraphElement>('error'),
  port: $<HTMLInputElement>('port'),
  token: $<HTMLInputElement>('token'),
  save: $<HTMLButtonElement>('save'),
  noise: $<HTMLTextAreaElement>('noise'),
  saveNoise: $<HTMLButtonElement>('save-noise'),
}

let activeTab: chrome.tabs.Tab | undefined
let activeOrigin = ''

const send = async (command: PopupCommand): Promise<PopupStatus & { error?: string }> =>
  (await chrome.runtime.sendMessage(command)) as PopupStatus & { error?: string }

function showError(message: string | null): void {
  el.error.hidden = message === null
  el.error.textContent = message ?? ''
}

function render(state: PopupStatus & { error?: string }): void {
  showError(state.error ?? null)
  el.connection.textContent = state.connected ? 'connected' : 'daemon offline'
  el.idle.hidden = state.session !== null
  el.active.hidden = state.session === null
  el.count.textContent = String(state.count)
  el.sessionName.textContent = state.session ? `${state.session.name} — ${state.session.origins.join(', ')}` : ''
  el.port.value = String(state.port || DEFAULT_PORT)
  el.token.value = state.token
  if (document.activeElement !== el.noise) el.noise.value = state.noiseHosts.join('\n')
  el.start.disabled = !activeOrigin
}

el.start.addEventListener('click', async () => {
  // First statement: any await before this consumes the user gesture and the request rejects.
  const granted = await chrome.permissions.request({ origins: [`${activeOrigin}/*`] })
  if (!granted) return showError('Recon needs permission for this site to record it.')
  const name = el.name.value.trim()
  if (!name) return showError('A session name is required.')
  if (activeTab?.id === undefined) return showError('No active tab to record.')
  render(
    await send({
      type: 'recon:start',
      name,
      origins: [activeOrigin],
      tabId: activeTab.id,
      useDebugger: el.useDebugger.checked,
    }),
  )
  return undefined
})

el.stop.addEventListener('click', async () => {
  const before = Number(el.count.textContent ?? '0')
  render(await send({ type: 'recon:stop' }))
  showError(`Retained ${before} exchanges after filtering.`)
})

el.annotate.addEventListener('click', async () => {
  if (!el.note.value.trim()) return
  render(await send({ type: 'recon:annotate', note: el.note.value }))
  el.note.value = ''
})

el.save.addEventListener('click', async () => {
  await chrome.storage.local.set({ port: Number(el.port.value) || DEFAULT_PORT, token: el.token.value.trim() })
  showError('Saved. Reconnecting…')
})

/** AC-CAP-004.3 — additions apply to subsequent sessions, not the one already running. */
el.saveNoise.addEventListener('click', async () => {
  const hosts = el.noise.value
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean)
  render(await send({ type: 'recon:noise', hosts }))
  showError('Saved. Applies to the next session.')
})

async function boot(): Promise<void> {
  ;[activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
  try {
    activeOrigin = activeTab?.url ? new URL(activeTab.url).origin : ''
  } catch {
    activeOrigin = ''
  }
  el.origin.textContent = activeOrigin || 'This page cannot be recorded.'
  render(await send({ type: 'recon:status' }))
  setInterval(async () => render(await send({ type: 'recon:status' })), 1000)
}

void boot()
