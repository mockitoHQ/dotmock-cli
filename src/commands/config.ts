import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ApiError } from "../client.js";
import { executeAction } from "../actions.js";
import { error, info, isJsonMode, json, success, table } from "../output.js";
import { asRecord, readStructuredValue } from "../structured-input.js";
import { ApiNotFoundError, findApi, isApiId, suggestApis } from "../lib/api-ref.js";
import { confirmDestructive } from "../lib/confirm.js";
import {
  createLlmApi,
  executeLlmPlan,
  isLlmDefinition,
  LlmApplyError,
  planLlmSync,
  validateLlmDefinition,
  type LlmDefinition,
} from "../lib/llm-definition.js";

interface DefinitionEnvelope { definition: Record<string, unknown>; etag: string; published?: { revision: number } | null }

const execute = executeAction;

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
  .description("Validate a local definition (default dotmock.yaml) or, with --api and no file, the shared draft")
  .option("--api <id>", "API ID (defaults to the file's id; not needed for kind: llm)")
  .option("-f, --file <file>", "Local YAML or JSON definition (default: dotmock.yaml)")
  .action(async ({ api: apiId, file }) => {
    try {
      const path = file ?? (apiId && !existsSync(resolve("dotmock.yaml")) ? undefined : "dotmock.yaml");
      const definition = path ? loadDefinition(path) : undefined;
      if (definition && isLlmDefinition(definition)) {
        // LLM definitions are validated locally; the backend re-validates each fixture on apply.
        const issues = validateLlmDefinition(definition);
        const result = { valid: !issues.some((issue) => issue.severity === "error"), issues };
        if (isJsonMode()) json(result);
        else {
          for (const issue of issues) info(`${issue.severity.toUpperCase()} ${issue.path}: ${issue.message}`);
          result.valid ? success(`${path} is valid`) : error(`${path} has ${issues.filter((i) => i.severity === "error").length} error(s)`);
        }
        if (!result.valid) process.exitCode = 1;
        return;
      }
      const target = apiId ?? (typeof definition?.id === "string" ? definition.id : undefined);
      if (!target) throw new Error("--api is required for non-LLM definitions without an id.");
      const result = definition
        ? await execute<any>("dotmock_validate_definition", { apiId: target, definition })
        : await execute<any>("dotmock_validate_definition", { apiId: target });
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

function assertValidLlm(definition: LlmDefinition, file: string): void {
  const issues = validateLlmDefinition(definition);
  if (!isJsonMode()) for (const issue of issues.filter((i) => i.severity === "warning")) info(`WARNING ${issue.path}: ${issue.message}`);
  const errors = issues.filter((issue) => issue.severity === "error");
  if (errors.length) throw new Error(`Invalid ${file}:\n${errors.map((issue) => `  ${issue.path}: ${issue.message}`).join("\n")}`);
}

/**
 * Existing hosted API for an LLM definition: --api, then `id`, then
 * `subdomain`/`name`. An explicit --api or a recorded `id` that no longer
 * exists is an error (with suggestions) rather than a silent re-create.
 */
async function findLlmApi(definition: LlmDefinition, explicit?: string): Promise<Record<string, unknown> | undefined> {
  const refs = [explicit, definition.id, definition.subdomain, definition.name].filter((ref): ref is string => typeof ref === "string" && !!ref);
  if (!refs.length) return undefined;
  const apis = await execute<unknown>("dotmock_list_apis", {});
  const pinned = explicit ?? (typeof definition.id === "string" && definition.id ? definition.id : undefined);
  if (pinned) {
    const hit = findApi(apis, pinned);
    if (hit && typeof hit.id === "string") return hit;
    if (explicit && isApiId(explicit)) return { id: explicit };
    throw new ApiNotFoundError(pinned, suggestApis(apis, String(definition.subdomain ?? definition.name ?? pinned)));
  }
  for (const ref of refs) {
    const hit = findApi(apis, ref);
    if (typeof hit?.id === "string") return hit;
  }
  return undefined;
}

/**
 * Record the hosted API's real id (and stored subdomain, which the backend
 * may have adjusted) in the definition so later applies target the same API.
 * Returns the fields that changed.
 */
export function writeBackApiRef(file: string, id: string, subdomain?: string): string[] {
  const path = resolve(file);
  const source = readFileSync(path, "utf8");
  const changed: string[] = [];
  if (path.endsWith(".json")) {
    const value = JSON.parse(source);
    if (value.id !== id) changed.push("id");
    if (subdomain && value.subdomain !== subdomain) changed.push("subdomain");
    if (!changed.length) return changed;
    const next = { schemaVersion: value.schemaVersion, kind: value.kind, id, ...value, ...(subdomain ? { subdomain } : {}) };
    next.id = id;
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
    return changed;
  }
  const lines = source.split("\n");
  const existing = lines.findIndex((line) => /^id:/.test(line));
  if (existing >= 0) {
    if (lines[existing].replace(/^id:\s*/, "").replace(/["']/g, "").trim() !== id) { lines[existing] = `id: ${id}`; changed.push("id"); }
  } else {
    const anchor = lines.findIndex((line) => /^kind:/.test(line));
    lines.splice(anchor >= 0 ? anchor + 1 : lines.findIndex((line) => line.trim() && !line.startsWith("#")), 0, `id: ${id}`);
    changed.push("id");
  }
  if (subdomain) {
    const at = lines.findIndex((line) => /^subdomain:/.test(line));
    const current = at >= 0 ? lines[at].replace(/^subdomain:\s*/, "").replace(/["']/g, "").trim() : undefined;
    if (current !== subdomain) {
      if (at >= 0) lines[at] = `subdomain: ${subdomain}`;
      else lines.splice(lines.findIndex((line) => /^id:/.test(line)) + 1, 0, `subdomain: ${subdomain}`);
      changed.push("subdomain");
    }
  }
  if (changed.length) writeFileSync(path, lines.join("\n"));
  return changed;
}

async function applyLlm(definition: LlmDefinition, file: string, explicitApi: string | undefined, prune: boolean): Promise<void> {
  // 1. Validate everything locally before any write.
  assertValidLlm(definition, file);
  // 2. Plan against the existing API (read-only) so lookups fail before changes.
  const existing = await findLlmApi(definition, explicitApi);
  let created: Record<string, unknown> | undefined;
  let apiId = existing ? String(existing.id) : undefined;
  if (!apiId) {
    created = await createLlmApi(definition);
    apiId = String(created.id);
  }
  const record = created ?? existing ?? {};
  const storedSubdomain = typeof record.subdomain === "string" && record.subdomain ? record.subdomain : undefined;
  // Record the id immediately: if a later step fails the next apply targets this API instead of creating another.
  const written = writeBackApiRef(file, apiId, storedSubdomain);
  const plan = await planLlmSync(apiId, definition, { prune });
  let result;
  try {
    result = await executeLlmPlan(plan);
  } catch (cause) {
    if (cause instanceof LlmApplyError && created) {
      throw new Error(`${cause.message}\nThe API ${apiId} was created and its id saved to ${file}; re-running apply will reuse it.`);
    }
    throw cause;
  }
  const url = String(record.fullUrl ?? record.url ?? "");
  if (isJsonMode()) { json({ ...result, createdApi: !!created, ...(url ? { url } : {}), ...(written.length ? { wroteBack: written } : {}) }); return; }
  if (created) success(`Created LLM API ${String(created.name ?? definition.name ?? "")} (${apiId})${url ? ` at ${url}` : ""}.`);
  if (written.length) info(`Recorded ${written.map((field) => `${field}: ${field === "id" ? apiId : storedSubdomain}`).join(", ")} in ${file} so later applies target this API.`);
  success(`Applied ${file} to ${apiId}: ${result.created.length} created, ${result.updated.length} updated, ${result.deleted.length} deleted${result.settingsUpdated ? ", settings updated" : ""}.`);
  if (result.extra.length) info(`Kept hosted fixtures not in the file: ${result.extra.join(", ")} (use --prune to delete them).`);
  info("LLM fixtures are live immediately. Wire your SDK with `dotmock llm connect " + (storedSubdomain ?? definition.subdomain ?? apiId) + "`.");
}

const plan = new Command("plan")
  .description("Validate a local definition and preview the current draft diff")
  .option("--api <id>", "API ID (LLM definitions: optional, defaults to the file's id/subdomain)")
  .option("-f, --file <file>", "Local YAML or JSON definition", "dotmock.yaml")
  .action(async ({ api: apiId, file }) => {
    try {
      const definition = loadDefinition(file);
      if (isLlmDefinition(definition)) {
        assertValidLlm(definition, file);
        const found = await findLlmApi(definition, apiId);
        const existing = found ? String(found.id) : undefined;
        const planned = existing ? await planLlmSync(existing, definition, { prune: false }) : undefined;
        const result = {
          valid: true,
          apiId: existing ?? null,
          createApi: !existing,
          create: planned ? planned.creates.map((item) => item.name) : (definition.fixtures ?? []).map((fixture) => String(fixture.name)),
          update: planned ? planned.updates.map((item) => item.name) : [],
          extra: planned ? planned.extra : [],
          settings: !!(planned?.settings ?? definition.protocol?.settings),
        };
        if (isJsonMode()) { json(result); return; }
        if (result.createApi) info(`Will create a new LLM API (${definition.subdomain ?? definition.name ?? "unnamed"}).`);
        info(`Fixtures to create: ${result.create.join(", ") || "none"}`);
        info(`Fixtures to update: ${result.update.join(", ") || "none"}`);
        if (result.extra.length) info(`Hosted fixtures not in the file (kept unless --prune): ${result.extra.join(", ")}`);
        success("Plan is valid");
        return;
      }
      if (!apiId) throw new Error("--api is required for non-LLM definitions.");
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
  .description("Apply a local definition (LLM definitions sync fixtures live; others update the draft without publishing)")
  .option("--api <id>", "API ID (LLM definitions: optional, defaults to the file's id/subdomain, created if missing)")
  .option("-f, --file <file>", "Local YAML or JSON definition", "dotmock.yaml")
  .option("--etag <etag>", "Expected draft ETag (defaults to a fresh pull)")
  .option("--prune", "LLM definitions: delete hosted fixtures that are not in the file")
  .action(async ({ api: apiId, file, etag, prune }) => {
    try {
      const definition = loadDefinition(file);
      if (isLlmDefinition(definition)) return await applyLlm(definition, file, apiId, !!prune);
      if (!apiId) throw new Error("--api is required for non-LLM definitions.");
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
  .option("-y, --yes", "Confirm publication for non-interactive use")
  .option("--force", "Alias for --yes")
  .action(async ({ api: apiId, etag, force, yes }) => {
    try {
      if (!(await confirmDestructive(`Publish the current draft for ${apiId}?`, force || yes))) { info("Aborted."); return; }
      const expected = etag || (await execute<DefinitionEnvelope>("dotmock_get_definition", { apiId })).etag;
      const result = await execute<any>("dotmock_publish_definition", { apiId, etag: expected, approved: true });
      if (isJsonMode()) json(result);
      else success(`Published revision ${result.revision ?? result.published?.revision ?? "created"}.`);
    } catch (cause) { handleError(cause); }
  });

const rollback = new Command("rollback")
  .description("Publish a new revision copied from an immutable historical revision")
  .requiredOption("--api <id>", "API ID")
  .requiredOption("--revision <n>", "Historical revision", parsePositiveInteger)
  .option("--etag <etag>", "Expected draft ETag (defaults to a fresh pull)")
  .option("-y, --yes", "Confirm rollback for non-interactive use")
  .option("--force", "Alias for --yes")
  .action(async ({ api: apiId, revision, etag, force, yes }) => {
    try {
      if (!(await confirmDestructive(`Roll back ${apiId} from revision ${revision}?`, force || yes))) { info("Aborted."); return; }
      const expected = etag || (await execute<DefinitionEnvelope>("dotmock_get_definition", { apiId })).etag;
      const result = await execute<any>("dotmock_rollback_definition", { apiId, revision, etag: expected, approved: true });
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
