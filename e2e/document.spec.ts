import { test, expect, type Page } from '@playwright/test'
import { snapshotDocument, type DocumentSnapshot } from '../packages/extension/src/document.js'
import { FixtureApp, launchHelium, stopEverything } from './harness.js'

test.afterEach(stopEverything)

/**
 * TASK-011 — the extractor's only DOM test. `snapshotDocument` needs `DOMParser`, which the
 * service worker does not have (CON-002) and which the extension package deliberately does not
 * shim with jsdom, so the one place it can be exercised against a real DOM is a page.
 *
 * It is shipped into the page the same way the worker ships it — as source, through
 * `chrome.scripting.executeScript({ func })` there and through `.toString()` here. That also
 * catches the thing REQ-002 is about: a function that reaches for anything outside its own body
 * passes every unit test and throws the moment it lands in a page.
 */

/** The base the relative hrefs below resolve against; deep enough for `../` to mean something. */
const BASE = 'http://127.0.0.1:4180/deep/page'

/** The 32 KiB tool-result cap, in the UTF-16 code units REQ-004 counts. */
const BUDGET = 24_576

async function snapshot(page: Page, html: string, baseUrl: string = BASE): Promise<DocumentSnapshot> {
  return page.evaluate(
    (input) =>
      (new Function(`return (${input.source})`)() as (html: string, baseUrl: string) => DocumentSnapshot)(
        input.html,
        input.baseUrl,
      ),
    { source: snapshotDocument.toString(), html, baseUrl },
  )
}

/**
 * The hard-navigation path (REQ-013): `html` is null and the extractor reads the live document,
 * which is the only way shadow content can reach it — `outerHTML` leaves shadow roots out, so a
 * snapshot taken from a serialized copy of this page would be missing everything below.
 *
 * `body` becomes that document, and each `<template data-shadow="open"|"closed">` becomes its
 * parent's shadow root. They are attached with `attachShadow` rather than left declarative so the
 * assertions are about the extractor and not about the parser's declarative-shadow-DOM support.
 */
async function snapshotLive(page: Page, body: string, baseUrl: string = BASE): Promise<DocumentSnapshot> {
  return page.evaluate(
    (input) => {
      document.title = 'Live Title'
      document.body.innerHTML = input.body
      // `querySelectorAll` does not descend into a template's content, so one call sees exactly one
      // level of components; recursing into the root just attached picks up the ones nested inside.
      const attach = (root: DocumentFragment | Element): void => {
        for (const template of Array.from(root.querySelectorAll('template[data-shadow]'))) {
          const host = template.parentElement
          if (host === null) continue
          const mode = template.getAttribute('data-shadow') === 'closed' ? 'closed' : 'open'
          const shadow = host.attachShadow({ mode })
          shadow.append((template as HTMLTemplateElement).content)
          template.remove()
          attach(shadow)
        }
      }
      attach(document.body)
      return (new Function(`return (${input.source})`)() as (html: string | null, baseUrl: string) => DocumentSnapshot)(
        null,
        input.baseUrl,
      )
    },
    { source: snapshotDocument.toString(), body, baseUrl },
  )
}

test('snapshotDocument reduces a document to bounded text and links', async () => {
  test.setTimeout(120_000)

  const app = new FixtureApp()
  await app.start()
  const browser = await launchHelium()
  const page = await browser.context.newPage()
  await page.goto(app.origin)

  // --- which element the text comes from ---------------------------------
  const withMain = await snapshot(
    page,
    '<html><head><title>Fixture Title</title></head><body><p>chrome</p><main><p>content</p></main></body></html>',
  )
  expect(withMain.url).toBe(BASE)
  expect(withMain.title).toBe('Fixture Title')
  expect(withMain.text).toContain('content')
  expect(withMain.text).not.toContain('chrome')

  const withRole = await snapshot(page, '<body><p>chrome</p><div role="main"><p>content</p></div></body>')
  expect(withRole.text).toContain('content')
  expect(withRole.text).not.toContain('chrome')

  const withNeither = await snapshot(page, '<body><p>chrome</p><p>content</p></body>')
  expect(withNeither.text).toContain('chrome')
  expect(withNeither.text).toContain('content')

  // --- markup is not text ------------------------------------------------
  const stripped = await snapshot(
    page,
    `<main><p>keep</p>
     <script>var a = 'SCRIPT_MARKER'</script>
     <style>.x { content: 'STYLE_MARKER' }</style>
     <template><p>TEMPLATE_MARKER</p></template>
     <noscript>NOSCRIPT_MARKER</noscript>
     <nav><a href="/nav">NAV_MARKER</a></nav>
     <div role="navigation"><a href="/toc">TOC_MARKER</a></div>
     <aside><a href="/aside">ASIDE_MARKER</a></aside>
     <header><a href="/hit">HEADER_KEPT</a></header></main>`,
  )
  expect(stripped.text).toContain('keep')
  // Navigation chrome inside `main` is neither text nor a result link; a header is (a hit's title).
  for (const marker of ['SCRIPT_MARKER', 'STYLE_MARKER', 'TEMPLATE_MARKER', 'NOSCRIPT_MARKER', 'NAV_MARKER', 'TOC_MARKER', 'ASIDE_MARKER']) {
    expect(stripped.text).not.toContain(marker)
  }
  expect(stripped.links.map((link) => link.label)).toEqual(['HEADER_KEPT'])

  // --- shadow roots ------------------------------------------------------
  // A site that renders in web components (reddit's `shreddit-post`, a Lightning component) keeps
  // its content in shadow roots, which `outerHTML` omits: read that way the snapshot would be the
  // page's chrome and nothing else.
  const shadow = await snapshotLive(
    page,
    `<main>
       <p>light before</p>
       <x-card>
         <template data-shadow="open">
           <p>shadow text</p>
           <a href="/s1">Shadow One</a>
           <slot></slot>
           <a href="/s2">Shadow Two</a>
         </template>
         <a href="/l1">Slotted Light</a>
       </x-card>
       <a href="/after">After</a>
     </main>`,
  )
  // A component's shadow tree comes before the light children its `<slot>`s would have pulled in,
  // and both are read exactly once.
  expect(shadow.title).toBe('Live Title')
  expect(shadow.text).toBe('light before shadow text Shadow One Shadow Two Slotted Light After')
  expect(shadow.links).toEqual([
    { label: 'Shadow One', url: 'http://127.0.0.1:4180/s1' },
    { label: 'Shadow Two', url: 'http://127.0.0.1:4180/s2' },
    { label: 'Slotted Light', url: 'http://127.0.0.1:4180/l1' },
    { label: 'After', url: 'http://127.0.0.1:4180/after' },
  ])

  // Chrome is chrome wherever it is declared: a component's own nav and aside are skipped like the
  // ones in the light DOM above.
  const shadowChrome = await snapshotLive(
    page,
    `<main>
       <x-panel>
         <template data-shadow="open">
           <nav><a href="/nav">SHADOW_NAV</a></nav>
           <aside><a href="/aside">SHADOW_ASIDE</a></aside>
           <p>panel body</p>
           <a href="/keep">Keep</a>
         </template>
       </x-panel>
     </main>`,
  )
  expect(shadowChrome.text).toBe('panel body Keep')
  expect(shadowChrome.links).toEqual([{ label: 'Keep', url: 'http://127.0.0.1:4180/keep' }])

  // A component inside a component: the walk descends as far as the roots go.
  const nested = await snapshotLive(
    page,
    `<main>
       <x-outer>
         <template data-shadow="open">
           <p>outer</p>
           <x-inner>
             <template data-shadow="open">
               <p>inner</p>
               <a href="/inner">Inner Link</a>
             </template>
           </x-inner>
         </template>
       </x-outer>
     </main>`,
  )
  expect(nested.text).toBe('outer inner Inner Link')
  expect(nested.links).toEqual([{ label: 'Inner Link', url: 'http://127.0.0.1:4180/inner' }])

  // A closed root is unreachable by design — `element.shadowRoot` is null and its content is simply
  // absent. The page around it still reads.
  const closed = await snapshotLive(
    page,
    `<main>
       <p>visible</p>
       <x-secret>
         <template data-shadow="closed"><p>SECRET</p><a href="/secret">Secret</a></template>
       </x-secret>
     </main>`,
  )
  expect(closed.text).toBe('visible')
  expect(closed.links).toEqual([])

  // --- whitespace --------------------------------------------------------
  const spaced = await snapshot(page, '<main>\n  <p>alpha\n\n   beta</p>\n\t<p>gamma</p>  \n</main>')
  expect(spaced.text).toBe('alpha beta gamma')

  // --- links -------------------------------------------------------------
  const linked = await snapshot(
    page,
    `<main>
      <a href="/b">Beta</a>
      <a href="javascript:void(0)">Script link</a>
      <a href="mailto:someone@example.com">Mail link</a>
      <a href="../a">Alpha</a>
      <a href="/b">Beta again</a>
      <a href="https://example.com/x">External</a>
      <a>No href at all</a>
     </main>`,
  )
  // DOM order, resolved against the base, `http(s)` only, and deduplicated by resolved URL — so
  // "Beta again" is gone and the label kept is the one the reader saw first.
  expect(linked.links).toEqual([
    { label: 'Beta', url: 'http://127.0.0.1:4180/b' },
    { label: 'Alpha', url: 'http://127.0.0.1:4180/a' },
    { label: 'External', url: 'https://example.com/x' },
  ])

  // --- per-link caps -----------------------------------------------------
  const long = await snapshot(page, `<main><a href="/${'z'.repeat(700)}">${'L'.repeat(400)}</a></main>`)
  const link = long.links[0]!
  expect(link.label.length).toBeLessThanOrEqual(120)
  expect(link.label.startsWith('LLL')).toBe(true)
  expect(link.url.length).toBeLessThanOrEqual(512)
  expect(link.url.startsWith('http://127.0.0.1:4180/zzz')).toBe(true)

  // --- the budget: links go from the end first ---------------------------
  // Short labels on long URLs: the anchors' text is part of `main`'s text and stays small, while
  // the resolved URLs are what overflow the budget.
  const count = 600
  const many = Array.from({ length: count }, (_, i) => `<a href="/p/${i}/${'x'.repeat(80)}">R${i}</a>`).join('')
  const trimmed = await snapshot(page, `<main><p>a short summary of the results</p>${many}</main>`)
  expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(BUDGET)
  // The text was affordable, so it survived whole and the links paid for the overflow.
  expect(trimmed.text).toBe(`a short summary of the results${Array.from({ length: count }, (_, i) => `R${i}`).join('')}`)
  expect(trimmed.links.length).toBeGreaterThan(0)
  expect(trimmed.links.length).toBeLessThan(count)
  // What survived is a prefix of what was there — dropping from the end, not sampling.
  const prefix = Array.from(trimmed.links, (_entry, i) => `R${i}`)
  expect(trimmed.links.map((entry) => entry.label)).toEqual(prefix)

  // --- the budget: then the text is truncated ----------------------------
  const wordy = 'lorem ipsum dolor sit amet '.repeat(2_000)
  const cut = await snapshot(page, `<main><p>${wordy}</p><a href="/p/1">One</a><a href="/p/2">Two</a></main>`)
  expect(JSON.stringify(cut).length).toBeLessThanOrEqual(BUDGET)
  // Every link went before a single character of text did.
  expect(cut.links).toEqual([])
  expect(cut.text.length).toBeLessThan(wordy.length)
  expect(cut.text.startsWith('lorem ipsum dolor')).toBe(true)
})
