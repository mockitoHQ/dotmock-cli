/**
 * Format detection and client-side conversion for `dotmock create api --from`.
 * Postman collections (v2.0/v2.1) and HAR 1.2 files are converted to an
 * OpenAPI 3.2 document with recorded examples, then created like any other
 * OpenAPI import.
 */

export type ImportFormat = "openapi" | "asyncapi" | "postman" | "har" | "unknown";

type Json = Record<string, any>;

export function detectImportFormat(value: unknown, fileName = ""): ImportFormat {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
  const doc = value as Json;
  if (typeof doc.openapi === "string" || typeof doc.swagger === "string") return "openapi";
  if (typeof doc.asyncapi === "string") return "asyncapi";
  if (doc.log && typeof doc.log === "object" && Array.isArray(doc.log.entries)) return "har";
  const schema = String(doc.info?.schema ?? "");
  if (/schema\.getpostman\.com|postman/i.test(schema) || (doc.info?._postman_id && Array.isArray(doc.item))) return "postman";
  if (fileName.toLowerCase().endsWith(".har")) return "har";
  if (/\.postman_collection\.json$/i.test(fileName) && Array.isArray(doc.item)) return "postman";
  return "unknown";
}

const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const MAX_OPERATIONS = 500;

interface Operation {
  method: string;
  path: string;
  summary?: string;
  status?: number;
  contentType?: string;
  example?: unknown;
  requestExample?: unknown;
  query?: string[];
}

/** `/users/123/orders/9f1c...` -> `/users/{id}/orders/{orderId}`-style templating. */
function templatePath(raw: string): string {
  const path = raw.split("?")[0].split("#")[0] || "/";
  const segments = path.split("/").map((segment, index, all) => {
    if (/^:[A-Za-z_]\w*$/.test(segment)) return `{${segment.slice(1)}}`;
    if (/^\{\{.+\}\}$/.test(segment)) return `{${segment.slice(2, -2).replace(/\W/g, "") || "param"}}`;
    if (/^\d+$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
      const prev = all[index - 1]?.replace(/s$/, "").replace(/\W/g, "");
      return `{${prev ? `${prev}Id` : "id"}}`;
    }
    return segment;
  });
  const joined = segments.join("/").replace(/\/+/g, "/");
  return joined.startsWith("/") ? joined : `/${joined}`;
}

function parseBody(text: unknown, contentType = ""): unknown {
  if (typeof text !== "string" || !text) return undefined;
  if (contentType.includes("json") || /^\s*[[{]/.test(text)) {
    try { return JSON.parse(text); } catch { /* fall through */ }
  }
  return text.length > 20_000 ? text.slice(0, 20_000) : text;
}

function buildDocument(title: string, operations: Operation[], description?: string): Json {
  const paths: Json = {};
  for (const op of operations.slice(0, MAX_OPERATIONS)) {
    const method = op.method.toLowerCase();
    if (!METHODS.has(method)) continue;
    const item = (paths[op.path] ??= {});
    if (item[method]) continue; // first recorded example wins
    const params = [...op.path.matchAll(/\{([^}]+)\}/g)].map((match) => ({ name: match[1], in: "path", required: true, schema: { type: "string" } }));
    for (const name of op.query ?? []) params.push({ name, in: "query", required: false, schema: { type: "string" } } as any);
    const status = String(op.status && op.status >= 100 && op.status < 600 ? op.status : 200);
    const contentType = (op.contentType || (typeof op.example === "string" ? "text/plain" : "application/json")).split(";")[0].trim();
    item[method] = {
      ...(op.summary ? { summary: op.summary } : {}),
      ...(params.length ? { parameters: params } : {}),
      ...(op.requestExample !== undefined && !["get", "head", "delete"].includes(method)
        ? { requestBody: { content: { "application/json": { example: op.requestExample } } } }
        : {}),
      responses: {
        [status]: {
          description: op.summary || "Recorded response",
          ...(op.example !== undefined ? { content: { [contentType]: { example: op.example } } } : {}),
        },
      },
    };
  }
  return { openapi: "3.2.0", info: { title, version: "1.0.0", ...(description ? { description } : {}) }, paths };
}

function postmanUrl(url: unknown): { path: string; query: string[] } {
  if (typeof url === "string") {
    const stripped = url.replace(/^\{\{[^}]+\}\}/, "").replace(/^[a-z]+:\/\/[^/]+/i, "");
    const query = stripped.includes("?") ? [...new URLSearchParams(stripped.split("?")[1]).keys()] : [];
    return { path: templatePath(stripped), query };
  }
  const value = (url ?? {}) as Json;
  const segments = Array.isArray(value.path) ? value.path.map((segment: unknown) => (typeof segment === "string" ? segment : String((segment as Json)?.value ?? ""))) : [];
  const query = Array.isArray(value.query) ? value.query.filter((q: Json) => !q?.disabled && q?.key).map((q: Json) => String(q.key)) : [];
  return segments.length ? { path: templatePath(`/${segments.join("/")}`), query } : postmanUrl(value.raw ?? "/");
}

export function postmanToOpenApi(collection: Json): Json {
  const operations: Operation[] = [];
  const walk = (items: unknown, depth: number) => {
    if (!Array.isArray(items) || depth > 20) return;
    for (const item of items as Json[]) {
      if (Array.isArray(item?.item)) { walk(item.item, depth + 1); continue; }
      const request = typeof item?.request === "string" ? { url: item.request, method: "GET" } : item?.request;
      if (!request) continue;
      const { path, query } = postmanUrl(request.url);
      const saved = Array.isArray(item.response) ? (item.response[0] as Json | undefined) : undefined;
      const savedType = Array.isArray(saved?.header) ? saved!.header.find((h: Json) => /content-type/i.test(h?.key))?.value : undefined;
      operations.push({
        method: String(request.method || "GET"),
        path,
        query,
        summary: item.name ? String(item.name) : undefined,
        status: typeof saved?.code === "number" ? saved.code : undefined,
        contentType: savedType,
        example: saved ? parseBody(saved.body, savedType) : undefined,
        requestExample: request.body?.mode === "raw" ? parseBody(request.body.raw, "json") : undefined,
      });
    }
  };
  walk(collection.item, 0);
  const description = typeof collection.info?.description === "string" ? collection.info.description : undefined;
  return buildDocument(String(collection.info?.name || "Imported Postman Collection"), operations, description);
}

export function harToOpenApi(har: Json, title = "Imported HAR"): Json {
  const entries: Json[] = Array.isArray(har.log?.entries) ? har.log.entries : [];
  const hosts = new Map<string, number>();
  const operations: Operation[] = [];
  for (const entry of entries) {
    const request = entry?.request ?? {};
    let url: URL;
    try { url = new URL(String(request.url)); } catch { continue; }
    // Skip static assets captured alongside API calls.
    if (/\.(js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|map|html?)$/i.test(url.pathname)) continue;
    const mime = String(entry.response?.content?.mimeType ?? "");
    if (mime && !/json|xml|text\/plain/i.test(mime)) continue;
    hosts.set(url.host, (hosts.get(url.host) ?? 0) + 1);
    const content = entry.response?.content ?? {};
    const text = content.encoding === "base64" && typeof content.text === "string" ? Buffer.from(content.text, "base64").toString("utf8") : content.text;
    operations.push({
      method: String(request.method || "GET"),
      path: templatePath(url.pathname),
      query: [...url.searchParams.keys()],
      status: Number(entry.response?.status) || undefined,
      contentType: mime || undefined,
      example: parseBody(text, mime),
      requestExample: parseBody(request.postData?.text, String(request.postData?.mimeType ?? "")),
    });
  }
  const host = [...hosts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return buildDocument(host ? `${title} (${host})` : title, operations);
}

/** Convert any supported import to an OpenAPI/AsyncAPI document, or throw with a precise message. */
export function toImportSpec(value: unknown, fileName: string): { format: ImportFormat; spec: Json } {
  const format = detectImportFormat(value, fileName);
  if (format === "openapi" || format === "asyncapi") return { format, spec: value as Json };
  if (format === "postman") return { format, spec: postmanToOpenApi(value as Json) };
  if (format === "har") return { format, spec: harToOpenApi(value as Json) };
  throw new Error(`${fileName}: unrecognized format. Expected OpenAPI/Swagger, AsyncAPI, a Postman collection (v2.x), or a HAR file.`);
}
