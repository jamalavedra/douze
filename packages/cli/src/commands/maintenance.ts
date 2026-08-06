import { z } from 'incur'
import { douzeHome } from '@douze/douzed'
import { join } from 'node:path'
import type { DaemonClient } from '../daemon-client.js'

type ErrorFn = (options: { code: string; message: string; exitCode?: number }) => never

/**
 * The two maintenance commands: `doctor` (has the target drifted?) and `eject` (an artifact you
 * own). Inference and review are the daemon's, served at its own `/review/:sessionId`, so no CLI
 * command starts a UI. The ejector is imported lazily so ADR-006 holds at the CLI boundary too:
 * the inference code is never loaded for an ordinary tool call.
 */
export function register(cli: { command: (name: string, definition: unknown) => unknown }, daemon: DaemonClient): void {
  cli.command('doctor', {
    description: 'Replay a recipe read-only fixtures against the live target and report drift',
    args: z.object({ recipe: z.string().describe('Recipe name') }),
    // CLI-only: a Doctor Run issues live requests and can rewrite the recipe, degrading tools.
    // That is a maintenance decision the user makes, not one an agent should take on its own.
    mcp: false,
    async run(c: { args: { recipe: string }; error: ErrorFn }) {
      try {
        return await daemon.request(`/doctor/${c.args.recipe}`, { method: 'POST', body: '{}' })
      } catch (cause) {
        return c.error({ code: 'DOCTOR_FAILED', message: (cause as Error).message, exitCode: 1 })
      }
    },
  })

  cli.command('eject', {
    description: 'Emit a standalone incur package for one recipe',
    args: z.object({ recipe: z.string().describe('Recipe name') }),
    options: z.object({ out: z.string().describe('Directory to write the package into') }),
    mcp: false,
    async run(c: { args: { recipe: string }; options: { out: string }; error: ErrorFn }) {
      const { eject } = await import('@douze/studio')
      const recipes = await daemon.request<{ name: string }[]>('/recipes')
      const recipe = recipes.find((r) => r.name === c.args.recipe)
      if (!recipe) {
        return c.error({
          code: 'NO_RECIPE',
          message: `No recipe "${c.args.recipe}". Known: ${recipes.map((r) => r.name).join(', ') || 'none'}.`,
          exitCode: 1,
        })
      }
      try {
        const result = eject({
          recipe: recipe as never,
          out: c.options.out,
          fixturesDir: join(douzeHome(), 'fixtures'),
        })
        return { ejected: c.args.recipe, out: c.options.out, files: result.files.length, tools: result.tools }
      } catch (cause) {
        return c.error({ code: 'EJECT_FAILED', message: (cause as Error).message, exitCode: 1 })
      }
    },
  })
}
