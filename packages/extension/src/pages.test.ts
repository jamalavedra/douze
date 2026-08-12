import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import config from '../vite.config.js'
import { themeFrom } from './pages/theme.js'

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

/**
 * Markup with every run of whitespace collapsed, for the assertions that pin PROSE. What those
 * guard is that a sentence is still on the page and still says what it said; where the formatter
 * chose to wrap it is not part of the promise, and pinning it made moving a paragraph into a
 * disclosure — one level deeper, so two more spaces — look like deleting the disclosure itself.
 */
const prose = (...parts: string[]): string => source(...parts).replace(/\s+/g, ' ')

describe('the extension build', () => {
  const input = (config as { build: { rollupOptions: { input: Record<string, string> } } }).build.rollupOptions
    .input

  it('emits an entry module for all four pages', () => {
    expect(Object.keys(input).sort()).toEqual([
      'background',
      'bridge',
      'connect',
      'data',
      'interceptor',
      'popup',
      'review',
    ])
    expect(input['popup']).toMatch(/src\/popup\.ts$/)
    expect(input['review']).toMatch(/src\/pages\/review\.ts$/)
    expect(input['connect']).toMatch(/src\/pages\/connect\.ts$/)
    expect(input['data']).toMatch(/src\/pages\/data\.ts$/)
  })

  it('gives each page an HTML file that loads its bundle by the name rollup writes', () => {
    for (const [page, script] of [
      ['popup', 'popup.js'],
      ['review', 'review.js'],
      ['connect', 'connect.js'],
      ['data', 'data.js'],
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

  it('shares one stylesheet between the full-page views', () => {
    for (const page of ['review', 'connect', 'data'] as const) {
      expect(source('..', 'public', `${page}.html`)).toContain('href="page.css"')
    }
  })
})

/**
 * The one thing a rewrite of these HTML files can break that nothing else here would notice: a
 * script looks an element up by id, the markup no longer has it, and `byId` hands back null —
 * so the page throws on load, or a control silently does nothing. Every other test in this file
 * asserts on source strings, which is exactly the wrong shape to catch a dropped attribute.
 *
 * No jsdom needed: the ids a script asks for and the ids a document defines are both readable as
 * text. Template-literal lookups (`exposed-${trust}`) cannot be resolved statically and are not
 * matched; the two that exist are covered by name in the connect page's own tests.
 */
describe('every page can find the elements its script looks up', () => {
  const LOOKUP = /(?:\bbyId|\$)(?:<[^>]*>)?\(['"]([\w-]+)['"]\)|getElementById\(['"]([\w-]+)['"]\)/g

  for (const [script, page] of [
    ['popup.ts', 'popup.html'],
    ['pages/connect.ts', 'connect.html'],
    ['pages/data.ts', 'data.html'],
    ['pages/review.ts', 'review.html'],
  ] as const) {
    it(`${script} against ${page}`, () => {
      const html = source('..', 'public', page)
      const defined = [...html.matchAll(/\bid="([\w-]+)"/g)].map(([, id]) => id)
      const wanted = [...source(script).matchAll(LOOKUP)].map(([, a, b]) => a ?? b)

      expect(wanted.length).toBeGreaterThan(5)
      expect(wanted.filter((id) => !defined.includes(id))).toEqual([])
      // Two elements sharing an id makes getElementById a coin toss between them.
      expect(defined.filter((id, at) => defined.indexOf(id) !== at)).toEqual([])
    })
  }
})

/**
 * The theme is one attribute on <html> and one stylesheet that reads it, so what can actually
 * break is the wiring: a page that forgets to apply the stored choice paints the other scheme,
 * and a settings panel with no switch in it is a preference nobody can change.
 */
describe('light and dark', () => {
  const theme = source('pages', 'theme.ts')
  const css = source('..', 'public', 'page.css')

  it('lets the stylesheet do the work — one attribute, no colours in the module', () => {
    expect(css).toMatch(/\[data-theme="light"\][^}]*color-scheme: light/)
    expect(css).toMatch(/\[data-theme="dark"\][^}]*color-scheme: dark/)
    expect(css).toMatch(/color-scheme: light dark/)
    // Every colour is one light-dark() pair, so a scheme cannot be half-applied.
    expect(theme).not.toMatch(/#[0-9a-f]{3,6}\b/i)
  })

  it('is applied by every page, and switchable from every page that has settings', () => {
    for (const page of ['popup', 'pages/connect', 'pages/data', 'pages/review'] as const) {
      expect(source(`${page}.ts`)).toContain('applyTheme()')
    }
    // Review is opened for one capture and has no settings panel; the other three carry the switch.
    for (const [page, html] of [
      ['popup', 'popup.html'],
      ['pages/connect', 'connect.html'],
      ['pages/data', 'data.html'],
    ] as const) {
      expect(source(`${page}.ts`)).toContain("mountThemeSwitch(document.getElementById('theme'))")
      expect(source('..', 'public', html)).toContain('id="theme"')
    }
    expect(source('pages/review.ts')).not.toContain('mountThemeSwitch')
  })

  /** Shared origin, so anything on it can write the key; an unknown value must not reach the DOM. */
  it('falls back to the system scheme rather than trusting whatever is in storage', () => {
    expect(themeFrom('light')).toBe('light')
    expect(themeFrom('dark')).toBe('dark')
    for (const hostile of [null, '', 'System', 'DARK', 'light ', 'x', '__proto__']) {
      expect(themeFrom(hostile)).toBe('system')
    }
    // "system" is the absence of the attribute, not a third value written into it.
    expect(theme).toMatch(/'system'.*removeAttribute\('data-theme'\)/s)
  })
})

/**
 * WO-015 review round — `importHar`, `RecipeStore.exportAll`/`importFiles` and
 * `CaptureStore.deleteSession` were ported, unit-tested, and then reachable from nothing: no
 * message, no control, no page. The CLI that used to call them was deleted with no replacement.
 * These pin the wiring; `background.test.ts` drives the routes themselves.
 */
describe('the data page', () => {
  const html = source('..', 'public', 'data.html')
  const data = source('pages', 'data.ts')
  const background = source('background.ts')
  const popup = source('popup.ts')

  it('reaches every store method the CLI used to be the only caller of', () => {
    for (const [command, call] of [
      ['douze:data:list', 'await captures.sessions()'],
      ['douze:data:delete', 'captures.deleteSession(command.sessionId)'],
      ['douze:data:delete-recipe', 'recipes.delete(command.name)'],
      ['douze:data:clear-audit', 'await clearCalls()'],
      ['douze:data:import-har', 'importHar(command.har, command.name, captures)'],
      ['douze:data:export', 'await recipes.exportAll()'],
      ['douze:data:import', 'recipes.importFiles(command.files'],
    ] as const) {
      expect(data).toContain(command)
      expect(background).toContain(call)
    }
    expect(background).toContain("if (message.type.startsWith('douze:data:'))")
  })

  /**
   * The audit log is stored on this computer until the extension is removed, so it belongs on the
   * page that lists what is stored — and it had no reader and no eraser anywhere before this.
   */
  it('lists what the assistants ran and offers the only thing that erases it', () => {
    expect(background).toContain('calls: await recentCalls()')
    expect(data).toContain("byId('calls').replaceChildren")
    expect(html).toContain('<h2 class="section-heading">What your assistants have done</h2>')
    expect(html).toContain('<button type="button" class="quiet danger" id="clear-audit">Clear</button>')
    // The audit deliberately holds no arguments and no results, and the page says so rather than
    // letting a reader assume this is a transcript.
    expect(html).toContain('What it was asked for and what came back are not recorded.')
  })

  /**
   * `imported` on its own is the dishonest report: `refused[]` exists so a file the write gate
   * partly rejected cannot be shown as if it had all landed. Every refusal is listed with its
   * address and the reason the gate gave.
   */
  it('shows every refused entry rather than only counting it', () => {
    expect(data).toContain('const refused = report.refused')
    expect(data).toContain("el('p', { className: 'warn', textContent: entry.reason })")
    expect(prose('..', 'public', 'data.html')).toContain('still carried something that looks like a credential')
  })

  it('offers overwrite by name when an import collides, and changes nothing until asked', () => {
    expect(data).toContain('report?.conflicts ?? []')
    expect(data).toContain('Douze already has ${conflicts.join(\', \')}. Nothing was changed.')
    expect(data).toContain("{ type: 'douze:data:import', files: pending, overwrite: true }")
    expect(html).toContain('<button type="button" class="primary" id="conflict-yes">Replace them</button>')
  })

  it('takes two clicks to delete anything, and says what the second one does', () => {
    expect(data).toContain("textContent: armed ? armedLabel : 'Delete'")
    expect(data).toContain("{ type: 'douze:data:delete', sessionId: session.id }")
    expect(data).toContain("{ type: 'douze:data:delete-recipe', name: recipe.name }")
    // One armed key for the whole page: arming a second delete disarms the first.
    expect(data).toContain('arming = key')
    expect(data).toContain("arming !== 'audit'")
  })

  /**
   * Deleting a recipe takes the tools with it off every attached assistant, and the wording says
   * so before the second click rather than after it.
   */
  it('says what deleting a skill set breaks before it happens', () => {
    expect(data).toContain('stops your assistants using ${recipe.name}')
    expect(data).toContain('the recording they came from stays')
  })

  it('is opened through the worker from the popup, like the other two pages', () => {
    expect(popup).toContain("chrome.runtime.sendMessage({ type: 'douze:data' })")
    expect(popup).not.toContain('tabs.create')
    expect(background).toContain("if (message.type === 'douze:data')")
    expect(background).toContain("chrome.runtime.getURL('data.html')")
  })

  it('puts every user-supplied string through textContent, never innerHTML', () => {
    expect(data).not.toContain('innerHTML')
    expect(data).not.toContain('insertAdjacentHTML')
    expect(html).not.toContain('<div role="button"')
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
    // The element type is part of the promise, not just the id and the label: a div with a click
    // handler is not reachable by keyboard, and the looser assertion let one through.
    expect(html).toContain('<button type="button" class="quiet" id="connect">Use with your AI</button>')
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
    expect(background).toContain('ReviewSession.open(sessionId, stores)')
    // Re-inferred on `load` when the capture has grown since — a review opened mid-recording
    // otherwise shows the candidate set as it was when the page was first opened.
    expect(background).toContain("reviewSession(command.sessionId, command.type === 'douze:review:load')")
  })

  it('talks to the worker rather than to a daemon', () => {
    expect(review).not.toContain("api('/api/review/")
    expect(review).not.toContain('fetch(')
    expect(review).toContain('chrome.runtime.sendMessage(command)')
  })

  /**
   * This is the screen where consent actually happens, and it used to show the sample exchange
   * behind a collapsed "Details" without ever saying the body is kept as a fixture or that live
   * results go on to whichever assistant is attached. The connect page's disclosure is on a page
   * a consumer may never open.
   */
  it('says what approving keeps and what it sends, above the list', () => {
    const html = source('..', 'public', 'review.html')
    expect(html).toContain(
      'Turning a skill on keeps one complete example answer from this site in this browser, and\n        sends live answers to whichever assistant you connect.',
    )
    // Above the candidates, not inside a disclosure below them.
    expect(html.indexOf('id="keeps"')).toBeLessThan(html.indexOf('id="groups"'))
    expect(review).toContain("byId('keeps').hidden = false")
  })

  /**
   * Everything is selected, including writes and deletes. Reads-only was the safer default and made
   * the common case wrong — nobody records a dashboard in order to approve half of it. What keeps a
   * pre-ticked delete from being a deleted thing is enforcement, not a tick box: `checkPolicy`
   * refuses a destructive tool for a hosted assistant with no setting that changes it, and refuses
   * one locally unless the call carries `confirm: true`.
   */
  it('selects everything, and leans on enforcement rather than the tick box', () => {
    expect(review).toContain('for (const candidate of state.candidates) chosen.add(candidate.name)')
    expect(review).toContain('Turn off anything you would rather it could not do')
    // The guarantees that make that safe have to still be there.
    const guards = source('guards.ts')
    expect(guards).toContain("if (trust === 'remote' && effect === 'destructive')")
    expect(guards).toContain("if (effect === 'destructive' && args['confirm'] !== true)")
  })

  /**
   * WO-016 — which group a skill lands in is decided by matching words in its name, and the reader
   * looking at the list is the only one who can see when that is wrong. The control goes through
   * the same `douze:review:edit` route the name and the description already use.
   */
  it('lets the reader move a skill between the two groups that change things', () => {
    expect(review).toContain("field: 'side_effect'")
    expect(review).toContain("['write', 'Makes changes to your account']")
    expect(review).toContain('[\'destructive\', "Removes things')
    // Never back to "Look things up": read is the one class a hosted assistant reaches with
    // nothing turned on, so offering it would be the single move that widens what it may do.
    const choices = review.match(/const CONSEQUENCES = \[([\s\S]*?)\] as const/)?.[1] ?? ''
    expect(choices).toContain("'write'")
    expect(choices).toContain("'destructive'")
    expect(choices).not.toContain("'read'")
    expect(review).toContain("candidate.side_effect === 'read' ? [] : [consequencePicker(candidate)]")
    // The list is redrawn from the worker's answer, so the skill visibly moves group.
    expect(review).toContain('select.value = candidate.side_effect')
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
  const words = prose('..', 'public', 'connect.html')
  const connect = source('pages', 'connect.ts')
  const background = source('background.ts')

  /**
   * Every word, because each line names a party who sees the user's live dashboard data and there
   * is no other place in the product that says so.
   */
  it('keeps the trust disclosure verbatim', () => {
    for (const line of [
      'That link is the password. Anyone holding it can call these tools.',
      // Wrapped over two lines in the markup, so it is matched on its words like its neighbours:
      // pinning the indentation here would fail the day the paragraph moves, for no reason a
      // reader of this test would recognise as a broken promise.
      'The relay operator can read and inject every message that crosses it — your tool arguments and full result bodies.',
      'The AI platform stores whatever your tools return, under its retention policy rather than yours.',
      'Those result bodies are live data from your dashboards, fetched from your account just now.',
    ]) {
      expect(words).toContain(line)
    }
    expect(html).toContain('<h2 class="section-heading">What you are trusting</h2>')
    // The scope line is the one that changes with `allow_writes`; both halves live in the page.
    expect(connect).toContain('Deleting is never possible from a hosted assistant — no flag, no exception.')
    expect(connect).toContain('Changing and deleting are never possible from a hosted assistant — no flag, no exception.')
  })

  it('confirms before it breaks a link someone is already using', () => {
    expect(connect).toContain('The link you have now stops working straight away')
    expect(connect).toContain('Every hosted assistant loses access immediately.')
    expect(html).toContain('<dialog class="confirm" id="confirm">')
  })

  /**
   * WO-016 — it was exactly backwards: rotate and stop, both undoable in one click, went through
   * the dialog, while the two grants nobody can take back afterwards fired on the first click.
   *
   * Each grant is reachable ONLY as the `command` of a spec the dialog runs, so declining — or
   * pressing Esc — sends nothing. Withdrawing either one stays a single click.
   */
  it('confirms the two grants that cannot be taken back, and only those', () => {
    expect(connect).toContain('confirm(allowWrites())')
    expect(connect).toContain("command: { type: 'douze:connect:writes', allow: true }")
    expect(connect).toContain('confirm(allowRemoteResults(tool))')
    expect(connect).toContain("command: { type: 'douze:connect:expose', trust: 'remote', tool, allow: true }")
    // The old handler sent the grant straight from the click, whichever way it was going.
    expect(connect).not.toContain('allow: !state.allow_writes')
    // Only the pending spec's command is ever run from the dialog.
    expect(connect).toContain('void run(spec.command,')
    // Taking access away is still one click, and so is the local exemption: it hands a value to an
    // app the user paired by hand, not to a relay operator and a model provider.
    expect(connect).toContain("{ type: 'douze:connect:writes', allow: false }")
    expect(connect).toContain("void run({ type: 'douze:connect:expose', trust, tool, allow: true }")
  })

  /**
   * The words in the dialog are the page's own disclosure, not a second account of the same thing
   * written to sound serious. Both halves of the scope line are shared with `render`.
   */
  it('grants in the same words the page discloses in', () => {
    expect(connect).toContain('`Allow changes too? ${WRITES_STATE.on} ${SCOPE.on}')
    expect(connect).toContain('byId(\'scope\').textContent = state.allow_writes ? SCOPE.on : SCOPE.off')
    for (const line of [
      'something shaped like a password, key or token',
      'read and inject every message that crosses it',
      'under its retention policy rather than yours',
    ]) {
      expect(connect).toContain(line)
    }
    expect(html).toContain('shaped like a password, key or token')
  })

  /**
   * The dialog guards a control outside the link section — the secret-gate grant is on screen
   * before anything is connected — so it cannot live inside the half of the page that hides itself.
   */
  it('puts the dialog where every control that opens it can be seen', () => {
    expect(html.indexOf('<dialog class="confirm"')).toBeGreaterThan(html.indexOf('id="exposed"'))
    expect(connect).toContain('dialog.showModal()')
    // Esc and the backdrop close it without running the button, so pending is dropped on close.
    expect(connect).toContain("dialog.addEventListener('close'")
  })

  /**
   * Pairing was one-way: an app paired once kept `local` trust — every write and every destructive
   * tool — for the life of the install, with nothing on this page or anywhere else that withdrew
   * it. Behind the same confirm as the other two irreversible actions.
   */
  it('can withdraw a pairing as well as grant one', () => {
    expect(connect).toContain("command: { type: 'douze:connect:unpair' }")
    expect(connect).toContain('It loses every tool straight away, the ones that delete included.')
    expect(background).toContain('await attachments.unpair()')
    expect(html).toContain('<button type="button" class="quiet danger" id="unpair">Unpair</button>')
  })

  /**
   * The apps this page calls "on this computer" are Claude Code, Cursor and Claude Desktop, which
   * are AI clients themselves: "everything stays on your computer" is true of Douze and not of
   * what happens next, and only this page and the README are in a position to say so.
   */
  it('says that an app on this computer is still an assistant with a provider', () => {
    expect(html).toContain('On this computer is not the same as staying on this computer.')
    expect(words).toContain('goes on to their own model provider')
  })

  /** "Whoever runs it can read everything" is not actionable until the reader knows who that is. */
  it('names who runs the relay it offers by default', () => {
    expect(words).toContain('run by Jaume Alavedra, who wrote Douze, on a personal server')
    expect(background).toContain('It is run by Jaume Alavedra, who wrote Douze, on a')
  })

  it('falls back to selecting the link when there is no clipboard', () => {
    expect(connect).toContain('navigator.clipboard.writeText(field.value)')
    expect(connect).toContain('The link is selected — press Ctrl-C, or Cmd-C on a Mac, to copy it.')
  })

  /**
   * WO-015 T-015.10 — the no-terminal path, end to end on one page: every control the CLI's
   * `douze connect` had is here, and nothing is left saying "not wired up yet".
   */
  it('mints, rotates and retires the link from the page itself', () => {
    for (const action of ['start', 'rotate', 'stop', 'writes', 'pair', 'expose', 'status']) {
      expect(connect).toContain(`douze:connect:${action}`)
    }
    expect(background).not.toContain('NOT_CONNECTED_YET')
    expect(background).toContain("command.type === 'douze:connect:start'")
    expect(background).toContain("relayFetch(base, '/register', {")
    expect(background).toContain("relayFetch(relay.url, '/rotate', { method: 'POST', token: relay.token })")
    expect(background).toContain("relayFetch(relay.url, '/register', { method: 'DELETE', token: relay.token })")
    // The page asks Chrome for the relay's origin itself: a worker `fetch` has no gesture to spend.
    expect(connect).toContain('chrome.permissions.request({ origins: [`${origin}/*`] })')
  })

  /** The page never opens a socket or writes storage: the worker owns both, as with review. */
  it('talks to the worker rather than to a relay', () => {
    expect(connect).not.toContain('fetch(')
    expect(connect).not.toContain('WebSocket')
    expect(connect).not.toContain('chrome.storage')
    expect(connect).toContain('chrome.runtime.sendMessage(command)')
  })

  it('renders every state it is told about, and says so when it is not told', () => {
    // Connected, and the honest version of not-connected: the link outlives the socket.
    expect(connect).toContain('Shared, and Douze has a live connection right now.')
    expect(connect).toContain('Shared, but Douze has no connection at the moment.')
    expect(connect).toContain('Not shared with anything yet.')
    // The write opt-in reads out what it currently means, not just what the button would do.
    expect(connect).toContain('Nothing a hosted assistant sends can change anything.')
    expect(connect).toContain('Go back to read-only')
    // Four bridge states, including the two that are neither paired nor unpaired.
    expect(connect).toContain("trying: 'Douze has your code and is trying to pair.")
    expect(connect).toContain("refused: 'The last code was refused.")
    // An empty surface is said out loud rather than drawn as a box that does nothing.
    expect(connect).toContain("byId('expose-empty').hidden = !none")
    expect(html).toContain('Douze has no tools set up yet, so there is nothing to allow.')
  })

  it('keeps the two trust levels apart in the exemption control', () => {
    expect(html).toContain('<ul class="steps" id="exposed-local"></ul>')
    expect(html).toContain('<ul class="steps" id="exposed-remote"></ul>')
    expect(html).toContain('<button type="button" class="quiet" id="expose-local">')
    expect(html).toContain('<button type="button" class="quiet" id="expose-remote">')
    expect(html).toContain(
      'not start sending that value to whoever runs the relay',
    )
    // One list per level, drawn from that level's own array — never a merged one.
    expect(connect).toContain('const tools = state.exposed[trust]')
    expect(connect).not.toContain('...state.exposed.local')
  })

  it('explains why a local app has to be paired at all', () => {
    expect(html).toContain('typing it in is you saying yes')
    expect(html).toContain('<input class="field" id="pair-code"')
    expect(connect).toContain("{ type: 'douze:connect:pair', code }")
  })

  it('puts every user-supplied string through textContent, never innerHTML', () => {
    expect(connect).not.toContain('innerHTML')
    expect(connect).not.toContain('insertAdjacentHTML')
    expect(connect).toContain("remove.textContent = 'Stop allowing'")
    expect(html).not.toContain('<div role="button"')
    expect(html).not.toContain('<a href="#"')
  })
})
