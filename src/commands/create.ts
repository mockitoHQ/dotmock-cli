import { Command } from "commander";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { api, ApiError } from "../client.js";
import { success, error, info, json, isJsonMode } from "../output.js";
import { parse as parseYaml } from "yaml";
import {
  parseMockKind,
  specificationTypeForKind,
} from "../mock-kind.js";
import { createEndpointCommand } from "./create-endpoint.js";
import { asRecord, readStructuredFile } from "../structured-input.js";

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
  .option("--type <type>", "API type (rest, graphql, soap, grpc, llm, or webhook)", "rest")
  .option("--from <file>", "Create from file (OpenAPI JSON/YAML or .ts/.tsx)")
  .option("--name <name>", "API name")
  .option("--prompt <text>", "Generate API from a text prompt using AI")
  .option("--subdomain <sub>", "Subdomain for the mock URL")
  .action(async (opts) => {
    try {
      const apiType = parseMockKind(opts.type);
      let result: ActionResult;

      if (opts.from) {
        const ext = extname(opts.from).toLowerCase();
        const code = readFileSync(opts.from, "utf-8");

        if (ext === ".ts" || ext === ".tsx") {
          info("Analyzing TypeScript file...");
          const analysis = await executeAction("dotmock_analyze_typescript", {
            code,
            fileName: opts.from,
          });
          const analyzed = actionData(analysis);
          const openApiSpec = generatedOpenApiSpec(
            analyzed,
            "TypeScript analysis",
          );
          const generatedName =
            opts.name ||
            String(
              (openApiSpec as Record<string, any>).info?.title ||
                "Imported TypeScript API",
            );
          result = await executeAction("dotmock_create_api", {
            name: generatedName,
            subdomain: opts.subdomain || slugify(generatedName),
            mockType: apiType,
            openApiSpec,
            specificationType: specificationTypeForKind(apiType),
          });
        } else {
          info("Parsing OpenAPI spec...");
          let openApiSpec: unknown;
          try {
            openApiSpec = ext === ".yaml" || ext === ".yml" ? parseYaml(code) : JSON.parse(code);
          } catch {
            error(
              "Failed to parse file as JSON or YAML. Ensure it is a valid OpenAPI spec.",
            );
            process.exitCode = 1;
            return;
          }
          result = await executeAction("dotmock_create_api", {
            name: opts.name || "Imported API",
            subdomain: opts.subdomain || slugify(opts.name || "imported-api"),
            mockType: apiType,
            openApiSpec,
            specificationType: specificationTypeForKind(apiType),
          });
        }
      } else if (opts.prompt) {
        info("Generating API from prompt...");
        const generated = await executeAction("dotmock_generate_api", {
          description: opts.prompt,
        });
        const generatedData = actionData(generated);
        const openApiSpec = generatedOpenApiSpec(
          generatedData,
          "API generation",
        );
        const generatedName =
          opts.name ||
          String(
            (openApiSpec as Record<string, any>).info?.title || "Generated API",
          );
        result = await executeAction("dotmock_create_api", {
          name: generatedName,
          subdomain: opts.subdomain || slugify(generatedName),
          mockType: apiType,
          openApiSpec,
          specificationType: specificationTypeForKind(apiType),
          isAiGenerated: true,
        });
      } else {
        const name =
          opts.name ||
          (opts.type === "llm"
            ? "New LLM Mock"
            : opts.type === "webhook"
              ? "New Webhook Mock"
              : "New API");
        result = await executeAction("dotmock_create_api", {
          name,
          subdomain: opts.subdomain || slugify(name),
          specificationType: specificationTypeForKind(apiType),
          mockType: apiType,
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
  .option("--name <name>", "Fixture name (required unless --from provides one)")
  .option("--match <text>", "User message match text")
  .option("--model <model>", "Model match pattern")
  .option("--response <text>", "Response text")
  .option("--from <file>", "Read fixture definition from JSON file")
  .option("--priority <n>", "Priority (lower = matched first)", parseInt)
  .action(async (opts) => {
    try {
      let body: Record<string, unknown>;

      if (opts.from) {
        body = asRecord(readStructuredFile(opts.from), "Fixture definition");
      } else {
        if (!opts.name) {
          error("Provide --name or a fixture file containing name.");
          process.exitCode = 1;
          return;
        }
        body = { name: opts.name, match: {}, response: {} };
        if (opts.match)
          (body.match as Record<string, unknown>).userMessage = opts.match;
        if (opts.model)
          (body.match as Record<string, unknown>).model = opts.model;
        if (opts.response)
          (body.response as Record<string, unknown>).content = opts.response;
        if (opts.priority !== undefined) body.priority = opts.priority;
      }

      if (!body.name) {
        error("Fixture definition must include name.");
        process.exitCode = 1;
        return;
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

      success(`Fixture "${String(body.name)}" created.`);
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
  .description("Create a new API, endpoint, or fixture")
  .addCommand(createApiCommand)
  .addCommand(createEndpointCommand)
  .addCommand(createFixtureCommand);

export function actionData(result: ActionResult): Record<string, unknown> {
  return result.data || result.result || {};
}

export function generatedOpenApiSpec(
  value: Record<string, unknown>,
  source: string,
): Record<string, unknown> {
  const candidate = value.openApiSpec ?? (value.openapi ? value : undefined);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error(`${source} did not return an OpenAPI specification.`);
  }
  return candidate as Record<string, unknown>;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "api"
  );
}
