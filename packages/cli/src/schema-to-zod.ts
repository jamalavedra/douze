import { Openapi, z } from 'incur'

/**
 * AC-RUN-001.1 — recipes store JSON Schema; incur wants Zod. `Openapi.toZod` is incur's own
 * converter, the same one it uses for OpenAPI parameters and remote MCP `inputSchema`s, so a
 * schema that survives this conversion is one incur can both parse on the CLI and re-emit as
 * MCP JSON Schema unchanged. incur accepts no raw JSON Schema anywhere, so this runs at load.
 */
export function toZodObject(schema: unknown): z.ZodObject<Record<string, z.ZodType>> {
  const source = isObjectSchema(schema) ? schema : { type: 'object', properties: {} }
  const converted = Openapi.toZod(source as Record<string, unknown>)
  if (converted instanceof z.ZodObject) return converted as z.ZodObject<Record<string, z.ZodType>>
  // A non-object schema cannot become CLI options; an empty surface is safer than a crash.
  return z.object({})
}

function isObjectSchema(schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object') return false
  const record = schema as Record<string, unknown>
  return record['type'] === 'object' || 'properties' in record
}

/**
 * AC-RUN-004.1 — `raw` is a runtime concern rather than a recipe one, so every tool grows it
 * here instead of every recipe carrying it. Left `.optional()` rather than `.default(false)`
 * because incur derives the MCP schema from the parsed *output* type, where a default makes the
 * field required — and an agent should not have to pass `raw` to make a normal call.
 */
export const RAW_OPTION = z
  .boolean()
  .optional()
  .describe("Return the untrimmed response body instead of the recipe's primary payload path.")
