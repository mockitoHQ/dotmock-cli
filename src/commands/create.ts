import { Command } from "commander";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { api, ApiError } from "../client.js";
import { success, error, info, json, isJsonMode } from "../output.js";

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

const createApiCommand = new Command("api")
  .description("Create a new mock API")
  .option("--type <type>", "API type (rest or llm)", "rest")
  .option("--from <file>", "Create from file (OpenAPI JSON or .ts/.tsx)")
  .option("--name <name>", "API name")
  .option("--prompt <text>", "Generate API from a text prompt using AI")
  .option("--subdomain <sub>", "Subdomain for the mock URL")
  .action(async (opts) => {
    try {
      let result: ActionResult;

      if (opts.from) {
        const ext = extname(opts.from).toLowerCase();
        const code = readFileSync(opts.from, "utf-8");

        if (ext === ".ts" || ext === ".tsx") {
          info("Analyzing TypeScript file...");
          result = await executeAction("mockito_analyze_typescript", {
            code,
            fileName: opts.from,
          });
        } else {
          info("Parsing OpenAPI spec...");
          let openApiSpec: unknown;
          try {
            openApiSpec = JSON.parse(code);
          } catch {
            error(
              "Failed to parse file as JSON. Ensure it is a valid OpenAPI spec.",
            );
            process.exitCode = 1;
            return;
          }
          result = await executeAction("mockito_create_api", {
            name: opts.name || "Imported API",
            subdomain: opts.subdomain || slugify(opts.name || "imported-api"),
            openApiSpec,
            specificationType: "openapi",
          });
        }
      } else if (opts.prompt) {
        info("Generating API from prompt...");
        result = await executeAction("mockito_generate_api", {
          description: opts.prompt,
        });
      } else {
        const name =
          opts.name || (opts.type === "llm" ? "New LLM Mock" : "New API");
        result = await executeAction("mockito_create_api", {
          name,
          subdomain: opts.subdomain || slugify(name),
          specificationType: opts.type === "llm" ? "llm" : "openapi",
          openApiSpec: {
            openapi: "3.0.0",
            info: { title: name, version: "1.0.0" },
            paths: {},
          },
        });
      }

      if (!result.success) {
        error(result.error || "Failed to create API.");
        process.exitCode = 1;
        return;
      }

      if (isJsonMode()) {
        json(result.data || result.result);
        return;
      }

      const data = result.data || result.result || {};
      success(`API created: ${data.name || "Untitled"}`);
      if (data.fullUrl || data.url) info(`URL: ${data.fullUrl || data.url}`);
      if (data.subdomain || data.slug)
        info(`Slug: ${data.subdomain || data.slug}`);
    } catch (err) {
      if (err instanceof ApiError) {
        error(`Failed to create API (HTTP ${err.status}): ${err.message}`);
      } else {
        error(`Failed to create API: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  });

const createFixtureCommand = new Command("fixture")
  .description("Create a new LLM fixture")
  .requiredOption("--api <slug>", "API slug")
  .requiredOption("--name <name>", "Fixture name")
  .option("--match <text>", "User message match text")
  .option("--model <model>", "Model match pattern")
  .option("--response <text>", "Response text")
  .option("--from <file>", "Read fixture definition from JSON file")
  .option("--priority <n>", "Priority (lower = matched first)", parseInt)
  .action(async (opts) => {
    try {
      let body: Record<string, unknown>;

      if (opts.from) {
        const raw = readFileSync(opts.from, "utf-8");
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          error("Failed to parse fixture file as JSON.");
          process.exitCode = 1;
          return;
        }
      } else {
        body = { name: opts.name, match: {}, response: {} };
        if (opts.match)
          (body.match as Record<string, unknown>).userMessage = opts.match;
        if (opts.model)
          (body.match as Record<string, unknown>).model = opts.model;
        if (opts.response)
          (body.response as Record<string, unknown>).content = opts.response;
        if (opts.priority !== undefined) body.priority = opts.priority;
      }

      const result = await api(
        "POST",
        `/mock-apis/${opts.api}/llm-fixtures`,
        body,
      );

      if (isJsonMode()) {
        json(result);
        return;
      }

      success(`Fixture "${opts.name}" created.`);
    } catch (err) {
      if (err instanceof ApiError) {
        error(`Failed to create fixture (HTTP ${err.status}): ${err.message}`);
      } else {
        error(`Failed to create fixture: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  });

export const createCommand = new Command("create")
  .description("Create a new API or fixture")
  .addCommand(createApiCommand)
  .addCommand(createFixtureCommand);

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "api"
  );
}
