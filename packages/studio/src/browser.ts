/**
 * WO-015 T-015.3 / T-015.4 / T-015.13 — the whole of `@douze/studio`, and the only entry point it
 * has: the inference engine, deterministic naming and descriptions, and the pure half of review
 * (view, edit, approve, and what a save would persist). The extension is the sole consumer.
 *
 * Nothing reachable from here may import a `node:*` builtin — `browser-entry.test.ts` bundles this
 * file for the browser and fails if one appears. `descriptions/model-client.ts` is therefore
 * reachable only as a type: `modelFromEnv` reads `process.env`, and T-015.3 puts the model path
 * behind an extension options page that supplies the config itself.
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
