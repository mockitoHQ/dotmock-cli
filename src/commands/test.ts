import { Command } from "commander";
import { executeAction } from "../actions.js";
import { ApiError } from "../client.js";
import { error, info, isJsonMode, json, success } from "../output.js";
import {
  asRecord,
  collect,
  parseHeaders,
  readStructuredValue,
} from "../structured-input.js";

interface ApiSummary {
  mockType?: string;
  apiKind?: string;
  type?: string;
}

export const testCommand = new Command("test")
  .description("Dry-run a mock without persistence, delivery, proxying, or callouts")
  .requiredOption("--api <id>", "API ID or slug")
  .option("--kind <kind>", "rest, graphql, soap, grpc, llm, or webhook")
  .option("--method <method>", "REST method", "GET")
  .option("--path <path>", "REST path", "/")
  .option("--event <key>", "Webhook event key")
  .option("--target <json|@file>", "Protocol-specific tester target")
  .option("--request <json|@file>", "Complete request object")
  .option("--query <json|@file>", "REST query object")
  .option("--header <name:value>", "REST request header (repeatable)", collect, [])
  .option("--body <json|@file>", "REST body or webhook data")
  .option("--seed <n>", "Deterministic random seed", parseInteger, 0)
  .option("--at <iso-time>", "Virtual time for time-dependent behavior")
  .action(async (opts) => {
    try {
      const api = await executeAction<ApiSummary>("dotmock_get_api", {
        apiId: opts.api,
      });
      const kind = String(
        opts.kind || api.mockType || api.apiKind || api.type || "rest",
      ).toLowerCase();
      const target = opts.target
        ? asRecord(readStructuredValue(opts.target, "--target"), "Tester target")
        : buildTarget(kind, opts);
      const request = opts.request
        ? readStructuredValue(opts.request, "--request")
        : buildRequest(kind, opts);
      const result = await executeAction<Record<string, unknown>>(
        "dotmock_run_mock_test",
        {
          apiId: opts.api,
          target,
          request,
          seed: opts.seed,
          ...(opts.at ? { virtualTime: opts.at } : {}),
        },
      );

      if (isJsonMode()) {
        json(result);
        return;
      }
      const winner = result.winner as Record<string, unknown> | undefined;
      success(winner?.name ? `Matched ${String(winner.name)}.` : "Dry run completed.");
      info("No persistent state or external side effects were applied.");
      console.log(JSON.stringify(result.response, null, 2));
    } catch (cause) {
      if (cause instanceof ApiError) {
        error(`Dry run failed (HTTP ${cause.status}): ${cause.message}`);
      } else {
        error(`Dry run failed: ${cause instanceof Error ? cause.message : "Unknown error"}`);
      }
      process.exitCode = 1;
    }
  });

export function buildTarget(
  kind: string,
  opts: Record<string, any>,
): Record<string, unknown> {
  switch (kind) {
    case "rest":
      return {
        kind,
        method: String(opts.method || "GET").toUpperCase(),
        path: String(opts.path || "/"),
      };
    case "webhook":
      if (!opts.event) throw new Error("Webhook tests require --event.");
      return { kind, eventKey: opts.event };
    case "graphql":
    case "soap":
    case "grpc":
    case "llm":
      throw new Error(
        `${kind} tests require --target with the protocol-specific target object.`,
      );
    default:
      throw new Error(`Unsupported mock kind: ${kind}.`);
  }
}

function buildRequest(kind: string, opts: Record<string, any>): unknown {
  const body = opts.body
    ? readStructuredValue(opts.body, "--body")
    : {};
  if (kind === "webhook") return { data: asRecord(body, "Webhook data") };
  if (kind !== "rest") return body;
  return {
    method: String(opts.method || "GET").toUpperCase(),
    path: String(opts.path || "/"),
    query: opts.query
      ? asRecord(readStructuredValue(opts.query, "--query"), "Query")
      : {},
    headers: parseHeaders(opts.header || []),
    body,
  };
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) throw new Error("Seed must be an integer.");
  return parsed;
}
