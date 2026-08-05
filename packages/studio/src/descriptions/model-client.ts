/**
 * T-006.2 — description generation is the only part of Recon that may call a model, and it is
 * optional: with nothing configured the writer falls back to a deterministic template, so the
 * whole studio pipeline runs offline (ADR-006).
 */
export interface ModelConfig {
  endpoint: string
  model: string
  api_key?: string
  /** AC-INF-006.5 — true when the endpoint came from the local-model setting. */
  local: boolean
}

export interface ModelClient {
  config: ModelConfig
  complete(prompt: string): Promise<string>
}

/**
 * AC-INF-006.5 — a configured local endpoint wins over a remote provider, unconditionally.
 * No configuration at all means no model, which is a supported mode, not an error.
 */
export function modelFromEnv(env: Record<string, string | undefined> = process.env): ModelConfig | undefined {
  const local = env['RECON_LOCAL_MODEL_ENDPOINT']
  if (local !== undefined && local.length > 0) {
    return { endpoint: local, model: env['RECON_LOCAL_MODEL'] ?? 'local', local: true }
  }
  const remote = env['RECON_MODEL_ENDPOINT']
  if (remote === undefined || remote.length === 0) return undefined
  const key = env['RECON_MODEL_API_KEY']
  return {
    endpoint: remote,
    model: env['RECON_MODEL'] ?? 'claude-sonnet-5',
    local: false,
    ...(key !== undefined ? { api_key: key } : {}),
  }
}

/** OpenAI-compatible chat completions, which is what local servers (llama.cpp, Ollama) speak. */
export function createModelClient(config: ModelConfig, fetchImpl: typeof fetch = fetch): ModelClient {
  return {
    config,
    async complete(prompt: string): Promise<string> {
      const response = await fetchImpl(config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.api_key !== undefined ? { authorization: `Bearer ${config.api_key}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
        }),
      })
      if (!response.ok) {
        throw new Error(`model endpoint ${config.endpoint} returned ${response.status}`)
      }
      const body = (await response.json()) as { choices?: { message?: { content?: string } }[] }
      return body.choices?.[0]?.message?.content ?? ''
    },
  }
}
