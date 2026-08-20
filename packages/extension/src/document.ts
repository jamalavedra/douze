import { isHtmlContentType, type DocumentSnapshot } from '@douze/shared'
import type { ExchangeDraft } from './pipeline.js'

export type { DocumentSnapshot }

/**
 * REQ-002/003/004 — the one extractor, used at capture and at replay.
 *
 * It runs inside a tab through `chrome.scripting.executeScript({ func })`, which serializes this
 * function's source and evaluates it over there: it may not reference anything outside its own
 * body, and every constant it needs is therefore local. The service worker has no DOMParser of
 * its own (CON-002), which is why extraction happens in a tab at all.
 *
 * REQ-013 — `html` of `null` means "the document this is running in", which is how a hard
 * navigation is read: there is no response body to hand over, only the page the browser already
 * built. That page is walked directly rather than serialized and re-parsed, because
 * `outerHTML` omits shadow roots by spec: a site that renders in web components (a
 * `shreddit-post`, a Lightning component, most design systems) would serialize to its chrome and
 * none of its content. The walk reads and never mutates, so the live tab is untouched either way.
 */
export function snapshotDocument(html: string | null, baseUrl: string): DocumentSnapshot {
  // REQ-004 — the serialized snapshot has to survive `capResult`'s 32 KiB, with room for the
  // envelope around it and for UTF-8 being wider than UTF-16 on a non-Latin page.
  const budget = 24_576
  const maxLabel = 120
  const maxUrl = 512
  const collapse = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim()

  const parsed = html === null ? document : new DOMParser().parseFromString(html, 'text/html')
  // Markup that is not the page's text, and the landmarks that are chrome rather than content: a
  // `nav` or `aside` inside `main` (a language list, a table of contents) otherwise fills the first
  // links and a good part of the budget before the article starts. Not `header`/`footer`: a result
  // list puts each hit's title in one.
  const junk = 'script, style, template, noscript, nav, [role="navigation"], aside'
  // The site's own content region when it marks one, which is what a router swaps and what the
  // reader came for; the whole body is the honest fallback for a page that marks nothing.
  const root = parsed.querySelector('main, [role="main"]') ?? parsed.body

  // One pass for both the text and the anchors, so a shadow root is descended into once. Text
  // nodes are concatenated with nothing between them, which is what `textContent` does and what
  // the whitespace collapse below is written against. A component's shadow tree comes before its
  // light children, which are the nodes its `<slot>`s would have pulled into it. A closed root
  // reads as `null` here and its content is simply absent — the page chose that.
  const chunks: string[] = []
  const anchors: Element[] = []
  const walk = (node: Node): void => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) chunks.push(child.nodeValue ?? '')
      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const element = child as Element
      if (element.matches(junk)) continue
      if (element.matches('a[href]')) anchors.push(element)
      if (element.shadowRoot !== null) walk(element.shadowRoot)
      walk(element)
    }
  }
  walk(root)

  const snapshot: DocumentSnapshot = {
    url: baseUrl,
    title: parsed.title,
    text: collapse(chunks.join('')),
    links: [],
  }
  const seen = new Set<string>()
  for (const anchor of anchors) {
    let resolved: URL
    try {
      resolved = new URL(anchor.getAttribute('href') ?? '', baseUrl)
    } catch {
      continue
    }
    // `javascript:`, `mailto:` and friends are page machinery, not places a reader can follow.
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue
    if (seen.has(resolved.href)) continue
    seen.add(resolved.href)
    snapshot.links.push({
      label: collapse(anchor.textContent).slice(0, maxLabel),
      url: resolved.href.slice(0, maxUrl),
    })
  }

  // Links go first and from the end, because the ones a page lists last are its footer and its
  // navigation. Sizes are subtracted rather than re-serialized per drop, so a page with thousands
  // of anchors stays linear; the loop below then trims text against the exact length.
  let total = JSON.stringify(snapshot).length
  while (snapshot.links.length > 0 && total > budget) {
    total -= JSON.stringify(snapshot.links.pop()).length + 1
  }
  for (let over = JSON.stringify(snapshot).length - budget; over > 0 && snapshot.text.length > 0; ) {
    snapshot.text = snapshot.text.slice(0, Math.max(0, snapshot.text.length - over))
    over = JSON.stringify(snapshot).length - budget
  }
  return snapshot
}

/**
 * A read the site answered with a document. Only the MAIN-world capture qualifies: the oracle sees
 * the same request but has no body, so admitting it would store a document exchange with nothing
 * in it and hand inference a second, empty candidate for the same path.
 */
export function isDocumentDraft(draft: ExchangeDraft): boolean {
  return (
    draft.method.toUpperCase() === 'GET' &&
    isHtmlContentType(draft.response_content_type) &&
    typeof draft.response_body === 'string' &&
    draft.response_body.length > 0 &&
    draft.source === 'main_world'
  )
}
