/**
 * Light or dark, chosen once and obeyed by every Douze surface.
 *
 * The whole mechanism is one attribute on `<html>`: page.css declares its palette through
 * `light-dark()`, which resolves against the computed `color-scheme`, so setting
 * `data-theme="dark"` flips every token at once. Nothing here knows a single colour.
 *
 * `localStorage`, not `chrome.storage`: it is synchronous, so the stored choice is applied while
 * the page is still parsing rather than a frame after it has painted the other scheme. MV3's CSP
 * forbids the inline script that would make even that impossible, so a page opened with an
 * override still repaints once — no override, no repaint, and the OS decides. Every extension
 * page shares one origin, so the popup and the three pages read and write the same value.
 */

type Theme = 'system' | 'light' | 'dark'

const KEY = 'douze:theme'
const CHOICES: readonly { value: Theme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

/**
 * A value written by a future version, or by anything else sharing this origin, is not trusted into
 * an attribute: an unknown one means "system", which is what a first-time reader gets.
 *
 * Exported so it can be tested for what it does rather than grepped for how it is written — the
 * rest of this module needs a DOM, and this is the part with a rule in it.
 */
export const themeFrom = (raw: string | null): Theme => (raw === 'light' || raw === 'dark' ? raw : 'system')

const stored = (): Theme => themeFrom(localStorage.getItem(KEY))

/** Called at import time by every page, before anything is drawn. */
export function applyTheme(theme: Theme = stored()): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.dataset['theme'] = theme
}

/**
 * The switch itself: three real buttons rather than a checkbox, because there are three states and
 * "system" is the one most people want and no toggle can express.
 */
export function mountThemeSwitch(host: HTMLElement | null): void {
  if (!host) return
  const group = document.createElement('div')
  group.className = 'segmented'
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', 'Colour scheme')

  const buttons = CHOICES.map(({ value, label }) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.addEventListener('click', () => {
      localStorage.setItem(KEY, value)
      applyTheme(value)
      draw(value)
    })
    group.append(button)
    return { value, button }
  })

  const draw = (current: Theme): void => {
    // `aria-pressed` is both the announcement and what page.css selects the current button on, so
    // there is no second copy of this state to drift.
    for (const { value, button } of buttons) button.setAttribute('aria-pressed', String(value === current))
  }

  draw(stored())
  host.append(group)
}
