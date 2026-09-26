import { Command } from "commander";
import { executeAction } from "../actions.js";
import { ApiError } from "../client.js";
import { captureMethod, capturePath, extractLogs, findCapture } from "../lib/captures.js";
import { error, isJsonMode, json, methodColor, success, table } from "../output.js";

function parseLimit(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) throw new Error("--limit must be between 1 and 1000.");
  return parsed;
}

async function capturePayload(apiId: string, limit: number): Promise<unknown> {
  return executeAction<unknown>("dotmock_get_traffic_logs", { apiId, limit });
}

function fail(cause: unknown): void {
  if (cause instanceof ApiError) error(`Capture request failed (HTTP ${cause.status}): ${cause.message}`);
  else error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
}

const listCommand = new Command("list")
  .description("Print captured traffic for a mock API")
  .requiredOption("--api <api>", "API ID or slug")
  .option("--limit <n>", "Maximum records (1-1000)", parseLimit, 50)
  .action(async (opts) => {
    try {
      const payload = await capturePayload(opts.api, opts.limit);
      if (isJsonMode()) { json(payload); return; }
      const logs = extractLogs(payload);
      if (!logs.length) { success("No captures found."); return; }
      table(
        ["Time", "Method", "Path", "Status"],
        logs.map((capture) => [
          String(capture.timestamp ?? capture.createdAt ?? ""),
          methodColor(captureMethod(capture)),
          capturePath(capture),
          String(capture.statusCode ?? capture.status ?? ""),
        ]),
      );
    } catch (cause) { fail(cause); }
  });

const assertCommand = new Command("assert")
  .description("Assert that DotMock captured a matching request (exit 1 when none matched)")
  .requiredOption("--api <api>", "API ID or slug")
  .option("--method <method>", "Expected HTTP method")
  .option("--path <path>", "Expected request path (exact)")
  .option("--body-contains <text>", "Substring expected anywhere in the capture")
  .option("--limit <n>", "Number of recent captures to search (1-1000)", parseLimit, 50)
  .action(async (opts) => {
    try {
      const method = opts.method ? String(opts.method).toUpperCase() : "";
      const path = opts.path ? String(opts.path) : "";
      const bodyContains = opts.bodyContains ? String(opts.bodyContains) : "";
      if (!method && !path && !bodyContains) {
        throw new Error("captures assert requires at least --method, --path, or --body-contains");
      }
      const logs = extractLogs(await capturePayload(opts.api, opts.limit));
      const capture = findCapture(logs, { method, path, bodyContains });
      const result = capture
        ? { matched: true, apiId: opts.api, method, path, capture }
        : { matched: false, apiId: opts.api, method, path };
      if (isJsonMode()) json(result);
      else if (capture) success(`Matched ${captureMethod(capture).toUpperCase()} ${capturePath(capture)}`);
      else error(`No capture matched${method ? ` method=${method}` : ""}${path ? ` path=${path}` : ""}${bodyContains ? ` body~${JSON.stringify(bodyContains)}` : ""} in the last ${logs.length} request(s).`);
      if (!capture) process.exitCode = 1;
    } catch (cause) { fail(cause); }
  });

export const capturesCommand = new Command("captures")
  .alias("capture")
  .description("Inspect and assert on traffic DotMock captured from the app under test")
  .addCommand(listCommand)
  .addCommand(assertCommand);
