import { test, expect } from '@playwright/test'
import { launchHelium } from './harness.js'

/**
 * The consent control, rendered. It is collapsed by default — a panel that shouts at every reader of
 * every recording is one they learn to skip — and the token has to stay inside its row: a bearer is
 * one unbroken 100-character string and ran straight out of the box before `overflow-wrap`.
 */
test('the consent panel is collapsed and stays inside its box', async () => {
  const browser = await launchHelium()
  const tab = await browser.context.newPage()
  await tab.goto(`chrome-extension://${browser.extensionId}/review.html?session=x`)
  const value =
    'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
  // Drive the panel directly: the page's own state comes from a worker with no such capture.
  await tab.evaluate((v) => {
    const details = document.getElementById('credentials') as HTMLDetailsElement
    details.hidden = false
    document.getElementById('credentials-summary')!.textContent =
      'This site needs a token Douze cannot look up — decide about authorization'
    document.getElementById('pending')!.innerHTML =
      `<li><p class="desc">authorization on https://x.com</p><p class="name">${v}</p>` +
      `<div class="decide"><button class="primary">Keep it for this site</button>` +
      `<button class="quiet">Don't keep it</button></div></li>`
    return details.open
  }, value)

  const collapsed = await tab.evaluate(() => (document.getElementById('credentials') as HTMLDetailsElement).open)
  expect(collapsed).toBe(false)
  await tab.setViewportSize({ width: 420, height: 900 })
  await tab.screenshot({ path: test.info().outputPath('consent-collapsed.png'), fullPage: true })

  await tab.evaluate(() => ((document.getElementById('credentials') as HTMLDetailsElement).open = true))
  await tab.waitForTimeout(300)
  // The token must not escape its row.
  const overflow = await tab.evaluate(() => {
    const row = document.querySelector('#pending .name') as HTMLElement
    const box = document.getElementById('credentials') as HTMLElement
    return { value: row.getBoundingClientRect().right, panel: box.getBoundingClientRect().right }
  })
  expect(overflow.value).toBeLessThanOrEqual(overflow.panel)
  await tab.screenshot({ path: test.info().outputPath('consent-open.png'), fullPage: true })

  // --- a skill description written from the recorded site --------------------
  /**
   * X names its endpoints `/i/api/graphql/vrauE07yHNM5LYI2WBJ7lA/CommunitiesFetchOneQuery`, which is
   * one unbreakable 60-character word inside a grid track. It sized the `1fr` column, pushed every
   * card past the 600px page and gave the whole review a horizontal scrollbar with the text cut off.
   */
  await tab.evaluate(() => {
    document.getElementById('groups')!.innerHTML =
      '<section class="group"><ul><li class="skill"><div class="head">' +
      '<label class="toggle"><input type="checkbox" checked /></label>' +
      '<div class="skill-copy"><p class="desc">Lists CommunitiesFetchOneQueries from ' +
      '/i/api/graphql/vrauE07yHNM5LYI2WBJ7lA/CommunitiesFetchOneQuery. Returns the ' +
      'CommunitiesFetchOneQuery with __typename, actions, admin_results, created_at.</p>' +
      '<p class="full-desc">Payload at `$.data.xpayments_audience_reward_eligibility_status`.</p>' +
      '</div></div></li></ul></section>'
  })
  await tab.waitForTimeout(200)
  const laidOut = await tab.evaluate(() => ({
    // The page must not be wider than the window: that is the scrollbar the user saw.
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    card: (document.querySelector('.skill') as HTMLElement).getBoundingClientRect().right,
    main: (document.querySelector('main') as HTMLElement).getBoundingClientRect().right,
  }))
  expect(laidOut.scroll).toBeLessThanOrEqual(laidOut.client)
  expect(laidOut.card).toBeLessThanOrEqual(laidOut.main + 1)
  await tab.screenshot({ path: test.info().outputPath('skills-wrapped.png'), fullPage: true })

  await browser.dispose()
})
