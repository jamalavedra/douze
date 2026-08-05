import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { crc32, zip } from './zip.js'

describe('zip writer', () => {
  it('matches the reference CRC-32 vector', () => {
    // The standard "123456789" check value for CRC-32/ISO-HDLC.
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
  })

  it('produces an archive the system unzip can read (AC-CON-001.1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recon-zip-'))
    const archive = join(dir, 'test.mcpb')
    const manifest = JSON.stringify({ manifest_version: '0.2', name: 'recon' })

    writeFileSync(
      archive,
      zip([
        { path: 'manifest.json', data: Buffer.from(manifest, 'utf8') },
        { path: 'server/index.js', data: Buffer.from('console.log("hi")\n', 'utf8') },
        { path: 'server/nested/blob.bin', data: Buffer.from([0, 1, 2, 253, 254, 255]) },
      ]),
    )

    const listing = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n')
    expect(listing).toEqual(['manifest.json', 'server/index.js', 'server/nested/blob.bin'])

    execFileSync('unzip', ['-o', '-q', archive, '-d', join(dir, 'out')])
    expect(readFileSync(join(dir, 'out', 'manifest.json'), 'utf8')).toBe(manifest)
    expect([...readFileSync(join(dir, 'out', 'server/nested/blob.bin'))]).toEqual([0, 1, 2, 253, 254, 255])
  })

  it('is byte-identical across rebuilds', () => {
    const entries = [{ path: 'a.txt', data: Buffer.from('a') }]
    expect(zip(entries).equals(zip(entries))).toBe(true)
  })
})
