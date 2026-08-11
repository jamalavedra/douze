import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import config from '../vite.config.js'

/**
 * WO-015 T-015.4 — the extension pages, asserted on their wiring rather than on a rendered DOM.
 *
 * There is no jsdom in this package on purpose: `popup.ts`, `review.ts` and `connect.ts` all reach
 * for `document` at import time and vitest runs on plain Node. What these guard is not layout but
 * the two lessons the pages exist for — the worker owns tab opening, because Chrome closes a popup
 * around a permission prompt and anything queued behind one never runs; and the connect page's
 * trust disclosure is the price of the feature, so it is on the page rather than behind a link.
 *
 * The build is asserted on the config rather than on `dist/`: running vite here would cost seconds
 * per run to prove something the config states outright, and `pnpm --filter @douze/extension build`
 * already fails loudly if an entry does not resolve.
 */

const source = (...parts: string[]): string => readFileSync(join(import.meta.dirname, ...parts), 'utf8')

describe('the extension build', () => {
  const input = (config as { build: { rollupOptions: { input: Record<string, string> } } }).build.rollupOptions
    .input

  it('emits an entry module for all three pages', () => {
    expect(Object.keys(input).sort()).toEqual(['background', 'bridge', 'connect', 'interceptor', 'popup', 'review'])
    expect(input['popup']).toMatch(/src\/popup\.ts$/)
    expect(input['review']).toMatch(/src\/pages\/review\.ts$/)
    expect(input['connect']).toMatch(/src\/pages\/connect\.ts$/)
  })

  it('gives each page an HTML file that loads its bundle by the name rollup writes', () => {
    for (const [page, script] of [
      ['popup', 'popup.js'],
      ['review', 'review.js'],
      ['connect', 'connect.js'],
    ] as const) {
      const html = source('..', 'public', `${page}.html`)
      expect(html).toContain(`src="${script}"`)
    }
    // `[name].js` at the top level is what makes those filenames predictable — an HTML input
    // would have vite rewrite them to hashed paths under `assets/`.
    const output = (config as { build: { rollupOptions: { output: { entryFileNames: string } } } }).build
      .rollupOptions.output
    expect(output.entryFileNames).toBe('[name].js')
  })

  it('shares one stylesheet between the two full-page views', () => {
    expect(source('..', 'public', 'review.html')).toContain('href="page.css"')
    expect(source('..', 'public', 'connect.html')).toContain('href="page.css"')
  })
})

describe('the popup', () => {
  const popup = source('popup.ts')
  const html = source('..', 'public', 'popup.html')
  const background = source('background.ts')

  it('opens both pages through the service worker, never itself', () => {
    expect(popup).toContain("chrome.runtime.sendMessage({ type: 'douze:review', sessionId: session.id })")
    expect(popup).toContain("chrome.runtime.sendMessage({ type: 'douze:connect' })")
    expect(popup).not.toContain('tabs.create')
    expect(background).toContain("if (message.type === 'douze:review')")
    expect(background).toContain("if (message.type === 'douze:connect')")
    expect(background).toContain("chrome.runtime.getURL(`review.html?session=${encodeURIComponent(sessionId)}`)")
    expect(background).toContain("chrome.runtime.getURL('connect.html')")
  })

  it('offers the connect entry whether or not a session was just recorded', () => {
    expect(html).toContain('<button id="connect">Use with ChatGPT or claude.ai</button>')
    // Not one of the sections the popup switches between, so a finished recording never hides it.
    const switched = popup.match(/const name of \[([^\]]+)\]/)?.[1] ?? ''
    expect(switched).not.toContain('hosted')
    expect(html).toContain('<section class="hosted" id="hosted">')
  })

  it('opens the review page with no token in the URL — nothing left to expire', () => {
    expect(background).not.toContain('reviewUrl')
    expect(background).not.toMatch(/review\.html\?[^`]*token/)
  })

  /**
   * WO-015 T-015.1 — recording writes to the extension's own store, so "Douze can't reach its
   * background service" is a state that can no longer happen. A screen that cannot be reached is
   * worse than no screen: it is the one the popup would have shown on a perfectly healthy install.
   */
  it('shows only the states a daemon-free extension can be in', () => {
    const switched = popup.match(/const name of \[([^\]]+)\]/)?.[1] ?? ''
    expect(switched.replace(/['\s]/g, '').split(',')).toEqual([
      'unsupported',
      'ready',
      'watching',
      'finished',
    ])
    expect(html).not.toContain('id="disconnected"')
    expect(html).not.toContain('Douze.mcpb')
  })

  it('asks the worker what is set up here, rather than a daemon over loopback', () => {
    expect(popup).toContain("type: 'douze:site-tools'")
    expect(popup).not.toContain('daemon.js')
    expect(popup).not.toMatch(/127\.0\.0\.1|fetch\(/)
    expect(background).toContain("if (message.type === 'douze:site-tools')")
    expect(background).toContain('recipes\n    .surface()')
  })
})

describe('the review page', () => {
  const background = source('background.ts')
  const review = source('pages', 'review.ts')

  it('routes every review message to the session method that answers it', () => {
    for (const [command, call] of [
      ['douze:review:load', 'session.candidates()'],
      ['douze:review:edit', 'session.edit(command.name, command.field, command.value)'],
      ['douze:review:enable', 'session.approve(command.names)'],
      ['douze:review:disable', 'session.unapprove(command.names)'],
    ] as const) {
      expect(background).toContain(`command.type === '${command}'`)
      expect(background).toContain(call)
    }
    expect(background).toContain('await session.save()')
    expect(background).toContain("ReviewSession.open(sessionId, await openStores())")
  })

  it('talks to the worker rather than to a daemon', () => {
    expect(review).not.toContain("api('/api/review/")
    expect(review).not.toContain('fetch(')
    expect(review).toContain('chrome.runtime.sendMessage(command)')
  })

  it('pre-selects reads only, so one click never approves an unread delete', () => {
    expect(review).toContain('if (candidate.bulk_approvable) chosen.add(candidate.name)')
    expect(review).not.toContain('for (const candidate of state.candidates) chosen.add')
  })

  it('puts every user-supplied string through textContent, never innerHTML', () => {
    expect(review).not.toContain('innerHTML')
    expect(review).not.toContain('insertAdjacentHTML')
    // Real buttons and a label tied to its input, as studio's markup had them.
    const html = source('..', 'public', 'review.html')
    expect(html).not.toContain('<div role="button"')
    // Select all, Clear, the primary, and the one that goes back — every control is a real button.
    expect((html.match(/<button type="button"/g) ?? []).length).toBe(4)
    expect(review).toContain("el('label', { className: 'toggle' }")
    expect(review).toContain("setAttribute('aria-label'")
  })
})

describe('the connect page', () => {
  const html = source('..', 'public', 'connect.html')
  const connect = source('pages', 'connect.ts')
  const background = source('background.ts')

  /**
   * Every word, because each line names a party who sees the user's live dashboard data and there
   * is no other place in the product that says so.
   */
  it('keeps the trust disclosure verbatim', () => {
    for (const line of [
      'That link is the password. Anyone holding it can call these tools.',
      'The relay operator can read and inject every message that crosses it — your tool\n            arguments and full result bodies.',
      'The AI platform stores whatever your tools return, under its retention policy rather than yours.',
      'Those result bodies are live data from your dashboards, fetched from your account just now.',
    ]) {
      expect(html).toContain(line)
    }
    expect(html).toContain('<h2 class="section-heading">What you are trusting</h2>')
    // The scope line is the one that changes with `allow_writes`; both halves live in the page.
    expect(connect).toContain('Deleting is never possible from a hosted assistant — no flag, no exception.')
    expect(connect).toContain('Changing and deleting are never possible from a hosted assistant — no flag, no exception.')
  })

  it('confirms before it breaks a link someone is already using', () => {
    expect(connect).toContain('The link you have now stops working straight away')
    expect(connect).toContain('Every hosted assistant loses access immediately.')
    expect(html).toContain('<section class="confirm" id="confirm" hidden>')
  })

  it('falls back to selecting the link when there is no clipboard', () => {
    expect(connect).toContain('navigator.clipboard.writeText(field.value)')
    expect(connect).toContain('The link is selected — press Ctrl-C, or Cmd-C on a Mac, to copy it.')
  })

  it('is stubbed until T-015.10, and says so rather than half-doing it', () => {
    expect(background).toContain('NOT_CONNECTED_YET')
    expect(background).toContain("command.type === 'douze:connect:status'")
    for (const action of ['start', 'rotate', 'stop']) {
      expect(connect).toContain(`douze:connect:${action}`)
    }
  })
})
