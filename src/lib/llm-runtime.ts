import { executeAction } from "../actions.js";
import { api, ApiError } from "../client.js";

/**
 * Cloud LLM runtime operations. Each call first tries the permission-checked
 * MCP action (API keys work there) and falls back to the REST route under
 * /mock-apis/:apiId/llm-fixtures when the backend does not know the action yet.
 */
async function actionOrRest<T>(
  action: string,
  params: Record<string, unknown>,
  rest: { method: string; path: string; body?: unknown },
): Promise<T> {
  try {
    return await executeAction<T>(action, params);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!/unknown action/i.test(message)) throw cause;
    return api<T>(rest.method, rest.path, rest.body);
  }
}

const base = (apiId: string) => `/mock-apis/${encodeURIComponent(apiId)}/llm-fixtures`;

export function getJournal(apiId: string, limit = 50): Promise<unknown> {
  return actionOrRest("dotmock_get_llm_journal", { apiId, limit }, { method: "GET", path: `${base(apiId)}/journal?limit=${limit}` });
}

export function resetSequences(apiId: string, session?: string): Promise<unknown> {
  const body = session ? { session } : {};
  return actionOrRest("dotmock_reset_llm_runtime", { apiId, ...body }, { method: "POST", path: `${base(apiId)}/reset-sequences`, body });
}

export function listRecordings(apiId: string, limit = 100): Promise<unknown> {
  return actionOrRest("dotmock_list_llm_recordings", { apiId, limit }, { method: "GET", path: `${base(apiId)}/recordings?limit=${limit}` });
}

export function promoteRecording(
  apiId: string,
  index: number,
  overrides: { name?: string; priority?: number; enabled?: boolean } = {},
): Promise<unknown> {
  return actionOrRest(
    "dotmock_promote_llm_recording",
    { apiId, index, ...overrides },
    { method: "POST", path: `${base(apiId)}/recordings/${index}/promote`, body: overrides },
  );
}

export function updateLlmSettings(apiId: string, settings: Record<string, unknown>): Promise<unknown> {
  return actionOrRest(
    "dotmock_update_llm_runtime_settings",
    { apiId, settings },
    { method: "PATCH", path: `${base(apiId)}/settings`, body: settings },
  );
}

export { ApiError };
