import { executeAction } from "../actions.js";
import { getBaseUrl } from "../config.js";
import { resolveApiId, type ActionCaller } from "./api-ref.js";

/**
 * Collapse a team token the URL builder appended twice
 * (`assistant-x1y2-t1a2b3c4-t1a2b3c4.mock.rest` -> `assistant-x1y2-t1a2b3c4.mock.rest`).
 */
export function collapseDoubledTeamSuffix(url: string): string {
  return url.replace(/^(https?:\/\/[a-z0-9-]*?)(-t[0-9a-f]{8}|-[a-z0-9]{6,10})\2(?=[.:/]|$)/i, "$1$2");
}

function isLocalBackend(): boolean {
  try {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(getBaseUrl()).hostname);
  } catch {
    return false;
  }
}

/**
 * Resolve the hosted mock base URL from a `dotmock_get_api` payload. The
 * backend's canonical fields win: `localUrl` when the CLI talks to a local
 * stack, then fullUrl/_dx.baseUrl/baseUrl/url/mockUrl, then
 * `https://{subdomain}.mock.rest`. A doubled team suffix is collapsed.
 */
export function resolveMockBaseUrl(api: unknown, local = isLocalBackend()): string {
  const record = (api && typeof api === "object" ? api : {}) as Record<string, unknown>;
  const dx = record._dx as Record<string, unknown> | undefined;
  const candidates = [local ? record.localUrl : undefined, record.fullUrl, dx?.baseUrl, record.baseUrl, record.url, record.mockUrl];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return collapseDoubledTeamSuffix(value.trim().replace(/\/+$/, ""));
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
