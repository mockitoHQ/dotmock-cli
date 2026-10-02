import { Command } from "commander";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { api, ApiError } from "../client.js";
import { success, error, info, json, isJsonMode } from "../output.js";
import { parse as parseYaml } from "yaml";
import { parseMockKind, specificationTypeForKind } from "../mock-kind.js";
import { createEndpointCommand } from "./create-endpoint.js";
import { asRecord, readStructuredFile } from "../structured-input.js";
import { executeAction as execute } from "../actions.js";
import { contractInput } from "./grpc.js";
import { detectImportFormat, toImportSpec } from "../lib/import-formats.js";

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

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
  return api<ActionResult>("POST", "/agent/actions/execute", {
    action,
    params,
    context: {},
  });
}

const createApiCommand = new Command("api")
  .description("Create a new mock API")
  .option(
    "--type <type>",
    "API type (rest, realtime, graphql, soap, grpc, llm, or webhook)",
    "rest",
  )
  .option(
    "--from <file>",
    "Create from OpenAPI/Swagger, AsyncAPI, Postman collection, HAR, TypeScript, .proto source, or descriptor set",
  )
  .option("--name <name>", "API name")
  .option("--prompt <text>", "Generate API from a text prompt using AI")
  .option("--subdomain <sub>", "Subdomain for the mock URL")
  .action(async (opts) => {
    try {
      const apiType = parseMockKind(opts.type);
      let result: ActionResult;

      if (opts.from) {
        if (apiType === "grpc") {
          const generatedName = opts.name || "Imported gRPC API";
          result = await executeAction("dotmock_create_api", {
            name: generatedName,
            subdomain: opts.subdomain || slugify(generatedName),
            mockType: apiType,
            specificationType: specificationTypeForKind(apiType),
          });
          if (!result.success)
            throw new Error(
              result.error ||
                result.message ||
                "Failed to create gRPC workspace.",
            );
          const created = actionData(result);
          const apiId = String(created.id || "");
          if (!apiId)
            throw new Error("Created gRPC workspace did not return an API ID.");
          const imported = await executeAction("dotmock_import_grpc_contract", {
            apiId,
            contract: contractInput(opts.from),
          });
          if (!imported.success)
            throw new Error(
              imported.error ||
                imported.message ||
                "Failed to import protobuf contract.",
            );
        } else {
          const ext = extname(opts.from).toLowerCase();
          if (statSync(opts.from).size > MAX_IMPORT_BYTES)
            throw new Error(`${opts.from} is larger than 25 MB; trim it (e.g. filter a HAR to API calls) and retry.`);
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
            let parsed: unknown;
            try {
              parsed =
                ext === ".yaml" || ext === ".yml"
                  ? parseYaml(code)
                  : JSON.parse(code);
            } catch {
              error(
                "Failed to parse file as JSON or YAML. Expected OpenAPI/Swagger, AsyncAPI, a Postman collection, or a HAR file.",
              );
              process.exitCode = 1;
              return;
            }
            const format = detectImportFormat(parsed, opts.from);
            const isSwagger2 = format === "openapi" && typeof (parsed as Record<string, unknown>).swagger === "string";
            // Postman, HAR, and Swagger 2.0 are converted by the backend importer
            // (schema inference, examples); older backends fall back to the
            // client-side converter.
            const serverImport = apiType === "rest" && (format === "postman" || format === "har" || isSwagger2);
            const imported = serverImport
              ? await executeAction("dotmock_import_api", {
                  content: parsed,
                  format: "auto",
                  ...(opts.name ? { name: opts.name } : {}),
                  ...(opts.subdomain ? { subdomain: opts.subdomain } : {}),
                })
              : undefined;
            if (imported?.success) {
              const details = (actionData(imported).import ?? {}) as Record<string, any>;
              info(`Imported ${String(details.format ?? format)} (${String(details.summary?.endpointCount ?? "?")} operations).`);
              for (const warning of (details.warnings as unknown[] | undefined) ?? []) info(`WARNING ${String(warning)}`);
              result = imported;
            } else {
              if (imported && !/UNCLASSIFIED_ACTION|no security policy|unexpected action/i.test(String(imported.error ?? imported.message ?? ""))) {
                throw new Error(String(imported.message || imported.error || "Import failed."));
              }
              const { spec: openApiSpec } = toImportSpec(parsed, opts.from);
              if (format === "postman" || format === "har") {
                const count = Object.values(openApiSpec.paths ?? {}).reduce<number>((total, item) => total + Object.keys(item as object).length, 0);
                if (!count) throw new Error(`${opts.from}: no API requests found in the ${format === "har" ? "HAR file" : "Postman collection"}.`);
                info(`Converted ${format === "har" ? "HAR" : "Postman collection"} to OpenAPI (${count} operation${count === 1 ? "" : "s"} with recorded examples).`);
              } else {
                info(format === "asyncapi" ? "Parsing AsyncAPI spec..." : "Parsing OpenAPI spec...");
              }
              const importedName = opts.name || String(openApiSpec.info?.title || "Imported API");
              result = await executeAction("dotmock_create_api", {
                name: importedName,
                subdomain: opts.subdomain || slugify(importedName),
                mockType: apiType,
                ...(apiType === "realtime"
                  ? { asyncApiSpec: openApiSpec }
                  : { openApiSpec }),
                specificationType: specificationTypeForKind(apiType),
              });
            }
          }
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
          ...(apiType === "rest" || apiType === "realtime"
            ? {
                openApiSpec: {
                  openapi: "3.2.0",
                  info: { title: name, version: "1.0.0" },
                  paths: {},
                },
              }
            : {}),
          ...(apiType === "realtime"
            ? {
                asyncApiSpec: {
                  asyncapi: "3.0.0",
                  info: { title: name, version: "1.0.0" },
                  channels: {},
                  operations: {},
                },
              }
            : {}),
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

      const result = await execute<Record<string, unknown>>(
        "dotmock_create_llm_fixture",
        { apiId: opts.api, ...body },
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
