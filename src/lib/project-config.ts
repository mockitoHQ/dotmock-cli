import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Local project file (`dotmock.yaml`) consumed by `dotmock serve` and by
 * dotmock-server in local mode (DOTMOCK_LOCAL_MODE=true, DOTMOCK_LOCAL_CONFIG=...).
 *
 * This is distinct from the per-API cloud definition that `dotmock config pull`
 * writes (`schemaVersion: dotmock/v2`): a project file describes one or more
 * APIs that run together offline. Fixture and settings objects use exactly the
 * shapes stored in `apiSpecifications.specification` (backend LlmFixtureShapeDto /
 * UpdateLlmSettingsDto, server pkg/llm/types.go), so fixtures can be copied
 * between a project file and the cloud unchanged.
 *
 * JSON Schema: schemas/dotmock-project.schema.json
 */
export const PROJECT_SCHEMA_VERSION = "dotmock/project-v1";

export type ProjectApiType = "llm" | "openapi";

export interface ProjectApi {
  name: string;
  /** Selects the API: `X-Dotmock-Api: <subdomain>` header or `/<subdomain>/...` path prefix. */
  subdomain: string;
  type: ProjectApiType;
  /** LLM: default model echoed when a request omits one. */
  defaultModel?: string;
  /** LLM: runtime settings (chaos, fallback, vcrUpstreams, mode, metricsEnabled). */
  settings?: Record<string, unknown>;
  /** LLM: fixtures, evaluated by ascending priority, first match wins. */
  fixtures?: Array<Record<string, unknown>>;
  /** OpenAPI: inline document or a path relative to the project file. */
  spec?: string | Record<string, unknown>;
  [key: string]: unknown;
}

export interface ProjectConfig {
  schemaVersion?: string;
  apis: ProjectApi[];
}

export interface ConfigIssue {
  severity: "error" | "warning";
  path: string;
  message: string;
}

const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function parseProjectConfig(source: string, file = "dotmock.yaml"): unknown {
  return file.endsWith(".json") ? JSON.parse(source) : parseYaml(source);
}

/** Accepts a project file or the single-API shorthand (top-level name/type/fixtures). */
export function normalizeProjectConfig(value: unknown): ProjectConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dotmock.yaml must be a YAML or JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion === "dotmock/v2") {
    throw new Error(
      "This file is a per-API cloud definition (dotmock config pull). `dotmock serve` needs a project file with an `apis:` list — run `dotmock init --llm` for an example.",
    );
  }
  if (Array.isArray(record.apis)) {
    return { ...record, apis: record.apis as ProjectApi[] } as ProjectConfig;
  }
  if (record.type || record.fixtures || record.spec) {
    const { schemaVersion, ...api } = record;
    return { schemaVersion: schemaVersion as string | undefined, apis: [api as ProjectApi] };
  }
  throw new Error("dotmock.yaml must contain an `apis:` list.");
}

export function validateProjectConfig(config: ProjectConfig, baseDir = process.cwd()): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const push = (severity: ConfigIssue["severity"], path: string, message: string) => issues.push({ severity, path, message });

  if (config.schemaVersion && config.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    push("warning", "/schemaVersion", `Unknown schemaVersion ${config.schemaVersion}; expected ${PROJECT_SCHEMA_VERSION}.`);
  }
  if (!config.apis.length) push("error", "/apis", "Define at least one API.");

  const seen = new Set<string>();
  config.apis.forEach((api, index) => {
    const at = `/apis/${index}`;
    if (!api || typeof api !== "object") { push("error", at, "API must be an object."); return; }
    if (typeof api.name !== "string" || !api.name.trim()) push("error", `${at}/name`, "name is required.");
    if (typeof api.subdomain !== "string" || !SUBDOMAIN.test(api.subdomain)) {
      push("error", `${at}/subdomain`, "subdomain is required (lowercase letters, digits, hyphens).");
    } else if (seen.has(api.subdomain)) {
      push("error", `${at}/subdomain`, `Duplicate subdomain ${api.subdomain}.`);
    } else seen.add(api.subdomain);

    if (api.type === "llm") {
      if (api.fixtures !== undefined && !Array.isArray(api.fixtures)) push("error", `${at}/fixtures`, "fixtures must be a list.");
      const fixtures = Array.isArray(api.fixtures) ? api.fixtures : [];
      if (!fixtures.length) push("warning", `${at}/fixtures`, "No fixtures: every request falls through to settings.fallback.");
      const ids = new Set<string>();
      fixtures.forEach((fixture, fi) => {
        const fat = `${at}/fixtures/${fi}`;
        if (!fixture || typeof fixture !== "object") { push("error", fat, "Fixture must be an object."); return; }
        if (typeof fixture.name !== "string" || !fixture.name) push("error", `${fat}/name`, "name is required.");
        if (typeof fixture.id === "string") {
          if (ids.has(fixture.id)) push("error", `${fat}/id`, `Duplicate fixture id ${fixture.id}.`);
          ids.add(fixture.id);
        }
        if (fixture.priority !== undefined && !Number.isInteger(fixture.priority)) push("error", `${fat}/priority`, "priority must be an integer.");
        if (!fixture.response && !fixture.workflow && !fixture.ws) push("error", fat, "Fixture needs response, workflow, or ws.");
      });
      if (api.settings !== undefined && (typeof api.settings !== "object" || Array.isArray(api.settings))) {
        push("error", `${at}/settings`, "settings must be an object.");
      }
    } else if (api.type === "openapi") {
      if (typeof api.spec === "string") {
        const specPath = isAbsolute(api.spec) ? api.spec : resolve(baseDir, api.spec);
        if (!existsSync(specPath)) push("error", `${at}/spec`, `Spec file not found: ${specPath}`);
      } else if (!api.spec || typeof api.spec !== "object") {
        push("error", `${at}/spec`, "spec is required (inline OpenAPI document or a file path).");
      }
    } else {
      push("error", `${at}/type`, "type must be llm or openapi.");
    }
  });
  return issues;
}

export interface LoadedProject {
  file: string;
  config: ProjectConfig;
  issues: ConfigIssue[];
}

export function loadProjectConfig(file: string): LoadedProject {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`Config file not found: ${path}. Run \`dotmock init --llm\` to create one.`);
  const config = normalizeProjectConfig(parseProjectConfig(readFileSync(path, "utf8"), path));
  return { file: path, config, issues: validateProjectConfig(config, dirname(path)) };
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
    schemaVersion: PROJECT_SCHEMA_VERSION,
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
# Schema: https://dotmock.com/schemas/dotmock-project.schema.json
#
# Point your SDK at http://localhost:8080/<subdomain>/v1 (OpenAI-compatible) or run
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
