import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { api, ApiError } from "../client.js";
import { error, info, isJsonMode, json, success } from "../output.js";

interface ActionResult<T = unknown> { success: boolean; result?: T; data?: T; message?: string; error?: string }
interface DefinitionEnvelope { definition: Record<string, unknown>; etag: string; published?: { revision: number } | null }

async function execute<T>(action: string, params: Record<string, unknown>): Promise<T> {
  const response = await api<ActionResult<T>>("POST", "/internal/mcp/execute-action", { action, params, context: {} });
  if (!response.success) throw new Error(response.message || response.error || `${action} failed`);
  return (response.result ?? response.data) as T;
}

function loadDefinition(file: string): Record<string, unknown> {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`Configuration file not found: ${path}`);
  const source = readFileSync(path, "utf8");
  const value = path.endsWith(".json") ? JSON.parse(source) : parseYaml(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration must be a YAML or JSON object.");
  return value as Record<string, unknown>;
}

function handleError(cause: unknown): void {
  if (cause instanceof ApiError) error(`Configuration request failed (HTTP ${cause.status}): ${cause.message}`);
  else error(cause instanceof Error ? cause.message : "Configuration request failed");
  process.exitCode = 1;
}

const pull = new Command("pull")
  .description("Pull the shared draft as deterministic YAML or JSON")
  .requiredOption("--api <id>", "API ID")
  .option("-o, --output <file>", "Output file", "dotmock.yaml")
  .action(async ({ api: apiId, output }) => {
    try {
      const envelope = await execute<DefinitionEnvelope>("dotmock_get_definition", { apiId });
      const path = resolve(output);
      const body = path.endsWith(".json") ? `${JSON.stringify(envelope.definition, null, 2)}\n` : stringifyYaml(envelope.definition, { sortMapEntries: true, lineWidth: 0 });
      writeFileSync(path, body, { mode: 0o600 });
      if (isJsonMode()) json({ file: path, etag: envelope.etag, publishedRevision: envelope.published?.revision ?? null });
      else success(`Pulled draft to ${path} (${envelope.etag})`);
    } catch (cause) { handleError(cause); }
  });

const validate = new Command("validate")
  .description("Validate the shared draft or a local definition")
  .requiredOption("--api <id>", "API ID")
  .option("-f, --file <file>", "Local YAML or JSON definition")
  .action(async ({ api: apiId, file }) => {
    try {
      const result = file
        ? await execute<any>("dotmock_validate_definition", { apiId, definition: loadDefinition(file) })
        : await execute<any>("dotmock_validate_definition", { apiId });
      if (isJsonMode()) json(result);
      else if (result.valid) success("Definition is valid");
      else { error(`Definition has ${result.issues?.filter((issue: any) => issue.severity === "error").length || 0} error(s)`); for (const issue of result.issues || []) info(`${issue.severity.toUpperCase()} ${issue.path}: ${issue.message}`); process.exitCode = 1; }
    } catch (cause) { handleError(cause); }
  });

const diff = new Command("diff")
  .description("Show the draft-to-published field diff")
  .requiredOption("--api <id>", "API ID")
  .action(async ({ api: apiId }) => {
    try { const result = await execute<any>("dotmock_diff_definition", { apiId }); if (isJsonMode()) json(result); else { info(`Compared with revision ${result.fromRevision ?? "none"}`); for (const change of result.changes || []) console.log(`${change.path}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`); } } catch (cause) { handleError(cause); }
  });

const plan = new Command("plan")
  .description("Validate a local definition and preview the current draft diff")
  .requiredOption("--api <id>", "API ID")
  .requiredOption("-f, --file <file>", "Local YAML or JSON definition")
  .action(async ({ api: apiId, file }) => {
    try {
      const definition = loadDefinition(file);
      const [validation, current] = await Promise.all([
        execute<any>("dotmock_validate_definition", { apiId, definition }),
        execute<DefinitionEnvelope>("dotmock_get_definition", { apiId }),
      ]);
      const result = { valid: validation.valid, issues: validation.issues, expectedDraftEtag: current.etag, willUpdateDraftOnly: true, publicationRequiredSeparately: true };
      if (isJsonMode()) json(result); else { info(`Expected draft ETag: ${current.etag}`); info("Apply updates the draft only; publication remains explicit."); validation.valid ? success("Plan is valid") : error("Plan contains validation errors"); }
      if (!validation.valid) process.exitCode = 1;
    } catch (cause) { handleError(cause); }
  });

const apply = new Command("apply")
  .description("Apply a local definition to the shared draft without publishing")
  .requiredOption("--api <id>", "API ID")
  .requiredOption("-f, --file <file>", "Local YAML or JSON definition")
  .option("--etag <etag>", "Expected draft ETag (defaults to a fresh pull)")
  .action(async ({ api: apiId, file, etag }) => {
    try {
      const definition = loadDefinition(file);
      const expected = etag || (await execute<DefinitionEnvelope>("dotmock_get_definition", { apiId })).etag;
      const result = await execute<any>("dotmock_update_definition_draft", { apiId, etag: expected, definition });
      if (isJsonMode()) json(result); else { success(`Draft updated (${result.etag})`); info("Live traffic is unchanged. Run validation and explicitly publish in DotMock when ready."); }
    } catch (cause) { handleError(cause); }
  });

export const configCommand = new Command("config")
  .description("Manage revisioned dotmock.yaml configuration")
  .addCommand(pull).addCommand(validate).addCommand(diff).addCommand(plan).addCommand(apply);
