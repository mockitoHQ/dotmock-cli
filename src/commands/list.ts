import { Command } from "commander";
import { api, ApiError } from "../client.js";
import {
  success,
  error,
  json,
  isJsonMode,
  table,
  methodColor,
} from "../output.js";

interface ActionResult {
  success: boolean;
  data?: unknown;
  result?: unknown;
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

const listApisCommand = new Command("apis")
  .description("List your mock APIs")
  .option("--type <type>", "Filter by type (rest, llm, or webhook)")
  .action(async (opts) => {
    try {
      const params: Record<string, unknown> = {};
      if (opts.type) params.type = opts.type;

      const result = await executeAction("mockito_list_apis", params);

      if (!result.success) {
        error(result.error || "Failed to list APIs.");
        process.exitCode = 1;
        return;
      }

      const payload = result.data ?? result.result;
      const apis = Array.isArray(payload)
        ? (payload as Record<string, unknown>[])
        : ((payload as Record<string, unknown> | undefined)?.apis as
            | Record<string, unknown>[]
            | undefined) || [];

      if (isJsonMode()) {
        json(apis);
        return;
      }

      if (apis.length === 0) {
        success("No APIs found. Create one with `dotmock create api`.");
        return;
      }

      table(
        ["Name", "Type", "Endpoints", "URL"],
        apis.map((a) => [
          String(a.name || ""),
          String(a.mockType || a.apiKind || a.specificationType || a.type || "rest"),
          String(a.endpointCount ?? a.endpoints ?? "—"),
          String(a.url || a.mockUrl || ""),
        ]),
      );
    } catch (err) {
      if (err instanceof ApiError) {
        error(`Failed to list APIs (HTTP ${err.status}): ${err.message}`);
      } else {
        error(`Failed to list APIs: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  });

const listFixturesCommand = new Command("fixtures")
  .description("List LLM fixtures for an API")
  .requiredOption("--api <slug>", "API slug")
  .action(async (opts) => {
    try {
      const fixtures = await api<Record<string, unknown>[]>(
        "GET",
        `/mock-apis/${opts.api}/llm-fixtures`,
      );

      if (isJsonMode()) {
        json(fixtures);
        return;
      }

      if (!fixtures || fixtures.length === 0) {
        success("No fixtures found. Create one with `dotmock create fixture`.");
        return;
      }

      table(
        ["Priority", "Name", "Match", "Response"],
        fixtures.map((f) => [
          String(f.priority ?? "—"),
          String(f.name || ""),
          String(f.userMessage || f.model || "(catch-all)"),
          truncate(String(f.response || ""), 50),
        ]),
      );
    } catch (err) {
      if (err instanceof ApiError) {
        error(`Failed to list fixtures (HTTP ${err.status}): ${err.message}`);
      } else {
        error(`Failed to list fixtures: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  });

const listEndpointsCommand = new Command("endpoints")
  .description("List endpoints for an API")
  .requiredOption("--api <slug>", "API slug")
  .action(async (opts) => {
    try {
      const result = await executeAction("mockito_list_endpoints", {
        apiId: opts.api,
      });

      if (!result.success) {
        error(result.error || "Failed to list endpoints.");
        process.exitCode = 1;
        return;
      }

      const payload = result.data ?? result.result;
      const endpoints = Array.isArray(payload)
        ? (payload as Record<string, unknown>[])
        : ((payload as Record<string, unknown> | undefined)?.endpoints as
            | Record<string, unknown>[]
            | undefined) || [];

      if (isJsonMode()) {
        json(endpoints);
        return;
      }

      if (endpoints.length === 0) {
        success("No endpoints found.");
        return;
      }

      table(
        ["Method", "Path", "Status", "Summary"],
        endpoints.map((e) => [
          methodColor(String(e.method || "GET")),
          String(e.path || ""),
          String(e.statusCode ?? e.status ?? "200"),
          String(e.summary || e.description || ""),
        ]),
      );
    } catch (err) {
      if (err instanceof ApiError) {
        error(`Failed to list endpoints (HTTP ${err.status}): ${err.message}`);
      } else {
        error(`Failed to list endpoints: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  });

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "\u2026";
}

export const listCommand = new Command("list")
  .alias("ls")
  .description("List APIs, fixtures, or endpoints")
  .addCommand(listApisCommand)
  .addCommand(listFixturesCommand)
  .addCommand(listEndpointsCommand);
