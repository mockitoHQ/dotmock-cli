import { Command } from "commander";
import { executeAction } from "../actions.js";
import { error, isJsonMode, json, success, table } from "../output.js";
import { readStructuredFile } from "../structured-input.js";

function requireApproval(options: { yes?: boolean }, action: string) {
  if (!options.yes) throw new Error(`${action} is destructive. Re-run with --yes after reviewing the target.`);
}

function parseValue(raw?: string, file?: string): unknown {
  if (file) return readStructuredFile(file);
  if (raw === undefined) throw new Error("Provide --value <json> or --from <file>.");
  try { return JSON.parse(raw); } catch { throw new Error("--value must be valid JSON."); }
}

async function run<T>(action: string, params: Record<string, unknown>): Promise<T> {
  try {
    return await executeAction<T>(action, params);
  } catch (cause) {
    error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
    throw cause;
  }
}

const resources = new Command("resources")
  .description("List state resource definitions")
  .requiredOption("--api <id>", "API ID or slug")
  .action(async (options) => {
    const rows = await run<Record<string, unknown>[]>("dotmock_list_state_resources", { apiId: options.api });
    if (isJsonMode()) return json(rows);
    table(["Name", "Type", "Entries", "TTL", "ID"], rows.map((row) => [
      String(row.name ?? ""), String(row.type ?? ""), String(row.liveEntryCount ?? "—"),
      row.ttlSeconds ? `${row.ttlSeconds}s` : "persistent", String(row.id ?? ""),
    ]));
  });

const entries = new Command("entries")
  .description("Inspect live entries without extending TTL")
  .requiredOption("--api <id>", "API ID or slug")
  .requiredOption("--resource <id>", "Resource ID")
  .option("--search <query>", "Filter keys")
  .option("--cursor <cursor>", "Pagination cursor")
  .option("--limit <n>", "Page size", Number, 50)
  .action(async (options) => {
    const result = await run<{ entries: Array<Record<string, unknown>>; nextCursor?: string }>("dotmock_list_state_entries", {
      apiId: options.api, resourceId: options.resource, search: options.search, cursor: options.cursor, limit: options.limit,
    });
    if (isJsonMode()) return json(result);
    table(["Key", "Value", "TTL"], result.entries.map((entry) => [
      String(entry.key), JSON.stringify(entry.value), entry.ttlSeconds == null ? "persistent" : `${entry.ttlSeconds}s`,
    ]));
    if (result.nextCursor) success(`Next cursor: ${result.nextCursor}`);
  });

const setEntry = new Command("set")
  .description("Set a typed JSON state entry")
  .requiredOption("--api <id>", "API ID or slug")
  .requiredOption("--resource <id>", "Resource ID")
  .requiredOption("--key <key>", "Entry key")
  .option("--value <json>", "JSON value")
  .option("--from <file>", "Read JSON or YAML value")
  .action(async (options) => {
    const result = await run("dotmock_set_state_entry", { apiId: options.api, resourceId: options.resource, key: options.key, value: parseValue(options.value, options.from) });
    if (isJsonMode()) json(result); else success(`State entry "${options.key}" saved.`);
  });

const deleteEntry = new Command("delete-entry")
  .description("Delete one live state entry")
  .requiredOption("--api <id>", "API ID or slug")
  .requiredOption("--resource <id>", "Resource ID")
  .requiredOption("--key <key>", "Entry key")
  .option("--yes", "Approve destructive deletion")
  .action(async (options) => {
    requireApproval(options, "Entry deletion");
    const result = await run("dotmock_delete_state_entry", { apiId: options.api, resourceId: options.resource, key: options.key, approved: true });
    if (isJsonMode()) json(result); else success(`State entry "${options.key}" deleted.`);
  });

const reset = new Command("reset")
  .description("Reset all state or one resource to its initial seed")
  .requiredOption("--api <id>", "API ID or slug")
  .option("--resource <id>", "Limit reset to one resource")
  .option("--yes", "Approve destructive reset")
  .action(async (options) => {
    requireApproval(options, "State reset");
    const result = await run("dotmock_reset_state", { apiId: options.api, resourceId: options.resource, approved: true });
    if (isJsonMode()) json(result); else success("State reset completed.");
  });

const snapshots = new Command("snapshots")
  .description("List state snapshots")
  .requiredOption("--api <id>", "API ID or slug")
  .action(async (options) => {
    const rows = await run<Record<string, unknown>[]>("dotmock_list_state_snapshots", { apiId: options.api });
    if (isJsonMode()) return json(rows);
    table(["Name", "Created", "ID"], rows.map((row) => [String(row.name ?? ""), String(row.createdAt ?? ""), String(row.id ?? "")]));
  });

const snapshot = new Command("snapshot")
  .description("Create a state snapshot")
  .requiredOption("--api <id>", "API ID or slug")
  .option("--name <name>", "Snapshot name")
  .action(async (options) => {
    const result = await run("dotmock_create_state_snapshot", { apiId: options.api, name: options.name });
    if (isJsonMode()) json(result); else success("State snapshot created.");
  });

const restore = new Command("restore")
  .description("Restore live state from a snapshot")
  .requiredOption("--api <id>", "API ID or slug")
  .requiredOption("--snapshot <id>", "Snapshot ID")
  .option("--yes", "Approve destructive restore")
  .action(async (options) => {
    requireApproval(options, "Snapshot restore");
    const result = await run("dotmock_restore_state_snapshot", { apiId: options.api, snapshotId: options.snapshot, approved: true });
    if (isJsonMode()) json(result); else success("State snapshot restored.");
  });

export const stateCommand = new Command("state")
  .description("Manage workspace state resources, entries, resets, and snapshots")
  .addCommand(resources)
  .addCommand(entries)
  .addCommand(setEntry)
  .addCommand(deleteEntry)
  .addCommand(reset)
  .addCommand(snapshots)
  .addCommand(snapshot)
  .addCommand(restore);
