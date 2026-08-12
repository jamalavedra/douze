import { describe, expect, it } from 'vitest'
import { WATCHED, worthWatching } from './oracle.js'

/**
 * The oracle had no test of any kind, which is how its filter came to contradict its own docblock
 * for two releases: the comment said it existed to catch service workers and `sendBeacon`, while
 * `types: ['xmlhttprequest']` excluded every beacon and every form submit. Both capture paths
 * missed those writes at once, silently.
 */
describe('what the completeness oracle watches', () => {
  it('covers the two kinds of write the MAIN-world patch cannot see', () => {
    // sendBeacon is reported as `ping`; a <form method="post"> submit is a navigation.
    expect(WATCHED).toContain('ping')
    expect(WATCHED).toContain('main_frame')
    expect(WATCHED).toContain('sub_frame')
    expect(WATCHED).toContain('xmlhttprequest')
  })

  it('takes a form POST but not the page load around it', () => {
    expect(worthWatching('main_frame', 'POST')).toBe(true)
    expect(worthWatching('sub_frame', 'post')).toBe(true)
    // Every page load in a recorded tab is a main_frame GET; recording those buries the session.
    expect(worthWatching('main_frame', 'GET')).toBe(false)
    expect(worthWatching('sub_frame', 'GET')).toBe(false)
  })

  it('takes every non-navigation regardless of method', () => {
    for (const type of ['xmlhttprequest', 'ping', 'other']) {
      expect(worthWatching(type, 'GET')).toBe(true)
      expect(worthWatching(type, 'POST')).toBe(true)
    }
  })
})
