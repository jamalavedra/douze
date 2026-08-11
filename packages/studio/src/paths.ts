import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * ADR-006 — studio writes to the recipe and fixture directories and nothing else; #RecipeRegistry
 * picks the change up by hot reload, so there is no runtime coupling to `douzed`.
 *
 * These two paths mirror `packages/douzed/src/paths.ts` deliberately: sharing them would mean
 * depending on the daemon package for a filesystem convention, which is the coupling ADR-006
 * removes. DOUZE_HOME keeps the E2E suite off a real install.
 */
export const douzeHome = (): string => process.env['DOUZE_HOME'] ?? join(homedir(), '.douze')

export interface StudioPaths {
  recipes: string
  fixtures: string
}

export const studioPaths = (home = douzeHome()): StudioPaths => ({
  recipes: join(home, 'recipes'),
  fixtures: join(home, 'fixtures'),
})
