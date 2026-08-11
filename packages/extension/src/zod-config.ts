import { z } from 'zod'

/**
 * Zod compiles validators with `new Function` when it can, and probes for that ability with a
 * `try { Function('') } catch {}`. MV3's `extension_pages` CSP allows no `unsafe-eval`, so the
 * probe throws, is caught, and zod falls back to interpreting — correct, but the browser still
 * raises a `securitypolicyviolation` event for the attempt, which is noise in the console and one
 * of the first things a Web Store reviewer looks at.
 *
 * `jitless` tells zod not to try, so the probe never runs. Import this before anything that builds
 * a schema; every entry point of this package does, which is why it is a module and not a line.
 */
z.config({ jitless: true })
