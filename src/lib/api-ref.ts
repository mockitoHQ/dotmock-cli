import { executeAction } from "../actions.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isApiId(value: string): boolean {
  return UUID.test(value);
}

export type ActionCaller = <T>(action: string, params: Record<string, unknown>) => Promise<T>;

/** Find an API by id, subdomain, or name in a `dotmock_list_apis` payload. */
export function findApi(payload: unknown, ref: string): Record<string, unknown> | undefined {
  const list = Array.isArray(payload)
    ? payload
    : ((payload as Record<string, unknown> | undefined)?.apis as unknown[] | undefined) ?? [];
  const apis = list.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  const wanted = ref.toLowerCase();
  const host = (api: Record<string, unknown>) => {
    const url = api.fullUrl ?? api.url;
    try { return typeof url === "string" ? new URL(url).hostname.split(".")[0] : ""; } catch { return ""; }
  };
  return (
    apis.find((api) => api.id === ref) ??
    apis.find((api) => String(api.subdomain ?? api.slug ?? "").toLowerCase() === wanted) ??
    apis.find((api) => host(api) === wanted) ??
    apis.find((api) => String(api.name ?? "").toLowerCase() === wanted)
  );
}

/**
 * Resolve an API reference (id, subdomain, or name) to its id. Ids pass
 * through untouched; anything else is looked up in the team's API list and
 * falls back to the raw value so the backend reports a precise error.
 */
export async function resolveApiId(ref: string, call: ActionCaller = executeAction): Promise<string> {
  if (isApiId(ref)) return ref;
  const hit = findApi(await call<unknown>("dotmock_list_apis", {}), ref);
  return typeof hit?.id === "string" ? hit.id : ref;
}
