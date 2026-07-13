import { readFileSync } from "node:fs";
import { Command } from "commander";
import { executeAction } from "../actions.js";
import { ApiError } from "../client.js";
import { error, isJsonMode, json, success } from "../output.js";
import { readStructuredFile } from "../structured-input.js";

const analyzeOpenApiCommand = new Command("openapi")
  .description("Validate and summarize an OpenAPI JSON or YAML contract")
  .requiredOption("--from <file>", "OpenAPI JSON or YAML file")
  .action(async (opts) => {
    await runAnalysis("OpenAPI analysis", async () =>
      executeAction("dotmock_analyze_openapi", {
        spec: readStructuredFile(opts.from),
        format: opts.from.endsWith(".yaml") || opts.from.endsWith(".yml")
          ? "yaml"
          : "json",
      }),
    );
  });

const analyzeTypeScriptCommand = new Command("typescript")
  .description("Convert TypeScript models to an OpenAPI contract without creating an API")
  .requiredOption("--from <file>", "TypeScript file")
  .option("--no-endpoints", "Generate schemas without CRUD endpoints")
  .action(async (opts) => {
    await runAnalysis("TypeScript analysis", async () =>
      executeAction("dotmock_analyze_typescript", {
        code: readFileSync(opts.from, "utf8"),
        generateEndpoints: opts.endpoints !== false,
      }),
    );
  });

async function runAnalysis(label: string, operation: () => Promise<unknown>) {
  try {
    const result = await operation();
    if (isJsonMode()) json(result);
    else {
      success(`${label} completed.`);
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (cause) {
    if (cause instanceof ApiError) {
      error(`${label} failed (HTTP ${cause.status}): ${cause.message}`);
    } else {
      error(`${label} failed: ${cause instanceof Error ? cause.message : "Unknown error"}`);
    }
    process.exitCode = 1;
  }
}

export const analyzeCommand = new Command("analyze")
  .description("Analyze contracts without creating or mutating a mock")
  .addCommand(analyzeOpenApiCommand)
  .addCommand(analyzeTypeScriptCommand);
