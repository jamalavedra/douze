import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * ADR-006 — studio writes to the recipe and fixture directories and nothing else; #RecipeRegistry
 * picks the change up by hot reload, so there is no runtime coupling to `recond`.
 *
 * These two paths mirror `packages/recond/src/paths.ts` deliberately: sharing them would mean
 * depending on the daemon package for a filesystem convention, which is the coupling ADR-006
 * removes. RECON_HOME keeps the E2E suite off a real install.
 */
export const reconHome = (): string => process.env['RECON_HOME'] ?? join(homedir(), '.recon')

export interface StudioPaths {
  recipes: string
  fixtures: string
}

export const studioPaths = (home = reconHome()): StudioPaths => ({
  recipes: join(home, 'recipes'),
  fixtures: join(home, 'fixtures'),
})
