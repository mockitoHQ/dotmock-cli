import { Command } from "commander";
import { api, ApiError } from "../client.js";
import { success, error, json, isJsonMode } from "../output.js";
import {
  asRecord,
  collect,
  parseHeaders,
  readBodyFile,
  readStructuredFile,
  readStructuredValue,
} from "../structured-input.js";
import { parseResponseHook } from "../response-hooks.js";

interface ActionResult {
  success: boolean;
  data?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  message?: string;
}

async function executeAction(
  action: string,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  return api<ActionResult>("POST", "/internal/mcp/execute-action", {
    action,
    params,
    context: {},
  });
}

const configureEndpointCommand = new Command("endpoint")
  .description("Configure an API endpoint")
  .requiredOption("--api <slug>", "API slug")
  .requiredOption("--method <method>", "HTTP method (GET, POST, etc.)")
  .requiredOption("--path <path>", "Endpoint path (e.g. /users)")
  .option("--status <code>", "Response status code", parseInt)
  .option("--body <json>", "Response body (JSON string)")
  .option("--body-file <file>", "Read response body from JSON, YAML, or text")
  .option("--header <name:value>", "Response header (repeatable)", collect, [])
  .option("--delay <ms>", "Response delay in milliseconds", parseInt)
  .option("--case <json|@file>", "Conditional response case (repeatable)", collect, [])
  .option("--fault <json|@file>", "Fault injection rule (repeatable)", collect, [])
  .option(
    "--response-hook <api:event|json|@file>",
    "Webhook API event emitted after the response (repeatable)",
    collect,
    [],
  )
  .option("--request-schema <file>", "Request JSON Schema file")
  .option("--from <file>", "Merge endpoint configuration from JSON or YAML")
  .option("--replace", "Replace configuration instead of merging with the current behavior")
  .option("--clear-cases", "Remove every conditional response case")
  .option("--clear-faults", "Remove every fault rule")
  .option("--clear-response-hooks", "Remove every Response Hook")
  .option("--clear-delay", "Remove the response delay")
  .action(async (opts) => {
    try {
      const currentResult = opts.replace
        ? undefined
        : await executeAction("dotmock_get_endpoint", {
            apiId: opts.api,
            method: opts.method.toUpperCase(),
            path: opts.path,
          });
      const currentPayload = currentResult
        ? currentResult.data || currentResult.result || {}
        : {};
      const currentConfig = asRecord(
        (currentPayload as Record<string, unknown>).config ?? {},
        "Current endpoint configuration",
      );
      const fileConfig = opts.from
        ? asRecord(readStructuredFile(opts.from), "Endpoint configuration")
        : {};
      const base = { ...currentConfig, ...fileConfig };
      const baseDefault = asRecord(
        base.defaultResponse ?? base.default ?? {},
        "Default response",
      );
      const config: Record<string, unknown> = {};
      const responseHeaders = {
        "Content-Type": "application/json",
        ...asStringRecord(baseDefault.headers),
        ...parseHeaders(opts.header),
      };
      let responseBody: unknown = baseDefault.body ?? {};

      if (opts.bodyFile) responseBody = readBodyFile(opts.bodyFile);

      if (opts.body) {
        try {
          responseBody = JSON.parse(opts.body);
        } catch {
          responseBody = opts.body;
        }
      }
      config.defaultResponse = {
        status: opts.status ?? baseDefault.status ?? 200,
        body: responseBody,
        headers: responseHeaders,
      };

      const delay = opts.clearDelay ? undefined : opts.delay ?? base.delay;
      if (delay !== undefined && Number(delay) > 0) config.delay = Number(delay);
      const requestSchema = opts.requestSchema
        ? readStructuredFile(opts.requestSchema)
        : base.requestSchema;
      if (requestSchema) config.requestSchema = requestSchema;

      const cases = opts.clearCases
        ? []
        : opts.case.length
          ? opts.case.map((value: string) => readStructuredValue(value, "--case"))
          : Array.isArray(base.cases)
            ? base.cases
            : [];
      if (cases.length) config.cases = cases;

      const faults = opts.clearFaults
        ? []
        : opts.fault.length
          ? opts.fault.map((value: string) => readStructuredValue(value, "--fault"))
          : Array.isArray(base.faults)
            ? base.faults
            : [];
      if (faults.length) config.faults = faults;

      const responseHooks = opts.clearResponseHooks
        ? []
        : opts.responseHook.length
          ? opts.responseHook.map(parseResponseHook)
          : Array.isArray(base.responseHooks)
            ? base.responseHooks
            : [];
      if (responseHooks.length) config.responseHooks = responseHooks;

      const params: Record<string, unknown> = {
        apiId: opts.api,
        method: opts.method.toUpperCase(),
        path: opts.path,
        config,
      };

      const result = await executeAction("dotmock_configure_endpoint", params);

      if (!result.success) {
        error(result.error || "Failed to configure endpoint.");
        process.exitCode = 1;
        return;
      }

      if (isJsonMode()) {
        json(result.data || result.result);
        return;
      }

      success(
        `Endpoint ${opts.method.toUpperCase()} ${opts.path} configured on "${opts.api}".`,
      );
    } catch (err) {
      if (err instanceof ApiError) {
        error(
          `Failed to configure endpoint (HTTP ${err.status}): ${err.message}`,
        );
      } else {
        error(`Failed to configure endpoint: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  });

export const configureCommand = new Command("configure")
  .description("Configure API endpoints")
  .addCommand(configureEndpointCommand);

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      String(item),
    ]),
  );
}
