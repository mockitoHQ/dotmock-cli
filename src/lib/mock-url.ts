import { executeAction } from "../actions.js";

/**
 * Resolve the public mock base URL from a `dotmock_get_api` payload.
 * Mirrors the Go CLI (`mockBaseURL`): `_dx.baseUrl`, then baseUrl/fullUrl/url/mockUrl,
 * then `https://{subdomain}.dotmock.com`.
 */
export function resolveMockBaseUrl(api: unknown): string {
  const record = (api && typeof api === "object" ? api : {}) as Record<string, unknown>;
  const dx = record._dx as Record<string, unknown> | undefined;
  const candidates = [dx?.baseUrl, record.baseUrl, record.fullUrl, record.url, record.mockUrl];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim().replace(/\/+$/, "");
  }
  if (typeof record.subdomain === "string" && record.subdomain) {
    return `https://${record.subdomain}.dotmock.com`;
  }
  throw new Error("API response did not include a mock URL");
}

export async function fetchMockBaseUrl(apiId: string): Promise<string> {
  const api = await executeAction<unknown>("dotmock_get_api", { apiId });
  return resolveMockBaseUrl(api);
}
