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
import { executeAction as execute } from "../actions.js";

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

      const result = await executeAction("dotmock_list_apis", params);

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
      const fixtures = await execute<Record<string, unknown>[]>(
        "dotmock_list_llm_fixtures",
        { apiId: opts.api },
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
      const result = await executeAction("dotmock_list_endpoints", {
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

const listTrafficCommand = new Command("traffic")
  .description("List recent traffic for an API")
  .requiredOption("--api <id>", "API ID or slug")
  .option("--limit <n>", "Maximum records (1-1000)", parsePositiveInteger, 100)
  .option("--offset <n>", "Records to skip", parseNonNegativeInteger, 0)
  .action(async (opts) => {
    try {
      const result = await execute<Record<string, unknown>>(
        "dotmock_get_traffic_logs",
        { apiId: opts.api, limit: opts.limit, offset: opts.offset },
      );
      const logs = Array.isArray(result.logs)
        ? (result.logs as Record<string, unknown>[])
        : [];
      if (isJsonMode()) {
        json(result);
        return;
      }
      if (!logs.length) {
        success("No traffic found.");
        return;
      }
      table(
        ["Time", "Method", "Path", "Status", "Duration"],
        logs.map((entry) => [
          String(entry.timestamp || entry.createdAt || ""),
          methodColor(String(entry.method || "")),
          String(entry.path || entry.url || ""),
          String(entry.statusCode ?? entry.status ?? ""),
          entry.durationMs === undefined ? "" : `${entry.durationMs}ms`,
        ]),
      );
    } catch (err) {
      if (err instanceof ApiError) {
        error(`Failed to list traffic (HTTP ${err.status}): ${err.message}`);
      } else {
        error(`Failed to list traffic: ${(err as Error).message}`);
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
  .description("List APIs, fixtures, endpoints, or traffic")
  .addCommand(listApisCommand)
  .addCommand(listFixturesCommand)
  .addCommand(listEndpointsCommand)
  .addCommand(listTrafficCommand);

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw new Error("Limit must be between 1 and 1000.");
  }
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("Offset must be a non-negative integer.");
  }
  return parsed;
}
