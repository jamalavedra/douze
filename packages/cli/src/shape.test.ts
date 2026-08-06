import { describe, expect, it } from 'vitest'
import { MAX_RESULT_BYTES, MISSING, selectPath, shapeResult } from './shape.js'

describe('primary payload path (AC-RUN-004.1)', () => {
  const body = { meta: { page: 1 }, data: { orders: [{ id: 'o-1' }, { id: 'o-2' }] } }

  it('returns the subtree the recipe points at', () => {
    expect(shapeResult(body, { primary_payload_path: '$.data.orders' }).data).toEqual([
      { id: 'o-1' },
      { id: 'o-2' },
    ])
  })

  it('accepts an unrooted dot path and array indices', () => {
    expect(selectPath(body, 'data.orders[1].id')).toBe('o-2')
    expect(selectPath(body, "$['data']['orders'][0]['id']")).toBe('o-1')
  })

  it('returns the whole body when raw is set', () => {
    expect(shapeResult(body, { primary_payload_path: '$.data.orders', raw: true }).data).toEqual(body)
  })

  it('falls back to the full body and says so when the path no longer resolves', () => {
    const shaped = shapeResult(body, { primary_payload_path: '$.data.invoices' })
    expect(shaped.data).toEqual(body)
    expect(shaped.note).toContain('did not resolve')
  })

  it('reports a missing path distinctly from a null value', () => {
    expect(selectPath({ a: null }, 'a')).toBeNull()
    expect(selectPath({ a: null }, 'a.b')).toBe(MISSING)
    expect(selectPath({ a: [1] }, 'a.5')).toBe(MISSING)
  })
})

describe('truncation (AC-RUN-004.2)', () => {
  it('leaves a result under the cap untouched', () => {
    const shaped = shapeResult({ items: 'x'.repeat(1000) })
    expect(shaped.truncated).toBeUndefined()
  })

  it('truncates, states that it truncated, and reports the untrimmed size', () => {
    const big = { items: 'x'.repeat(40 * 1024) }
    const untrimmed = Buffer.byteLength(JSON.stringify(big), 'utf8')
    const shaped = shapeResult(big)

    expect(shaped.truncated).toBeDefined()
    expect(shaped.truncated?.untrimmed_bytes).toBe(untrimmed)
    expect(shaped.truncated?.message).toMatch(/truncated/i)
    expect(shaped.truncated?.message).toContain(String(untrimmed))
    expect(shaped.truncated?.returned_bytes).toBeLessThanOrEqual(MAX_RESULT_BYTES)
  })

  it('trims by payload path first, so a 40 KB body with a 1 KB subtree is not truncated', () => {
    const body = { envelope: 'y'.repeat(40 * 1024), data: { rows: ['a'.repeat(900)] } }
    const shaped = shapeResult(body, { primary_payload_path: '$.data' })

    expect(shaped.truncated).toBeUndefined()
    expect(shaped.data).toEqual({ rows: ['a'.repeat(900)] })
    expect(shapeResult(body, { primary_payload_path: '$.data', raw: true }).truncated).toBeDefined()
  })
})

describe('AC-RUN-004.2 truncation at the UTF-8 boundary', () => {
  /**
   * The cap is a BYTE cap. `Buffer.subarray(0, cap).toString('utf8')` splits a multi-byte
   * sequence into a 3-byte U+FFFD, so a naive cut returns MORE bytes than the cap it was
   * enforcing — and reports the violation as if compliant. Every offset that can straddle the
   * boundary is exercised, because only some of them split a sequence.
   */
  it('never returns more than the cap, whatever straddles it', () => {
    for (let pad = 0; pad < 8; pad++) {
      // '😀' is 4 bytes; padding shifts where it lands relative to the cap.
      const payload = 'a'.repeat(MAX_RESULT_BYTES - pad) + '😀'.repeat(64)
      const result = shapeResult({ data: payload }, { primary_payload_path: '$.data' })

      const bytes = Buffer.byteLength(result.data as string, 'utf8')
      expect(bytes, `pad=${pad}`).toBeLessThanOrEqual(MAX_RESULT_BYTES)
      // The reported size must be the truth, not a number that contradicts the returned payload.
      expect(result.truncated?.returned_bytes, `pad=${pad}`).toBe(bytes)
      // And the cut must not manufacture a replacement character out of a split sequence.
      expect(result.data as string, `pad=${pad}`).not.toContain('�')
    }
  })

  it('leaves a multi-byte payload under the cap untouched', () => {
    const payload = '😀'.repeat(10)
    const result = shapeResult({ data: payload }, { primary_payload_path: '$.data' })
    expect(result.data).toBe(payload)
    expect(result.truncated).toBeUndefined()
  })
})
