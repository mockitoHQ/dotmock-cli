import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Local project file (`dotmock.yaml`) consumed by `dotmock serve` and by
 * dotmock-server in local mode (`--local --config <file>` or
 * DOTMOCK_LOCAL_MODE=true + DOTMOCK_LOCAL_CONFIG). Mirrors the server loader
 * (dotmock-server pkg/local/config.go):
 *
 *   version: 1                 # optional
 *   apis:
 *     - name, subdomain?, type: llm|openapi|rest, defaultModel?, settings?, fixtures?, spec?, state?
 *     - file: ./pulled.yaml    # include a `dotmock config pull` (dotmock/v2) file; sibling keys override
 *
 * A single API at the top level, or a single dotmock/v2 definition, also works.
 * Fixture and settings objects use the cloud shapes (server pkg/llm/types.go), with
 * YAML conveniences: omitted id/name/priority/enabled/match get defaults, and object
 * values for response.content / toolCalls[].arguments / .result are JSON-encoded.
 *
 * JSON Schema: schemas/dotmock-project.schema.json
 */
export const PROJECT_FORMAT_VERSION = 1;

export type ProjectApiType = "llm" | "openapi" | "rest";

export interface ProjectApi {
  name?: string;
  /** `X-Dotmock-Api: <subdomain>`, `/<subdomain>/...` prefix, or `<subdomain>.localhost`. Defaults to slug(name). */
  subdomain?: string;
  type?: ProjectApiType;
  defaultModel?: string;
  settings?: Record<string, unknown>;
  fixtures?: Array<Record<string, unknown>>;
  /** OpenAPI: inline document or a path relative to the project file. */
  spec?: string | Record<string, unknown>;
  /** Include another file (e.g. `dotmock config pull` output). */
  file?: string;
  [key: string]: unknown;
}

export interface ProjectConfig {
  version?: number;
  apis: ProjectApi[];
  [key: string]: unknown;
}

/** An API after `file:` includes and defaults are applied. */
export interface ResolvedApi {
  name: string;
  subdomain: string;
  type: "llm" | "openapi";
}

export interface ConfigIssue {
  severity: "error" | "warning";
  path: string;
  message: string;
}

const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/g, "");
}

export function parseProjectConfig(source: string, file = "dotmock.yaml"): unknown {
  return file.endsWith(".json") ? JSON.parse(source) : parseYaml(source);
}

/** Accepts `{apis: [...]}`, a single top-level API, or a single dotmock/v2 definition. */
export function normalizeProjectConfig(value: unknown): ProjectConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dotmock.yaml must be a YAML or JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (record.apis !== undefined) {
    if (!Array.isArray(record.apis)) throw new Error("`apis` must be a list of APIs.");
    return { ...record, apis: record.apis as ProjectApi[] } as ProjectConfig;
  }
  return { apis: [record as ProjectApi] };
}

function readInclude(ref: string, baseDir: string): Record<string, unknown> {
  const path = isAbsolute(ref) ? ref : resolve(baseDir, ref);
  if (!existsSync(path)) throw new Error(`file not found: ${path}`);
  const value = parseProjectConfig(readFileSync(path, "utf8"), path);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

/** Apply `file:` includes (sibling keys override) — same as the server loader. */
export function expandApi(api: ProjectApi, baseDir: string): Record<string, unknown> {
  if (typeof api.file !== "string") return api;
  const { file, ...overrides } = api;
  return { ...readInclude(file, baseDir), ...overrides };
}

function inferType(obj: Record<string, unknown>): string {
  const raw = String(obj.type ?? obj.kind ?? "").toLowerCase();
  if (raw) return raw;
  if (obj.schemaVersion === "dotmock/v2") return "";
  if (obj.fixtures !== undefined) return "llm";
  if (obj.spec !== undefined) return "openapi";
  return "";
}

export function resolveApi(obj: Record<string, unknown>): ResolvedApi | null {
  const id = typeof obj.id === "string" ? obj.id : "";
  const name = typeof obj.name === "string" ? obj.name : "";
  const subdomain = (typeof obj.subdomain === "string" && obj.subdomain ? obj.subdomain : slugify(name || id)).toLowerCase();
  const type = inferType(obj);
  if (!subdomain) return null;
  return { name: name || subdomain, subdomain, type: type === "llm" ? "llm" : "openapi" };
}

export function resolveApis(config: ProjectConfig, baseDir = process.cwd()): ResolvedApi[] {
  const out: ResolvedApi[] = [];
  for (const api of config.apis) {
    try {
      const resolved = resolveApi(expandApi(api, baseDir));
      if (resolved) out.push(resolved);
    } catch {
      // reported by validateProjectConfig
    }
  }
  return out;
}

function validateFixture(fixture: Record<string, unknown>, fat: string, push: (s: ConfigIssue["severity"], p: string, m: string) => void): void {
  const response = (fixture.response ?? {}) as Record<string, unknown>;
  const workflow = (fixture.workflow ?? {}) as Record<string, any>;
  const ws = (fixture.ws ?? {}) as Record<string, any>;
  const has = (value: unknown) => (Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== "");
  const hasResponse =
    has(response.content) || has(response.reasoning) || has(response.toolCalls) || has(response.error) || has(response.embedding) ||
    has(workflow.run?.toolCalls) || has(workflow.response?.content) || has(ws.events);
  if (!hasResponse) push("error", `${fat}/response`, "Fixture has no response (set response.content, response.toolCalls, response.error or workflow).");
  if (fixture.priority !== undefined && !Number.isInteger(fixture.priority)) push("error", `${fat}/priority`, "priority must be an integer.");
  if (fixture.protocol !== undefined && !["http", "ws", "both"].includes(String(fixture.protocol))) {
    push("error", `${fat}/protocol`, "protocol must be http, ws or both.");
  }
  const match = (fixture.match ?? {}) as Record<string, unknown>;
  for (const field of ["userMessage", "systemPrompt", "inputText"]) {
    const value = match[field];
    if (typeof value === "string" && value.length > 2 && value.startsWith("/") && value.endsWith("/")) {
      try { new RegExp(value.slice(1, -1)); } catch (cause) { push("error", `${fat}/match/${field}`, `invalid regex: ${(cause as Error).message}`); }
    }
  }
  const error = response.error as Record<string, unknown> | undefined;
  if (error && (typeof error.status !== "number" || error.status < 400 || error.status > 599)) {
    push("error", `${fat}/response/error/status`, "must be an HTTP error status 400-599.");
  }
  const calls = [...((response.toolCalls as unknown[]) ?? []), ...((workflow.run?.toolCalls as unknown[]) ?? [])];
  calls.forEach((call, ci) => {
    const c = (call ?? {}) as Record<string, unknown>;
    if (typeof c.name !== "string" || !c.name) push("error", `${fat}`, `tool call #${ci + 1} has no name.`);
    if (typeof c.arguments === "string" && c.arguments) {
      try { JSON.parse(c.arguments); } catch { push("error", fat, `tool call ${String(c.name)} arguments must be valid JSON (or a YAML object).`); }
    }
  });
}

export function validateProjectConfig(config: ProjectConfig, baseDir = process.cwd()): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const push = (severity: ConfigIssue["severity"], path: string, message: string) => issues.push({ severity, path, message });

  if (config.version !== undefined && config.version !== PROJECT_FORMAT_VERSION) {
    push("warning", "/version", `Unknown version ${String(config.version)}; expected ${PROJECT_FORMAT_VERSION}.`);
  }
  if (!config.apis.length) push("error", "/apis", "At least one API is required.");

  const seen = new Set<string>();
  config.apis.forEach((entry, index) => {
    const at = `/apis/${index}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { push("error", at, "API must be an object."); return; }
    let api: Record<string, unknown>;
    try {
      api = expandApi(entry, baseDir);
    } catch (cause) {
      push("error", `${at}/file`, (cause as Error).message);
      return;
    }
    if (api.schemaVersion !== undefined && api.schemaVersion !== "dotmock/v2") {
      push("error", `${at}/schemaVersion`, `unsupported schemaVersion ${String(api.schemaVersion)} (expected dotmock/v2).`);
      return;
    }
    const resolved = resolveApi(api);
    if (!resolved) { push("error", at, "Each API needs a subdomain or name."); return; }
    if (!SUBDOMAIN.test(resolved.subdomain)) {
      push("error", `${at}/subdomain`, `${resolved.subdomain} must be lowercase letters, digits and hyphens (max 63).`);
    } else if (seen.has(resolved.subdomain)) {
      push("error", `${at}/subdomain`, `Duplicate subdomain ${resolved.subdomain}.`);
    } else seen.add(resolved.subdomain);

    if (api.schemaVersion === "dotmock/v2") return; // compiled by the server, validated by `dotmock config validate`
    const type = inferType(api);
    if (type === "llm") {
      if (api.fixtures !== undefined && !Array.isArray(api.fixtures)) { push("error", `${at}/fixtures`, "fixtures must be a list."); return; }
      const fixtures = (api.fixtures as Array<Record<string, unknown>> | undefined) ?? [];
      if (!fixtures.length) push("warning", `${at}/fixtures`, "LLM API has no fixtures; every request will fall through.");
      const ids = new Map<string, number>();
      fixtures.forEach((fixture, fi) => {
        const fat = `${at}/fixtures/${fi}`;
        if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) { push("error", fat, "Fixture must be an object."); return; }
        const id = typeof fixture.id === "string" ? fixture.id : typeof fixture.name === "string" && fixture.name ? slugify(fixture.name) : `fixture-${fi + 1}`;
        if (ids.has(id)) push("error", `${fat}/id`, `Duplicate fixture id ${id} (also fixtures[${ids.get(id)}]).`);
        ids.set(id, fi);
        validateFixture(fixture, fat, push);
      });
      if (api.settings !== undefined && api.settings !== null && (typeof api.settings !== "object" || Array.isArray(api.settings))) {
        push("error", `${at}/settings`, "settings must be an object.");
      }
    } else if (type === "openapi" || type === "rest") {
      if (typeof api.spec === "string") {
        const specPath = isAbsolute(api.spec) ? api.spec : resolve(baseDir, api.spec);
        if (!existsSync(specPath)) push("error", `${at}/spec`, `Spec file not found: ${specPath}`);
      } else if (!api.spec || typeof api.spec !== "object") {
        push("error", `${at}/spec`, "spec is required (inline OpenAPI document or a file path).");
      }
    } else {
      push("error", `${at}/type`, `type must be "llm" or "openapi" (got "${type}").`);
    }
  });
  return issues;
}

export interface LoadedProject {
  file: string;
  config: ProjectConfig;
  apis: ResolvedApi[];
  issues: ConfigIssue[];
}

export function loadProjectConfig(file: string): LoadedProject {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`Config file not found: ${path}. Run \`dotmock init --llm\` to create one.`);
  const config = normalizeProjectConfig(parseProjectConfig(readFileSync(path, "utf8"), path));
  const baseDir = dirname(path);
  return { file: path, config, apis: resolveApis(config, baseDir), issues: validateProjectConfig(config, baseDir) };
}

export function assertValidProject(loaded: LoadedProject): void {
  const errors = loaded.issues.filter((issue) => issue.severity === "error");
  if (errors.length) {
    throw new Error(
      `Invalid ${loaded.file}:\n${errors.map((issue) => `  ${issue.path}: ${issue.message}`).join("\n")}`,
    );
  }
}

/** Starter LLM project for `dotmock init --llm`. */
export function starterLlmProject(name = "Assistant", subdomain = "assistant"): ProjectConfig {
  return {
    version: PROJECT_FORMAT_VERSION,
    apis: [
      {
        name,
        subdomain,
        type: "llm",
        defaultModel: "gpt-4o-mini",
        settings: {
          chaos: { dropRate: 0, malformedRate: 0, disconnectRate: 0 },
          fallback: { type: "none" },
        },
        fixtures: [
          {
            id: "greeting",
            name: "greeting",
            priority: 10,
            enabled: true,
            match: { userMessage: "/\\b(hi|hello|hey)\\b/" },
            response: {
              content: "Hello! I'm a DotMock LLM mock. How can I help you today?",
              finishReason: "stop",
              usage: { promptTokens: 12, completionTokens: 14 },
            },
          },
          {
            id: "weather-tool-call",
            name: "weather-tool-call",
            priority: 20,
            enabled: true,
            match: { toolName: "get_weather" },
            workflow: {
              run: {
                toolCalls: [
                  {
                    id: "call_weather_1",
                    name: "get_weather",
                    arguments: '{"city":"Paris","unit":"celsius"}',
                    result: '{"temperatureC":18,"condition":"sunny"}',
                  },
                ],
              },
              response: {
                content: "It is currently {{tool.get_weather.result}} in {{tool.get_weather.args.city}}.",
                finishReason: "stop",
              },
            },
          },
          {
            id: "structured-output",
            name: "structured-output",
            priority: 30,
            enabled: true,
            match: { responseFormat: "json_schema" },
            response: {
              content: '{"sentiment":"positive","confidence":0.93,"topics":["shipping","support"]}',
              finishReason: "stop",
            },
          },
          {
            id: "refusal",
            name: "refusal",
            priority: 40,
            enabled: true,
            match: { userMessage: "/(malware|exploit|steal)/" },
            response: {
              content: "I'm sorry, but I can't help with that request.",
              finishReason: "stop",
            },
          },
          {
            id: "rate-limit",
            name: "rate-limit",
            priority: 50,
            enabled: true,
            match: { userMessage: "/rate.?limit/" },
            response: {
              error: {
                status: 429,
                type: "rate_limit_error",
                message: "Rate limit reached for requests. Please try again in 1s.",
              },
            },
          },
          {
            id: "fallback",
            name: "fallback",
            priority: 1000,
            enabled: true,
            match: {},
            response: {
              content: "This is a DotMock mock response. Add a fixture in dotmock.yaml to customize it.",
              finishReason: "stop",
            },
          },
        ],
      },
    ],
  };
}

const STARTER_HEADER = `# DotMock local project — served by \`dotmock serve\` (no account needed).
# Schema: https://dotmock.com/schemas/dotmock-project.schema.json (also works with
# \`dotmock-server --local --config dotmock.yaml\` and the ghcr.io/mockitohq/dotmock-server image).
#
# Point your SDK at http://127.0.0.1:8080/<subdomain>/v1 (OpenAI-compatible) or run
# \`dotmock llm connect <subdomain> --local\` for Anthropic/Gemini/LangChain snippets.
#
# Fixtures are evaluated by ascending priority; the first match wins.
#   match.userMessage: substring (case-insensitive) or /regex/ against the last user message
#   match.toolName / model / systemPrompt / responseFormat / sequenceIndex / conditions: see docs
#   response.error: {status, type, message} returns a provider-shaped error
#   chaos: {dropRate, malformedRate, disconnectRate, rateLimitRate} for probabilistic failures
#   Send X-Dotmock-Seed: <int> to make chaos and template randomness reproducible.
`;

export function renderProjectYaml(config: ProjectConfig): string {
  return STARTER_HEADER + "\n" + stringifyYaml(config, { lineWidth: 0 });
}
