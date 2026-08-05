/**
 * T-001.3 / T-002.1 — the ISOLATED-world half of the capture path. It relays interceptor
 * messages to the service worker and, in the same script, records the gesture provenance the
 * MAIN world has no reason to see (REQ-CAP-003).
 *
 * Imports here must stay type-only — this file is injected as a classic content script.
 */
import type { CaptureBatch, GestureEvent, PageEvent } from './messages.js'

;(() => {
  const BUFFER: PageEvent[] = []
  let flushing = false

  window.addEventListener(
    'message',
    (e: MessageEvent) => {
      // Load-bearing: same frame only. Rejects iframes, the opener, and every other window.
      if (e.source !== window) return
      if (e.origin !== location.origin && e.origin !== 'null') return
      const data = e.data as { __recon?: number; dir?: string; payload?: PageEvent } | null
      if (data?.__recon !== 1 || data.dir !== 'page->cs' || !data.payload) return
      BUFFER.push(data.payload)
      schedule()
    },
    true,
  )

  function schedule(): void {
    if (flushing) return
    flushing = true
    // Batch: one sendMessage per request is brutal on chatty pages.
    setTimeout(() => void flush(), 250)
  }

  async function flush(): Promise<void> {
    flushing = false
    if (!BUFFER.length) return
    const batch = BUFFER.splice(0, 200)
    const message: CaptureBatch = { type: 'recon:capture', frameUrl: location.href, batch }
    try {
      await chrome.runtime.sendMessage(message)
    } catch {
      // "Extension context invalidated" after a reload, or the worker failed to start. Drop
      // rather than retrying: a retry loop here becomes an infinite service-worker wake loop.
    }
    if (BUFFER.length) schedule()
  }

  // --- provenance (REQ-CAP-003) ---------------------------------------------

  const INTERACTIVE = 'a,button,input,select,textarea,summary,[role],[onclick],[tabindex]'

  const ROLES: Record<string, string> = {
    A: 'link',
    BUTTON: 'button',
    SELECT: 'combobox',
    TEXTAREA: 'textbox',
    SUMMARY: 'button',
    FORM: 'form',
  }

  function roleOf(el: Element): string {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    if (el.tagName === 'INPUT') {
      const type = (el as HTMLInputElement).type
      return type === 'submit' || type === 'button' || type === 'reset' ? 'button' : 'textbox'
    }
    return ROLES[el.tagName] ?? 'generic'
  }

  /** A pragmatic subset of accname: enough to name a real dashboard control. */
  function accessibleName(el: Element): string {
    const label = el.getAttribute('aria-label')?.trim()
    if (label) return label
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
        .filter(Boolean)
        .join(' ')
      if (text) return text
    }
    if (el.id) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim()
      if (forLabel) return forLabel
    }
    const closestLabel = el.closest('label')?.textContent?.trim()
    if (closestLabel) return closestLabel
    if (el.tagName === 'INPUT') {
      const input = el as HTMLInputElement
      const value = input.value.trim()
      if ((input.type === 'submit' || input.type === 'button') && value) return value
      const placeholder = input.placeholder?.trim()
      if (placeholder) return placeholder
    }
    const img = el.querySelector('img[alt]')?.getAttribute('alt')?.trim()
    if (img) return img
    const text = el.textContent?.replace(/\s+/g, ' ').trim()
    if (text) return text.slice(0, 120)
    return el.getAttribute('title')?.trim() ?? ''
  }

  function report(el: Element): void {
    const gesture: GestureEvent = {
      type: 'gesture',
      accessible_name: accessibleName(el),
      role: roleOf(el),
      route: location.pathname + location.search + location.hash,
      title: document.title,
      t: Date.now(),
    }
    BUFFER.push(gesture)
    schedule()
  }

  document.addEventListener(
    'click',
    (e) => {
      const target = e.target
      if (!(target instanceof Element)) return
      const el = target.closest(INTERACTIVE) ?? target
      report(el)
    },
    true,
  )

  document.addEventListener(
    'submit',
    (e) => {
      if (e.target instanceof Element) report(e.target)
    },
    true,
  )

  // Announce to the MAIN world. Ordering between the two scripts is not guaranteed, so
  // announce twice: now, and on a microtask in case MAIN loaded first.
  const announce = (): void => window.postMessage({ __recon: 1, dir: 'cs->page', kind: 'ready' }, '/')
  announce()
  queueMicrotask(announce)
})()
