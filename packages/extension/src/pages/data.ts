import type { AuditEntry } from '../guards.js'
import type { DataCommand, DataState } from '../messages.js'
import type { ExportedFile } from '../recipes.js'
import type { SessionSummary } from '../store.js'

/**
 * What Douze has stored on this computer, and the only way to get anything out of it or delete it.
 *
 * Three store methods reached nothing after the CLI was deleted: `importHar` (`douze import`),
 * `RecipeStore.exportAll`/`importFiles` (`douze export`/`import`), and — worst of the three —
 * `CaptureStore.deleteSession`. Recordings of signed-in dashboards accumulated in IndexedDB under
 * `unlimitedStorage` with no control anywhere that removed one.
 *
 * Two more joined them in the review round, and for the same reason. `RecipeStore.delete` had zero
 * callers, so a skill set built from a site the user had finished with stayed on the surface — and
 * on every attached assistant — for the life of the install; and the audit log, which is the record
 * of what somebody's assistants did in their accounts, could be written and never erased.
 *
 * A page of its own rather than a section on the other two: review.html is about one capture named
 * in its URL and connect.html is about one link, while everything here is about the whole set.
 *
 * Every user-supplied string reaches the DOM through `textContent`, and every command answers with
 * the whole `DataState`, so the page never infers what changed.
 */

let state: DataState = { sessions: [], recipes: [], calls: [] }
/** Files picked for import, kept only while a name conflict is on screen. */
let pending: ExportedFile[] = []
/**
 * Which delete button is armed — a delete has no undo, so every one of them takes two clicks and
 * the second one says what it does. One value, not one per list: arming a second thing disarms the
 * first, which is what stops a page of half-cocked delete buttons.
 */
let arming = ''

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const el = (tag: string, props: Record<string, unknown> = {}, children: (Node | string)[] = []): HTMLElement => {
  const node = Object.assign(document.createElement(tag), props)
  for (const child of children) node.append(child)
  return node
}
const fail = (sentence: string): void => {
  byId('error').textContent = sentence
}

async function send(command: DataCommand): Promise<DataState> {
  const answer = (await chrome.runtime.sendMessage(command)) as DataState | undefined
  if (!answer) throw new Error('Douze did not answer. Close this tab and open it again.')
  return answer
}

/** Runs one command and re-renders from what came back, or leaves the screen as it was. */
async function run(command: DataCommand, whenItFails: string): Promise<void> {
  try {
    fail('')
    state = await send(command)
    render()
    if (state.error) fail(state.error)
  } catch (error) {
    fail(`${whenItFails} ${(error instanceof Error && error.message) || 'Try again in a moment.'}`)
  }
}

const countPhrase = (count: number): string => (count === 1 ? '1 thing' : `${count} things`)

const when = (at: number): string => new Date(at).toLocaleString()

/**
 * Two clicks, and the second one says what it does. Every deletion on this page is permanent —
 * exchanges and response bodies from a site the user was signed into, or the skills built out of
 * them — so all three lists arm the same way rather than each inventing its own.
 */
function armedDelete(key: string, armedLabel: string, describe: string, act: () => void): HTMLElement {
  const armed = arming === key
  const button = el('button', {
    type: 'button',
    className: 'quiet danger',
    textContent: armed ? armedLabel : 'Delete',
  })
  button.setAttribute('aria-label', `${armed ? armedLabel : 'Delete'} ${describe}`)
  button.addEventListener('click', () => {
    if (!armed) {
      arming = key
      render()
      return
    }
    arming = ''
    act()
  })
  return button
}

function sessionItem(session: SessionSummary): HTMLElement {
  const remove = armedDelete(`session:${session.id}`, 'Delete for good', session.name, () => {
    void run({ type: 'douze:data:delete', sessionId: session.id }, "Couldn't delete that recording.")
  })

  const review = el('button', { type: 'button', className: 'quiet', textContent: 'Set up skills' })
  review.setAttribute('aria-label', `Set up skills from ${session.name}`)
  // The worker opens the tab, as it does for the popup: an extension page asking Chrome for a
  // permission loses whatever it queued behind the prompt.
  review.addEventListener('click', () => {
    void chrome.runtime.sendMessage({ type: 'douze:review', sessionId: session.id })
  })

  return el('li', {}, [
    el('p', { className: 'desc', textContent: session.name }),
    el('p', {
      className: 'meta',
      textContent: `${countPhrase(session.exchange_count)} · ${when(session.started_at)} · ${session.origins.join(', ')}`,
    }),
    el('div', { className: 'selection-actions' }, [review, remove]),
  ])
}

function renderSessions(): void {
  byId('recordings-empty').hidden = state.sessions.length > 0
  byId('sessions').replaceChildren(...state.sessions.map(sessionItem))
}

/**
 * `RecipeStore.delete` had no caller anywhere: a skill set built from a site the user no longer
 * uses stayed on the surface, and on every attached assistant, until the extension was removed.
 */
function recipeItem(recipe: DataState['recipes'][number]): HTMLElement {
  const remove = armedDelete(`recipe:${recipe.name}`, 'Delete for good', `the ${recipe.name} skills`, () => {
    void run({ type: 'douze:data:delete-recipe', name: recipe.name }, "Couldn't delete those skills.")
  })
  /**
   * The way an imported skill set becomes a used one. A file lands with nothing turned on — a file
   * is not a person reading a description, and only a person can approve — so this is the same
   * review page a recording goes to, opened on the recipe instead of a capture.
   */
  const review = el('button', { type: 'button', className: 'quiet', textContent: 'Set up skills' })
  review.setAttribute('aria-label', `Set up skills from ${recipe.name}`)
  review.addEventListener('click', () => {
    void chrome.runtime.sendMessage({ type: 'douze:review', sessionId: `recipe:${recipe.name}` })
  })
  return el('li', {}, [
    el('p', { className: 'desc', textContent: recipe.name }),
    el('p', {
      className: 'meta',
      textContent:
        arming === `recipe:${recipe.name}`
          ? `Deleting these stops your assistants using ${recipe.name}. The example answers go too, and the recording they came from stays.`
          : recipe.tools === 0
            ? 'Nothing turned on yet — open it to choose what to keep.'
            : `${recipe.tools} in use`,
    }),
    el('div', { className: 'selection-actions' }, [review, remove]),
  ])
}

function renderRecipes(): void {
  byId('recipes-empty').hidden = state.recipes.length > 0
  byId('recipes').replaceChildren(...state.recipes.map(recipeItem))
}

/** AC-EXE-003.3 — the audit log, listed on the page that says what is stored, and clearable. */
function callItem(call: AuditEntry): HTMLElement {
  return el('li', {}, [
    el('p', { className: 'desc', textContent: call.tool }),
    el('p', {
      className: 'meta',
      textContent: `${call.outcome === 'ok' ? 'Worked' : call.outcome} · ${when(Date.parse(call.at))} · ${
        call.trust === 'local' ? 'an app on this computer' : 'a hosted assistant'
      }`,
    }),
  ])
}

function renderCalls(): void {
  byId('calls-empty').hidden = state.calls.length > 0
  byId('calls').replaceChildren(...state.calls.map(callItem))
  const clear = byId<HTMLButtonElement>('clear-audit')
  clear.disabled = state.calls.length === 0
  clear.textContent = arming === 'audit' ? 'Clear for good' : 'Clear'
}

/**
 * The import report, refusals and all. `imported` on its own is the dishonest version of this
 * screen: `refused` exists precisely so a file that was half-rejected cannot be reported as if it
 * had all landed, so every refused entry is listed with its address and its reason.
 */
function renderHar(): void {
  const report = state.har
  byId('har-report').hidden = report === undefined
  if (!report) return
  const refused = report.refused
  byId('har-summary').textContent =
    `Imported ${countPhrase(report.imported)}. ${report.skipped} skipped as noise or not readable, ` +
    `${refused.length} refused.`
  byId('har-refused-copy').hidden = refused.length === 0
  byId('har-refused').replaceChildren(
    ...refused.map((entry) =>
      el('li', {}, [
        el('p', { className: 'name', textContent: entry.url }),
        el('p', { className: 'warn', textContent: entry.reason }),
      ]),
    ),
  )
  const review = byId<HTMLButtonElement>('har-review')
  review.hidden = report.imported === 0
  review.onclick = (): void => {
    void chrome.runtime.sendMessage({ type: 'douze:review', sessionId: report.session_id })
  }
}

function renderImport(): void {
  const report = state.imported
  const conflicts = report?.conflicts ?? []
  byId('conflict').hidden = conflicts.length === 0
  byId('conflict-copy').textContent =
    `Douze already has ${conflicts.join(', ')}. Nothing was changed. Replacing means the skills ` +
    `you have under ${conflicts.length === 1 ? 'that name' : 'those names'} are overwritten by the file.`
  const line = byId('import-report')
  line.hidden = report === undefined || conflicts.length > 0
  if (!report) return
  // Nothing an import brings is turned on, however the file was marked — say so here rather than
  // let "Added x" read as "x is live", which is what it used to mean and no longer does.
  line.textContent = report.ok
    ? `Added ${report.imported.join(', ') || 'nothing'}${report.fixtures.length > 0 ? `, with ${report.fixtures.length} example answers` : ''}. ` +
      `Nothing is turned on yet — choose "Set up skills" below to read what each one does.`
    : report.errors.join(' ')
}

function render(): void {
  renderSessions()
  renderRecipes()
  renderCalls()
  renderHar()
  renderImport()
}

// --- what the assistants did ----------------------------------------------

byId('clear-audit').addEventListener('click', () => {
  if (arming !== 'audit') {
    arming = 'audit'
    render()
    return
  }
  arming = ''
  void run({ type: 'douze:data:clear-audit' }, "Couldn't clear the record.")
})

// --- importing a .har ------------------------------------------------------

byId('har-import').addEventListener('click', async () => {
  const file = byId<HTMLInputElement>('har-file').files?.[0]
  if (!file) return fail('Choose a .har file first.')
  const name = byId<HTMLInputElement>('har-name').value.trim() || file.name.replace(/\.har$/i, '')
  let har: unknown
  try {
    har = JSON.parse(await file.text())
  } catch {
    return fail(`"${file.name}" is not a file Douze can read. Save it again from Chrome's Network panel.`)
  }
  await run({ type: 'douze:data:import-har', name, har }, "Couldn't import that file.")
  return undefined
})

// --- skills in and out -----------------------------------------------------

/** Everything `exportAll()` returned, in one file that `importFiles` takes straight back. */
const EXPORT_NAME = 'douze-skills.json'

byId('export').addEventListener('click', async () => {
  await run({ type: 'douze:data:export' }, "Couldn't save your skills.")
  const files = state.files ?? []
  if (files.length === 0) return fail('There are no skills to save yet.')
  const url = URL.createObjectURL(new Blob([JSON.stringify(files, null, 2)], { type: 'application/json' }))
  const anchor = el('a', { href: url, download: EXPORT_NAME })
  anchor.click()
  URL.revokeObjectURL(url)
  return undefined
})

const isExportedFile = (value: unknown): value is ExportedFile =>
  typeof (value as ExportedFile)?.path === 'string' && typeof (value as ExportedFile)?.content === 'string'

/**
 * A file saved by the button above carries the paths the store keys on (`recipes/x.yaml`,
 * `fixtures/x/y.json`), so it is unwrapped rather than treated as one big fixture. Anything else
 * is passed through under its own name, which is how a recipe .yaml written by hand imports.
 */
async function chosenFiles(input: HTMLInputElement): Promise<ExportedFile[]> {
  const read = await Promise.all(
    [...(input.files ?? [])].map(async (file) => ({ path: file.name, content: await file.text() })),
  )
  const only = read.length === 1 ? read[0] : undefined
  if (only) {
    try {
      const parsed = JSON.parse(only.content) as unknown
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(isExportedFile)) return parsed
    } catch {
      // Not JSON at all, so it is a .yaml recipe: it goes through as itself.
    }
  }
  return read
}

byId('import').addEventListener('click', async () => {
  pending = await chosenFiles(byId<HTMLInputElement>('skills-file'))
  if (pending.length === 0) return fail('Choose a file first.')
  await run({ type: 'douze:data:import', files: pending }, "Couldn't add those skills.")
  return undefined
})

// AC-REC-003 — the conflict is resolved by the reader, by name, and never silently.
byId('conflict-yes').addEventListener('click', () => {
  void run({ type: 'douze:data:import', files: pending, overwrite: true }, "Couldn't replace those skills.")
})

byId('conflict-no').addEventListener('click', () => {
  const { imported: _dropped, ...rest } = state
  state = rest
  render()
})

void run({ type: 'douze:data:list' }, "Couldn't read what Douze has stored.")
