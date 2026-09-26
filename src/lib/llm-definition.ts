import { stringify as stringifyYaml } from "yaml";
import { executeAction } from "../actions.js";

/**
 * Cloud LLM definitions for `dotmock init --llm` and `dotmock config apply`.
 *
 * An LLM API is described as a `dotmock/v2` definition with `kind: llm`:
 *
 *   schemaVersion: dotmock/v2
 *   kind: llm
 *   id: <api id>            # optional; written by the first `config apply`
 *   name: Assistant
 *   subdomain: assistant    # used when the API is created
 *   protocol: { source: llm, settings: {chaos, fallback, mode, vcrUpstreams, metricsEnabled} }
 *   fixtures: [...]         # same shape as `dotmock create fixture --from`
 *   rules: []
 *
 * `config apply` syncs fixtures (matched by name) and settings to the hosted
 * API through the API-key action endpoint. LLM fixtures are live as soon as
 * they are applied; there is no separate publish step for them.
 */

export type LlmDefinition = Record<string, unknown> & {
  schemaVersion?: string;
  kind?: string;
  id?: string;
  name?: string;
  subdomain?: string;
  protocol?: Record<string, unknown>;
  fixtures?: Array<Record<string, unknown>>;
};

export interface DefinitionIssue {
  severity: "error" | "warning";
  path: string;
  message: string;
}

const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/g, "");
}

export function isLlmDefinition(value: Record<string, unknown>): value is LlmDefinition {
  const protocol = value.protocol as Record<string, unknown> | undefined;
  return value.kind === "llm" || (value.kind === undefined && protocol?.source === "llm");
}

export function llmSettingsOf(definition: LlmDefinition): Record<string, unknown> | undefined {
  const settings = definition.protocol?.settings ?? definition.settings;
  return settings && typeof settings === "object" && !Array.isArray(settings) ? (settings as Record<string, unknown>) : undefined;
}

function validateFixture(fixture: Record<string, unknown>, at: string, push: (s: DefinitionIssue["severity"], p: string, m: string) => void): void {
  const response = (fixture.response ?? {}) as Record<string, unknown>;
  const workflow = (fixture.workflow ?? {}) as Record<string, any>;
  const ws = (fixture.ws ?? {}) as Record<string, any>;
  const has = (value: unknown) => (Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== "");
  const hasResponse =
    has(response.content) || has(response.reasoning) || has(response.toolCalls) || has(response.error) || has(response.embedding) ||
    has(workflow.run?.toolCalls) || has(workflow.response?.content) || has(ws.events);
  if (typeof fixture.name !== "string" || !fixture.name) push("error", `${at}/name`, "Fixture needs a name (fixtures are matched by name on apply).");
  if (!hasResponse) push("error", `${at}/response`, "Fixture has no response (set response.content, response.toolCalls, response.error or workflow).");
  if (fixture.priority !== undefined && !Number.isInteger(fixture.priority)) push("error", `${at}/priority`, "priority must be an integer.");
  if (fixture.protocol !== undefined && !["http", "ws", "both"].includes(String(fixture.protocol))) {
    push("error", `${at}/protocol`, "protocol must be http, ws or both.");
  }
  const match = (fixture.match ?? {}) as Record<string, unknown>;
  for (const field of ["userMessage", "systemPrompt", "inputText"]) {
    const value = match[field];
    if (typeof value === "string" && value.length > 2 && value.startsWith("/") && value.endsWith("/")) {
      try { new RegExp(value.slice(1, -1)); } catch (cause) { push("error", `${at}/match/${field}`, `invalid regex: ${(cause as Error).message}`); }
    }
  }
  const error = response.error as Record<string, unknown> | undefined;
  if (error && (typeof error.status !== "number" || error.status < 400 || error.status > 599)) {
    push("error", `${at}/response/error/status`, "must be an HTTP error status 400-599.");
  }
  const calls = [...((response.toolCalls as unknown[]) ?? []), ...((workflow.run?.toolCalls as unknown[]) ?? [])];
  calls.forEach((call, ci) => {
    const c = (call ?? {}) as Record<string, unknown>;
    if (typeof c.name !== "string" || !c.name) push("error", at, `tool call #${ci + 1} has no name.`);
    if (typeof c.arguments === "string" && c.arguments) {
      try { JSON.parse(c.arguments); } catch { push("error", at, `tool call ${String(c.name)} arguments must be valid JSON (or a YAML object).`); }
    }
  });
}

/** Client-side checks before anything is sent; the backend runs its own fixture validation too. */
export function validateLlmDefinition(definition: LlmDefinition): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  const push = (severity: DefinitionIssue["severity"], path: string, message: string) => issues.push({ severity, path, message });
  if (definition.schemaVersion !== undefined && definition.schemaVersion !== "dotmock/v2") {
    push("error", "/schemaVersion", `unsupported schemaVersion ${String(definition.schemaVersion)} (expected dotmock/v2).`);
  }
  if (definition.subdomain !== undefined && (typeof definition.subdomain !== "string" || !SUBDOMAIN.test(definition.subdomain))) {
    push("error", "/subdomain", "subdomain must be lowercase letters, digits and hyphens (max 63).");
  }
  if (definition.fixtures !== undefined && !Array.isArray(definition.fixtures)) {
    push("error", "/fixtures", "fixtures must be a list.");
    return issues;
  }
  const fixtures = definition.fixtures ?? [];
  if (!fixtures.length) push("warning", "/fixtures", "LLM API has no fixtures; every request will fall through.");
  const names = new Map<string, number>();
  fixtures.forEach((fixture, index) => {
    const at = `/fixtures/${index}`;
    if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) { push("error", at, "Fixture must be an object."); return; }
    const name = typeof fixture.name === "string" ? fixture.name : "";
    if (name && names.has(name)) push("error", `${at}/name`, `Duplicate fixture name ${name} (also fixtures[${names.get(name)}]).`);
    if (name) names.set(name, index);
    validateFixture(fixture, at, push);
  });
  const settings = definition.protocol?.settings;
  if (settings !== undefined && (settings === null || typeof settings !== "object" || Array.isArray(settings))) {
    push("error", "/protocol/settings", "settings must be an object.");
  }
  return issues;
}

/** YAML convenience: object tool arguments / results / JSON content are sent as JSON strings. */
function toFixtureBody(fixture: Record<string, unknown>): Record<string, unknown> {
  const encode = (value: unknown) => (value !== null && typeof value === "object" ? JSON.stringify(value) : value);
  const body = structuredClone(fixture) as Record<string, any>;
  delete body.id;
  const fixCalls = (calls: unknown) => {
    if (!Array.isArray(calls)) return;
    for (const call of calls) {
      if (call && typeof call === "object") {
        if ("arguments" in call) call.arguments = encode(call.arguments);
        if ("result" in call) call.result = encode(call.result);
      }
    }
  };
  if (body.response && typeof body.response === "object") {
    if (body.response.content !== undefined && typeof body.response.content === "object") body.response.content = encode(body.response.content);
    fixCalls(body.response.toolCalls);
  }
  fixCalls(body.workflow?.run?.toolCalls);
  if (body.match === undefined) body.match = {};
  return body;
}

function asList(payload: unknown, key: string): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  const nested = (payload as Record<string, unknown> | undefined)?.[key];
  return Array.isArray(nested) ? (nested as Array<Record<string, unknown>>) : [];
}

export interface LlmSyncResult {
  apiId: string;
  created: string[];
  updated: string[];
  deleted: string[];
  /** Remote fixtures not in the file (kept unless --prune). */
  extra: string[];
  settingsUpdated: boolean;
}

/** Push fixtures (matched by name) and settings to a hosted LLM API. */
export async function syncLlmDefinition(apiId: string, definition: LlmDefinition, options: { prune?: boolean } = {}): Promise<LlmSyncResult> {
  const remote = asList(await executeAction("dotmock_list_llm_fixtures", { apiId }), "fixtures");
  const byName = new Map(remote.map((fixture) => [String(fixture.name ?? ""), fixture]));
  const result: LlmSyncResult = { apiId, created: [], updated: [], deleted: [], extra: [], settingsUpdated: false };
  const wanted = new Set<string>();

  for (const fixture of definition.fixtures ?? []) {
    const name = String(fixture.name);
    wanted.add(name);
    const body = toFixtureBody(fixture);
    const existing = byName.get(name);
    if (existing?.id) {
      await executeAction("dotmock_update_llm_fixture", { apiId, fixtureId: existing.id, ...body });
      result.updated.push(name);
    } else {
      await executeAction("dotmock_create_llm_fixture", { apiId, ...body });
      result.created.push(name);
    }
  }

  for (const fixture of remote) {
    const name = String(fixture.name ?? "");
    if (wanted.has(name)) continue;
    if (options.prune && fixture.id) {
      await executeAction("dotmock_delete_llm_fixture", { apiId, fixtureId: fixture.id });
      result.deleted.push(name);
    } else {
      result.extra.push(name);
    }
  }

  const settings = llmSettingsOf(definition);
  if (settings && Object.keys(settings).length) {
    await executeAction("dotmock_update_llm_runtime_settings", { apiId, settings });
    result.settingsUpdated = true;
  }
  return result;
}

/** Create the hosted LLM API described by a definition; returns the API record. */
export async function createLlmApi(definition: LlmDefinition): Promise<Record<string, unknown>> {
  const name = String(definition.name || "Assistant");
  const created = await executeAction<Record<string, unknown>>("dotmock_create_api", {
    name,
    subdomain: String(definition.subdomain || slugify(name)),
    specificationType: "llm",
    mockType: "llm",
  });
  if (!created || typeof created.id !== "string") throw new Error("API creation did not return an id.");
  return created;
}

/** Starter LLM definition for `dotmock init --llm`. */
export function starterLlmDefinition(name = "Assistant", subdomain = "assistant"): LlmDefinition {
  return {
    schemaVersion: "dotmock/v2",
    kind: "llm",
    name,
    subdomain,
    protocol: {
      source: "llm",
      settings: {
        chaos: { dropRate: 0, malformedRate: 0, disconnectRate: 0 },
        fallback: { type: "none" },
      },
    },
    rules: [],
    fixtures: [
      {
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
  };
}

const STARTER_HEADER = `# DotMock LLM mock definition (dotmock/v2, kind: llm), hosted by DotMock at https://<subdomain>-<team>.mock.rest.
#
#   dotmock login                       # or export DOTMOCK_API_KEY=mck_...
#   dotmock config apply                # creates the API on first run and records its id below
#   dotmock llm connect <api>           # base URL, env vars and SDK snippets
#
# Fixtures are evaluated by ascending priority; the first match wins. \`config apply\`
# matches fixtures by name (add --prune to delete hosted fixtures missing from this file).
#   match.userMessage: substring (case-insensitive) or /regex/ against the last user message
#   match.toolName / model / systemPrompt / responseFormat / sequenceIndex / conditions: see docs
#   response.error: {status, type, message} returns a provider-shaped error
#   protocol.settings.chaos: {dropRate, malformedRate, disconnectRate, rateLimitRate}
#   Send X-Dotmock-Session: <id> to isolate sequence counters per test run.
`;

export function renderLlmDefinitionYaml(definition: LlmDefinition): string {
  return STARTER_HEADER + "\n" + stringifyYaml(definition, { lineWidth: 0 });
}
