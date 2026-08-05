import { test, expect } from '@playwright/test'
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Recond, REPO, waitFor } from '../harness.js'

/** COV_RUN_003 — daemon lifecycle. Real spawned processes, not in-process construction. */
test.describe('COV_RUN_003: Daemon lifecycle', () => {
  test('@COV_RUN_003.1 should refuse to start a second instance', async () => {
    const recond = new Recond()
    await recond.start()

    // Start it again against the same RECON_HOME and capture what it says.
    const second = spawn('npx', ['tsx', join(REPO, 'packages/recond/src/bin.ts')], {
      env: { ...process.env, RECON_HOME: recond.home },
    })
    let stderr = ''
    second.stderr.on('data', (chunk) => (stderr += String(chunk)))
    const code = await new Promise<number>((resolve) => second.on('exit', (c) => resolve(c ?? -1)))

    expect(code).not.toBe(0)
    expect(stderr).toMatch(/already running/)
    // The message must name the running instance so the user can act on it.
    expect(stderr).toMatch(/pid \d+/)

    // Exactly one process is listening on that port.
    const listeners = execFileSync('bash', ['-c', `lsof -nP -iTCP:${recond.port} -sTCP:LISTEN | tail -n +2 | wc -l`])
    expect(Number(String(listeners).trim())).toBe(1)

    recond.stop()
  })

  test('@COV_RUN_003.2 should auto-start from a client and survive a restart', async () => {
    const recond = new Recond()

    // With recond stopped, a client command must start it and complete.
    const home = recond.home
    const cli = (args: string[]) =>
      new Promise<{ code: number; out: string }>((resolve) => {
        const child = spawn('npx', ['tsx', join(REPO, 'packages/cli/src/bin.ts'), ...args], {
          env: { ...process.env, RECON_HOME: home },
        })
        let out = ''
        child.stdout.on('data', (c) => (out += String(c)))
        child.stderr.on('data', (c) => (out += String(c)))
        child.on('exit', (code) => resolve({ code: code ?? -1, out }))
      })

    const first = await cli(['status'])
    expect(first.code).toBe(0)
    const runtime = JSON.parse(readFileSync(join(home, 'recond.json'), 'utf8'))
    expect(runtime.pid).toBeGreaterThan(0)

    // Kill the daemon; the next command must recover with no user action. The kill itself may
    // race a daemon that already exited, which is not what this test is about.
    try {
      process.kill(runtime.pid, 'SIGKILL')
    } catch {
      // already gone — the recovery assertion below is what matters
    }
    await waitFor(async () => {
      try {
        process.kill(runtime.pid, 0)
        return false
      } catch {
        return true
      }
    }, 'daemon to die')

    // AC-RUN-003.4 — recovery with no user action. The invariant is that the command succeeds
    // and a live daemon is reachable afterwards, not that the pid happens to differ.
    const second = await cli(['status'])
    expect(second.code).toBe(0)

    const restarted = JSON.parse(readFileSync(join(home, 'recond.json'), 'utf8'))
    expect(restarted.pid).toBeGreaterThan(0)
    await waitFor(async () => (await fetch(`http://127.0.0.1:${restarted.port}/health`)).ok, 'daemon to be reachable')

    try {
      process.kill(restarted.pid, 'SIGTERM')
    } catch {
      // already gone
    }
    recond.stop()
  })
})
