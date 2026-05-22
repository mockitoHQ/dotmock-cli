import { Command } from "commander";
import { api, ApiError } from "../client.js";
import { success, error, json, isJsonMode } from "../output.js";

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
  .option("--delay <ms>", "Response delay in milliseconds", parseInt)
  .action(async (opts) => {
    try {
      const config: Record<string, unknown> = {
        defaultResponse: {
          status: opts.status ?? 200,
          body: {},
          headers: { "Content-Type": "application/json" },
        },
      };

      if (opts.body) {
        try {
          (config.defaultResponse as Record<string, unknown>).body = JSON.parse(
            opts.body,
          );
        } catch {
          (config.defaultResponse as Record<string, unknown>).body = opts.body;
        }
      }
      if (opts.delay !== undefined) config.delay = opts.delay;

      const params: Record<string, unknown> = {
        apiId: opts.api,
        method: opts.method.toUpperCase(),
        path: opts.path,
        config,
      };

      const result = await executeAction("mockito_configure_endpoint", params);

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
  .alias("config")
  .description("Configure API endpoints")
  .addCommand(configureEndpointCommand);
