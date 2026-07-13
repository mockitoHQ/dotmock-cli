import { Command } from "commander";
import { ApiError } from "../client.js";
import { executeAction } from "../actions.js";
import { error, info, isJsonMode, json, success } from "../output.js";
import {
  asRecord,
  collect,
  parseHeaders,
  readBodyFile,
  readStructuredFile,
  readStructuredValue,
} from "../structured-input.js";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface MockApi {
  id?: string;
  name?: string;
  openApiSpec?: Record<string, unknown>;
}

interface EndpointOptions {
  api: string;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  status?: number;
  body?: string;
  bodyFile?: string;
  header: string[];
  delay?: number;
  case: string[];
  fault: string[];
  requestSchema?: string;
  responseSchema?: string;
  from?: string;
  replace?: boolean;
}

interface EndpointDefinition {
  summary?: string;
  description?: string;
  requestSchema?: unknown;
  responseSchema?: unknown;
  defaultResponse?: {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
  };
  delay?: number;
  cases?: unknown[];
  faults?: unknown[];
}

export const createEndpointCommand = new Command("endpoint")
  .description("Create and configure a new endpoint in an existing mock API")
  .requiredOption("--api <id>", "API ID or slug")
  .requiredOption("--method <method>", "GET, POST, PUT, PATCH, or DELETE")
  .requiredOption("--path <path>", "Endpoint path, for example /users/{id}")
  .option("--summary <text>", "OpenAPI operation summary")
  .option("--description <text>", "OpenAPI operation description")
  .option("--status <code>", "Default response status", parseInteger)
  .option("--body <json>", "Inline JSON or text response body")
  .option("--body-file <file>", "Read the response body from JSON, YAML, or text")
  .option("--header <name:value>", "Default response header (repeatable)", collect, [])
  .option("--delay <ms>", "Artificial response delay", parseNonNegativeInteger)
  .option("--case <json|@file>", "Conditional response case (repeatable)", collect, [])
  .option("--fault <json|@file>", "Random fault definition (repeatable)", collect, [])
  .option("--request-schema <file>", "Request JSON Schema file")
  .option("--response-schema <file>", "Response JSON Schema file")
  .option("--from <file>", "Endpoint behavior as JSON or YAML")
  .option("--replace", "Replace an existing operation at the same method and path")
  .action(async (opts: EndpointOptions) => {
    try {
      const api = await executeAction<MockApi>("dotmock_get_api", {
        apiId: opts.api,
      });
      const update = buildEndpointUpdate(api, opts);
      const result = await executeAction<Record<string, unknown>>(
        "dotmock_update_api",
        { apiId: opts.api, updates: { openApiSpec: update.openApiSpec } },
      );

      if (isJsonMode()) {
        json({
          api: result,
          endpoint: update.endpoint,
        });
        return;
      }

      success(`Created ${update.endpoint.method} ${update.endpoint.path}.`);
      info(
        `Default: HTTP ${update.endpoint.status}; cases: ${update.endpoint.cases}; faults: ${update.endpoint.faults}; delay: ${update.endpoint.delay}ms.`,
      );
    } catch (cause) {
      if (cause instanceof ApiError) {
        error(`Failed to create endpoint (HTTP ${cause.status}): ${cause.message}`);
      } else {
        error(
          `Failed to create endpoint: ${cause instanceof Error ? cause.message : "Unknown error"}`,
        );
      }
      process.exitCode = 1;
    }
  });

export function buildEndpointUpdate(api: MockApi, opts: EndpointOptions) {
  const method = normalizeMethod(opts.method);
  const path = normalizePath(opts.path);
  const spec = structuredClone(
    asRecord(api.openApiSpec, "The API OpenAPI specification"),
  );
  const paths = asRecord(spec.paths ?? {}, "OpenAPI paths");
  const pathItem = asRecord(paths[path] ?? {}, `OpenAPI path ${path}`);
  const methodKey = method.toLowerCase();

  if (pathItem[methodKey] && !opts.replace) {
    throw new Error(
      `${method} ${path} already exists. Use \`dotmock configure endpoint\` or pass --replace.`,
    );
  }

  const fileDefinition = opts.from
    ? (asRecord(readStructuredFile(opts.from), "Endpoint definition") as EndpointDefinition)
    : {};
  const defaultFromFile = fileDefinition.defaultResponse ?? {};
  const body = resolveBody(opts, defaultFromFile.body);
  const status = opts.status ?? defaultFromFile.status ?? 200;
  const headers = {
    "Content-Type": "application/json",
    ...(defaultFromFile.headers ?? {}),
    ...parseHeaders(opts.header),
  };
  const requestSchema = opts.requestSchema
    ? readStructuredFile(opts.requestSchema)
    : fileDefinition.requestSchema;
  const responseSchema = opts.responseSchema
    ? readStructuredFile(opts.responseSchema)
    : fileDefinition.responseSchema ?? inferSchema(body);
  const cases = [
    ...(fileDefinition.cases ?? []),
    ...opts.case.map((value) => readStructuredValue(value, "--case")),
  ];
  const faults = [
    ...(fileDefinition.faults ?? []),
    ...opts.fault.map((value) => readStructuredValue(value, "--fault")),
  ];
  const delay = opts.delay ?? fileDefinition.delay ?? 0;
  const contentType = headers["Content-Type"] ?? "application/json";
  const response: Record<string, unknown> = {
    description: status >= 400 ? "Mock error response" : "Mock response",
    content: {
      [contentType]: {
        ...(responseSchema ? { schema: responseSchema } : {}),
        example: body,
      },
    },
  };
  const mockConfig: Record<string, unknown> = {
    default: { status, headers, body },
    ...(requestSchema ? { requestSchema } : {}),
    ...(delay > 0 ? { delay } : {}),
    ...(cases.length ? { cases } : {}),
    ...(faults.length ? { faults } : {}),
  };

  const operation: Record<string, unknown> = {
    summary:
      opts.summary ?? fileDefinition.summary ?? `${method} ${path}`,
    ...(opts.description ?? fileDefinition.description
      ? { description: opts.description ?? fileDefinition.description }
      : {}),
    operationId: operationId(method, path),
    ...(requestSchema
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: requestSchema },
            },
          },
        }
      : {}),
    ...(pathParameters(path).length
      ? { parameters: pathParameters(path) }
      : {}),
    responses: { [String(status)]: response },
    "x-dotmock": mockConfig,
  };

  pathItem[methodKey] = operation;
  paths[path] = pathItem;
  spec.paths = paths;

  return {
    openApiSpec: spec,
    endpoint: {
      method,
      path,
      status,
      cases: cases.length,
      faults: faults.length,
      delay,
    },
  };
}

function resolveBody(
  opts: Pick<EndpointOptions, "body" | "bodyFile">,
  fallback: unknown,
): unknown {
  if (opts.bodyFile) return readBodyFile(opts.bodyFile);
  if (opts.body !== undefined) {
    try {
      return JSON.parse(opts.body);
    } catch {
      return opts.body;
    }
  }
  return fallback ?? {};
}

function inferSchema(value: unknown): Record<string, unknown> | undefined {
  if (value === null) return { nullable: true };
  if (Array.isArray(value)) {
    return {
      type: "array",
      items: value.length ? inferSchema(value[0]) ?? {} : {},
    };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return {
      type: "object",
      properties: Object.fromEntries(
        entries.map(([key, child]) => [key, inferSchema(child) ?? {}]),
      ),
      ...(entries.length ? { required: entries.map(([key]) => key) } : {}),
    };
  }
  if (typeof value === "number") {
    return { type: Number.isInteger(value) ? "integer" : "number" };
  }
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "string") return { type: "string" };
  return undefined;
}

function pathParameters(path: string): Record<string, unknown>[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
}

function operationId(method: HttpMethod, path: string): string {
  const suffix = path
    .replace(/[{}]/g, "")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part, index) =>
      index === 0 ? part.toLowerCase() : part[0].toUpperCase() + part.slice(1),
    )
    .join("");
  return `${method.toLowerCase()}${suffix ? suffix[0].toUpperCase() + suffix.slice(1) : "Root"}`;
}

function normalizeMethod(method: string): HttpMethod {
  const value = method.toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(value)) {
    throw new Error("Method must be GET, POST, PUT, PATCH, or DELETE.");
  }
  return value as HttpMethod;
}

function normalizePath(path: string): string {
  const value = path.startsWith("/") ? path : `/${path}`;
  if (/\s/.test(value)) throw new Error("Endpoint paths cannot contain spaces.");
  return value;
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 599) {
    throw new Error("Status must be an HTTP status between 100 and 599.");
  }
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("Delay must be a non-negative integer.");
  }
  return parsed;
}
