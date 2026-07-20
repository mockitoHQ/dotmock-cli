import { Command } from "commander";
import { api, ApiError } from "../client.js";
import { success, error, json, isJsonMode } from "../output.js";
import { asRecord, readStructuredFile } from "../structured-input.js";
import { executeAction as execute } from "../actions.js";

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

const updateApiCommand = new Command("api")
  .description("Update a mock API")
  .argument("<slug>", "API slug")
  .option("--name <name>", "New API name")
  .option("--description <text>", "New API description")
  .option("--status <status>", "active or inactive")
  .option("--from <file>", "Replace the OpenAPI specification from JSON or YAML")
  .option("--prompt <changes>", "Evolve the API contract from a change description")
  .action(async (slug: string, opts) => {
    try {
      if (opts.prompt) {
        if (opts.name || opts.description || opts.status || opts.from) {
          throw new Error("Use --prompt by itself, then apply metadata changes separately.");
        }
        const evolved = await executeAction("dotmock_evolve_api", {
          apiId: slug,
          changes: opts.prompt,
        });
        if (!evolved.success) {
          error(evolved.error || "Failed to evolve API.");
          process.exitCode = 1;
          return;
        }
        if (isJsonMode()) json(evolved.data || evolved.result);
        else success(`API "${slug}" evolved.`);
        return;
      }

      const updates: Record<string, unknown> = {};
      if (opts.name) updates.name = opts.name;
      if (opts.description) updates.description = opts.description;
      if (opts.status) {
        if (!["active", "inactive"].includes(opts.status)) {
          throw new Error("Status must be active or inactive.");
        }
        updates.status = opts.status;
      }
      if (opts.from) {
        updates.openApiSpec = asRecord(
          readStructuredFile(opts.from),
          "OpenAPI specification",
        );
      }

      if (Object.keys(updates).length === 0) {
        throw new Error(
          "Provide --name, --description, --status, --from, or --prompt.",
        );
      }

      const result = await executeAction("dotmock_update_api", {
        apiId: slug,
        updates,
      });

      if (!result.success) {
        error(result.error || "Failed to update API.");
        process.exitCode = 1;
        return;
      }

      if (isJsonMode()) {
        json(result.data || result.result);
        return;
      }

      success(`API "${slug}" updated.`);
    } catch (err) {
      if (err instanceof ApiError) {
        error(`Failed to update API (HTTP ${err.status}): ${err.message}`);
      } else {
        error(`Failed to update API: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  });

const updateFixtureCommand = new Command("fixture")
  .description("Update an LLM fixture")
  .requiredOption("--api <slug>", "API slug")
  .requiredOption("--id <id>", "Fixture ID")
  .option("--name <name>", "New fixture name")
  .option("--priority <n>", "New priority", parseInt)
  .option("--match <text>", "New user message match")
  .option("--response <text>", "New response text")
  .option("--from <file>", "Read fixture updates from JSON or YAML")
  .action(async (opts) => {
    try {
      const body: Record<string, unknown> = opts.from
        ? asRecord(readStructuredFile(opts.from), "Fixture update")
        : {};
      if (opts.name) body.name = opts.name;
      if (opts.priority !== undefined) body.priority = opts.priority;
      if (opts.match) body.match = { userMessage: opts.match };
      if (opts.response) body.response = { content: opts.response };

      if (Object.keys(body).length === 0) {
        error(
          "No update fields provided. Use --name, --priority, --match, or --response.",
        );
        process.exitCode = 1;
        return;
      }

      const result = await execute<Record<string, unknown>>(
        "dotmock_update_llm_fixture",
        { apiId: opts.api, fixtureId: opts.id, ...body },
      );

      if (isJsonMode()) {
        json(result);
        return;
      }

      success(`Fixture "${opts.id}" updated.`);
    } catch (err) {
      if (err instanceof ApiError) {
        error(`Failed to update fixture (HTTP ${err.status}): ${err.message}`);
      } else {
        error(`Failed to update fixture: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  });

export const updateCommand = new Command("update")
  .description("Update an API or fixture")
  .addCommand(updateApiCommand)
  .addCommand(updateFixtureCommand);
