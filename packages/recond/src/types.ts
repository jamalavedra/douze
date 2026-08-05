export {
  HEARTBEAT_MS,
  ReconError,
  redactBody,
  redactHeaders,
  findSurvivingSecrets,
} from '@recon/shared'
export type {
  RelayRequest,
  RelayResponse,
  ServerMessage,
  ClientMessage,
  CredentialSource,
  Tool,
  Recipe,
} from '@recon/shared'
import type { CredentialSource, Tool } from '@recon/shared'

/**
 * The minimum a request builder needs to know about a tool. Kept structural so the same
 * builder serves the relay, headless mode, and an ejected package (AC-EJT-002.1).
 */
export interface SurfaceToolLike {
  base_url: string
  tool: Pick<Tool, 'request'>
  credential_source?: CredentialSource[]
}
