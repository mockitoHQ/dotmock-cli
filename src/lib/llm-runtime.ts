import { executeAction } from "../actions.js";

/**
 * Cloud LLM runtime operations via the API-key authenticated action endpoint
 * (POST /agent/actions/execute). The REST routes under
 * /mock-apis/:apiId/llm-fixtures are JWT-only and not usable with CLI keys.
 */

export function getJournal(apiId: string, options: { limit?: number; session?: string } = {}): Promise<unknown> {
  return executeAction("dotmock_get_llm_journal", {
    apiId,
    limit: options.limit ?? 50,
    ...(options.session ? { session: options.session } : {}),
  });
}

export function resetSequences(apiId: string, session?: string): Promise<unknown> {
  return executeAction("dotmock_reset_llm_sequences", { apiId, ...(session ? { session } : {}) });
}

export function listRecordings(apiId: string, options: { limit?: number; provider?: string } = {}): Promise<unknown> {
  return executeAction("dotmock_list_llm_recordings", {
    apiId,
    limit: options.limit ?? 50,
    ...(options.provider ? { provider: options.provider } : {}),
  });
}

/** `recordingId` is the recording's id or its list index from `listRecordings`. */
export function promoteRecording(
  apiId: string,
  recordingId: string,
  overrides: { name?: string; priority?: number } = {},
): Promise<unknown> {
  return executeAction("dotmock_promote_llm_recording", { apiId, recordingId, ...overrides });
}

/**
 * Settings updates are an interactive-approval tool in the backend. A CLI
 * invocation is an explicit user command, so it carries `approved: true`.
 */
export function updateLlmSettings(apiId: string, settings: Record<string, unknown>): Promise<unknown> {
  return executeAction("dotmock_update_llm_runtime_settings", { apiId, settings, approved: true });
}

export function getLlmSettings(apiId: string): Promise<unknown> {
  return executeAction("dotmock_get_llm_runtime_settings", { apiId });
}
