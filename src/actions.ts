import { api } from "./client.js";
import { isApiId, resolveApiId } from "./lib/api-ref.js";

export interface ActionEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  result?: T;
  error?: string;
  message?: string;
}

async function post<T>(action: string, params: Record<string, unknown>): Promise<T> {
  const response = await api<ActionEnvelope<T>>(
    "POST",
    "/agent/actions/execute",
    { action, params, context: {} },
  );

  if (!response.success) {
    throw new Error(response.message || response.error || `${action} failed`);
  }

  return (response.result ?? response.data) as T;
}

/**
 * Execute a backend action. A non-UUID `apiId` (subdomain or name, as users
 * type it) is resolved to the API id first; the backend only accepts ids.
 */
export async function executeAction<T>(
  action: string,
  params: Record<string, unknown>,
): Promise<T> {
  const apiId = params.apiId;
  if (typeof apiId === "string" && apiId && !isApiId(apiId) && action !== "dotmock_list_apis") {
    params = { ...params, apiId: await resolveApiId(apiId, post) };
  }
  return post<T>(action, params);
}
