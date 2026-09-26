import { executeAction } from "../actions.js";
import { resolveApiId, type ActionCaller } from "./api-ref.js";

/**
 * Resolve the hosted mock base URL from a `dotmock_get_api` payload:
 * `_dx.baseUrl`, then baseUrl/fullUrl/url/mockUrl (the backend builds these,
 * including team-scoped hosts), then `https://{subdomain}.mock.rest`.
 */
export function resolveMockBaseUrl(api: unknown): string {
  const record = (api && typeof api === "object" ? api : {}) as Record<string, unknown>;
  const dx = record._dx as Record<string, unknown> | undefined;
  const candidates = [dx?.baseUrl, record.baseUrl, record.fullUrl, record.url, record.mockUrl];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim().replace(/\/+$/, "");
  }
  if (typeof record.subdomain === "string" && record.subdomain) {
    return `https://${record.subdomain}.mock.rest`;
  }
  throw new Error("API response did not include a mock URL");
}

/** Resolve an API (id, subdomain, or name) to its id and hosted base URL. */
export async function fetchMockApi(ref: string, call: ActionCaller = executeAction): Promise<{ apiId: string; baseUrl: string }> {
  const apiId = await resolveApiId(ref, call);
  const api = await call<unknown>("dotmock_get_api", { apiId });
  return { apiId, baseUrl: resolveMockBaseUrl(api) };
}

export async function fetchMockBaseUrl(ref: string): Promise<string> {
  return (await fetchMockApi(ref)).baseUrl;
}
