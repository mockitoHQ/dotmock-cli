import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { Command } from "commander";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { api, ApiError } from "../client.js";
import { error, info, isJsonMode, json, success, table } from "../output.js";
import { asRecord, readStructuredValue } from "../structured-input.js";

interface ActionResult<T = unknown> { success: boolean; result?: T; data?: T; message?: string; error?: string }
interface DefinitionEnvelope { definition: Record<string, unknown>; etag: string; published?: { revision: number } | null }

async function execute<T>(action: string, params: Record<string, unknown>): Promise<T> {
  const response = await api<ActionResult<T>>("POST", "/agent/actions/execute", { action, params, context: {} });
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

const patch = new Command("patch")
  .description("Merge-patch the shared draft without publishing")
  .requiredOption("--api <id>", "API ID")
  .requiredOption("--patch <json|@file>", "JSON/YAML merge patch or @file")
  .option("--etag <etag>", "Expected draft ETag (defaults to a fresh pull)")
  .action(async ({ api: apiId, patch: input, etag }) => {
    try {
      const value = asRecord(readStructuredValue(input, "--patch"), "Draft patch");
      const expected = etag || (await execute<DefinitionEnvelope>("dotmock_get_definition", { apiId })).etag;
      const result = await execute<any>("dotmock_update_definition_draft", { apiId, etag: expected, patch: value });
      if (isJsonMode()) json(result);
      else {
        success(`Draft patched (${result.etag})`);
        info("Live traffic is unchanged until explicit publication.");
      }
    } catch (cause) { handleError(cause); }
  });

const simulate = new Command("simulate")
  .description("Run a deterministic side-effect-free simulation against the draft")
  .requiredOption("--api <id>", "API ID")
  .requiredOption("--request <json|@file>", "Request object or @file")
  .option("--seed <n>", "Deterministic random seed", parseInteger, 0)
  .option("--at <iso-time>", "Virtual time")
  .action(async ({ api: apiId, request, seed, at }) => {
    try {
      const value = asRecord(readStructuredValue(request, "--request"), "Simulation request");
      if (at) value.virtualTime = at;
      const result = await execute<any>("dotmock_simulate_definition", { apiId, request: value, seed });
      if (isJsonMode()) json(result);
      else {
        result.winner
          ? success(`Matched ${result.winner.name || result.winner.ruleId}`)
          : info("No rule matched.");
        console.log(JSON.stringify(result.response, null, 2));
        info("Simulation did not persist state or execute external effects.");
      }
    } catch (cause) { handleError(cause); }
  });

const revisions = new Command("revisions")
  .description("List immutable published revisions")
  .requiredOption("--api <id>", "API ID")
  .action(async ({ api: apiId }) => {
    try {
      const result = await execute<unknown>("dotmock_list_definition_revisions", { apiId });
      const items = Array.isArray(result)
        ? result
        : Array.isArray((result as Record<string, unknown>)?.revisions)
          ? ((result as Record<string, unknown>).revisions as unknown[])
          : [];
      if (isJsonMode()) { json(result); return; }
      if (!items.length) { info("No published revisions."); return; }
      table(
        ["Revision", "Published", "Author", "ETag"],
        items.map((item) => {
          const revision = item as Record<string, unknown>;
          return [
            String(revision.revision ?? revision.version ?? ""),
            String(revision.publishedAt ?? revision.createdAt ?? ""),
            String(revision.publishedBy ?? revision.createdBy ?? ""),
            String(revision.etag ?? ""),
          ];
        }),
      );
    } catch (cause) { handleError(cause); }
  });

const publish = new Command("publish")
  .description("Publish the validated shared draft as a new live revision")
  .requiredOption("--api <id>", "API ID")
  .option("--etag <etag>", "Expected draft ETag (defaults to a fresh pull)")
  .option("--force", "Confirm publication for non-interactive use")
  .action(async ({ api: apiId, etag, force }) => {
    try {
      if (!(await destructiveConfirmation(`Publish the current draft for ${apiId}?`, force))) return;
      const expected = etag || (await execute<DefinitionEnvelope>("dotmock_get_definition", { apiId })).etag;
      const result = await execute<any>("dotmock_publish_definition", { apiId, etag: expected });
      if (isJsonMode()) json(result);
      else success(`Published revision ${result.revision ?? result.published?.revision ?? "created"}.`);
    } catch (cause) { handleError(cause); }
  });

const rollback = new Command("rollback")
  .description("Publish a new revision copied from an immutable historical revision")
  .requiredOption("--api <id>", "API ID")
  .requiredOption("--revision <n>", "Historical revision", parsePositiveInteger)
  .option("--etag <etag>", "Expected draft ETag (defaults to a fresh pull)")
  .option("--force", "Confirm rollback for non-interactive use")
  .action(async ({ api: apiId, revision, etag, force }) => {
    try {
      if (!(await destructiveConfirmation(`Roll back ${apiId} from revision ${revision}?`, force))) return;
      const expected = etag || (await execute<DefinitionEnvelope>("dotmock_get_definition", { apiId })).etag;
      const result = await execute<any>("dotmock_rollback_definition", { apiId, revision, etag: expected });
      if (isJsonMode()) json(result);
      else success(`Rollback published as revision ${result.revision ?? result.published?.revision ?? "created"}.`);
    } catch (cause) { handleError(cause); }
  });

export const configCommand = new Command("config")
  .description("Manage revisioned dotmock.yaml configuration")
  .addCommand(pull)
  .addCommand(validate)
  .addCommand(diff)
  .addCommand(plan)
  .addCommand(apply)
  .addCommand(patch)
  .addCommand(simulate)
  .addCommand(revisions)
  .addCommand(publish)
  .addCommand(rollback);

async function destructiveConfirmation(message: string, force: boolean): Promise<boolean> {
  if (force) return true;
  if (isJsonMode()) {
    throw new Error("Destructive operations require --force in JSON mode.");
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolveAnswer) => {
    rl.question(`${message} (y/N) `, resolveAnswer);
  });
  rl.close();
  if (answer.trim().toLowerCase() === "y") return true;
  info("Aborted.");
  return false;
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) throw new Error("Value must be an integer.");
  return parsed;
}

function parsePositiveInteger(value: string): number {
  const parsed = parseInteger(value);
  if (parsed < 1) throw new Error("Revision must be a positive integer.");
  return parsed;
}
