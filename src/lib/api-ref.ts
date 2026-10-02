import { executeAction } from "../actions.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isApiId(value: string): boolean {
  return UUID.test(value);
}

export type ActionCaller = <T>(action: string, params: Record<string, unknown>) => Promise<T>;

function apiList(payload: unknown): Array<Record<string, unknown>> {
  const list = Array.isArray(payload)
    ? payload
    : ((payload as Record<string, unknown> | undefined)?.apis as unknown[] | undefined) ?? [];
  return list.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
}

/** First DNS label of the API's canonical mock URL (e.g. `assistant-t1a2b3c4`). */
function hostLabel(api: Record<string, unknown>): string {
  const url = api.fullUrl ?? api.url;
  try { return typeof url === "string" ? new URL(url).hostname.split(".")[0].toLowerCase() : ""; } catch { return ""; }
}

/** Find an API by id, subdomain, mock host label, or name in a `dotmock_list_apis` payload. */
export function findApi(payload: unknown, ref: string): Record<string, unknown> | undefined {
  const apis = apiList(payload);
  const wanted = ref.trim().toLowerCase();
  if (!wanted) return undefined;
  return (
    apis.find((api) => String(api.id ?? "").toLowerCase() === wanted) ??
    apis.find((api) => String(api.subdomain ?? api.slug ?? "").toLowerCase() === wanted) ??
    apis.find((api) => hostLabel(api) === wanted) ??
    // `assistant` should find a stored `assistant-t1a2b3c4` subdomain.
    apis.find((api) => hostLabel(api).replace(/-t[0-9a-f]{8}$/, "") === wanted) ??
    apis.find((api) => String(api.name ?? "").toLowerCase() === wanted) ??
    uniquePrefixMatch(apis, wanted)
  );
}

/** The backend appends uniqueness/team suffixes to requested subdomains; accept the requested prefix when unambiguous. */
function uniquePrefixMatch(apis: Array<Record<string, unknown>>, wanted: string): Record<string, unknown> | undefined {
  const hits = apis.filter((api) => String(api.subdomain ?? "").toLowerCase().startsWith(`${wanted}-`));
  return hits.length === 1 ? hits[0] : undefined;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/** Up to three API labels (subdomain or name) that look like `ref`. */
export function suggestApis(payload: unknown, ref: string): string[] {
  const wanted = ref.trim().toLowerCase();
  const scored = apiList(payload).flatMap((api) => {
    const label = String(api.subdomain ?? api.slug ?? api.name ?? api.id ?? "");
    const keys = [label, String(api.name ?? ""), hostLabel(api)].map((key) => key.toLowerCase()).filter(Boolean);
    const score = Math.min(...keys.map((key) => (key.includes(wanted) || wanted.includes(key) ? 0 : distance(key, wanted))));
    return label && score <= Math.max(2, Math.floor(wanted.length / 3)) ? [{ label, score }] : [];
  });
  return [...new Set(scored.sort((a, b) => a.score - b.score).map((item) => item.label))].slice(0, 3);
}

export class ApiNotFoundError extends Error {
  constructor(public readonly ref: string, public readonly suggestions: string[]) {
    super(
      `API "${ref}" not found in this team.` +
        (suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : "") +
        " Run `dotmock list apis` to see ids and subdomains.",
    );
    this.name = "ApiNotFoundError";
  }
}

/**
 * Resolve an API reference (id, subdomain, or name) to its id. Ids pass
 * through untouched; anything else is looked up in the team's API list. Unknown
 * references fail locally with suggestions instead of being sent to the
 * backend as a malformed id.
 */
export async function resolveApiId(ref: string, call: ActionCaller = executeAction): Promise<string> {
  const value = String(ref ?? "").trim();
  if (!value) throw new Error("An API id, subdomain, or name is required.");
  if (isApiId(value)) return value;
  const payload = await call<unknown>("dotmock_list_apis", {});
  const hit = findApi(payload, value);
  if (typeof hit?.id === "string") return hit.id;
  throw new ApiNotFoundError(value, suggestApis(payload, value));
}
