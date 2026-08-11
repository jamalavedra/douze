import { describe, expect, it } from 'vitest'
import { DouzeError } from '@douze/shared'
import { explain, fromDaemon, relayUnreachable } from './errors.js'

describe('error translation (REQ-CON-004)', () => {
  it('states that the relay is not running and how to start it (AC-CON-004.1)', () => {
    const error = relayUnreachable('connect ECONNREFUSED')
    const text = explain(error)
    expect(text).toMatch(/isn't running/)
    // The reader is in a chat window: the fix has to be one they can perform from there, and it
    // cannot name one client — Douze runs its service inside whichever one they installed it in.
    expect(text).toMatch(/Quit the app you added Douze to and open it again/)
    expect(text).not.toContain('Claude')
    expect(text).not.toContain('douze start')
    // The cause is still recoverable, just not in the sentence.
    expect(text).not.toContain('ECONNREFUSED')
    expect(error.detail).toMatchObject({ cause: 'connect ECONNREFUSED' })
  })

  it('preserves the daemon wording for a disconnected extension (AC-CON-004.2)', () => {
    const error = fromDaemon(
      {
        error: 'extension_disconnected',
        message: 'The Douze Chrome extension is not connected, so "jira_list" cannot run against https://jira.test.',
        tool: 'jira_list',
        target: 'https://jira.test',
      },
      502,
      'jira_list',
    )
    expect(error.code).toBe('extension_disconnected')
    expect(explain(error)).toContain('jira_list')
    expect(explain(error)).toContain('https://jira.test')
  })

  it('names the target and tells the user to sign in (AC-CON-004.3)', () => {
    const error = fromDaemon(
      { error: 'session_expired', message: 'You have been signed out of jira.test. Sign in again in Chrome, then retry.' },
      502,
      'jira_list',
    )
    expect(error.code).toBe('session_expired')
    expect(explain(error)).toMatch(/sign in/i)
  })

  it('says no retry and no headless substitution happened (AC-CON-004.4)', () => {
    for (const code of ['relay_unreachable', 'extension_disconnected', 'session_expired'] as const) {
      const text = explain(new DouzeError(code, 'something went wrong'))
      expect(text).toMatch(/did not retry/)
    }
    expect(explain(new DouzeError('relay_unreachable', 'x'))).toMatch(/any other way/)
    expect(explain(new DouzeError('extension_disconnected', 'x'))).toMatch(/without the browser/)
  })

  it('turns an unrecognised daemon body into something a chat window can still read', () => {
    const error = fromDaemon({ error: 'unknown_tool', message: 'no tool "jira_list"' }, 404, 'jira_list')
    expect(error.code).toBe('relay_unreachable')
    expect(error.message).toContain('jira_list')
    expect(error.message).toContain('404')
  })

  it('keeps the structured detail from a timeout (AC-CON-003.2)', () => {
    const error = fromDaemon(
      { error: 'timeout', message: 'Tool "jira_list" was cancelled after 300s', tool: 'jira_list', elapsed_ms: 300_000 },
      502,
      'jira_list',
    )
    expect(error.code).toBe('timeout')
    expect(error.detail).toMatchObject({ tool: 'jira_list', elapsed_ms: 300_000 })
  })
})
