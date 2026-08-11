/**
 * WO-015 T-015.3 / T-015.4 — everything the extension bundles into an MV3 service worker or
 * extension page: the inference engine, deterministic naming and descriptions, the review page,
 * and the pure half of review (view, edit, approve, and what a save would persist).
 *
 * Nothing reachable from here may import a `node:*` builtin — `browser-entry.test.ts` bundles this
 * file for the browser and fails if one appears. That rules out, deliberately:
 *   - `paths.ts` / the filesystem half of `api.ts` — the caller owns persistence (`prepareSave`)
 *   - `eject.ts` — writes a project to disk
 *   - `descriptions/model-client.ts` — reads `process.env`; see the report for what a worker needs
 */
export * from './types.js'
export * from './inference/templating.js'
export * from './inference/schema.js'
export * from './inference/graphql.js'
export * from './inference/side-effects.js'
export * from './inference/payload.js'
export * from './inference/confidence.js'
export * from './inference/engine.js'
export * from './descriptions/naming.js'
export * from './descriptions/writer.js'
export * from './promotion.js'
export * from './merge.js'
export * from './fixtures.js'
export * from './candidates.js'
export * from './app.js'
