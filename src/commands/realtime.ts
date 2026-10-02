import { Command } from "commander";
import WebSocket from "ws";
import { executeAction } from "../actions.js";
import { isJsonMode, json, success, table } from "../output.js";
import { readStructuredFile, readStructuredValue } from "../structured-input.js";

type TokenResult = {
  token: string;
  url: string;
  routedUrl: string;
  expiresAt: string;
  seed?: string | null;
};

function duration(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("Duration must be a positive number of seconds.");
  return parsed * 1000;
}

function payload(value?: string): unknown {
  if (!value) return undefined;
  return readStructuredValue(value, "message");
}

async function token(options: {
  api: string;
  target: string;
  transport: "sse" | "websocket";
  path: string;
  seed?: string;
  expires?: number;
}): Promise<TokenResult> {
  return executeAction<TokenResult>("dotmock_issue_realtime_token", {
    apiId: options.api,
    targetId: options.target,
    transport: options.transport,
    path: options.path,
    seed: options.seed,
    expiresInSeconds: options.expires,
  });
}

export function parseSSE(source: string): Array<Record<string, unknown>> {
  return source
    .replaceAll("\r\n", "\n")
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event: Record<string, unknown> = { data: "" };
      const data: string[] = [];
      const comments: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) comments.push(line.slice(1).trimStart());
        else {
          const separator = line.indexOf(":");
          const field = separator < 0 ? line : line.slice(0, separator);
          const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
          if (field === "data") data.push(value);
          else if (["event", "id", "retry"].includes(field)) event[field] = field === "retry" ? Number(value) : value;
        }
      }
      event.data = data.join("\n");
      if (comments.length) event.comments = comments;
      return event;
    });
}

const targets = new Command("targets")
  .description("List, apply, or delete realtime targets")
  .requiredOption("--api <id>", "Workspace ID")
  .option("--from <file>", "Create or update a target from JSON or YAML")
  .option("--delete <id>", "Delete a target and its scenarios")
  .option("--etag <etag>", "Draft ETag for optimistic concurrency")
  .action(async (options) => {
    let result: any;
    if (options.from) result = await executeAction("dotmock_upsert_realtime_target", { apiId: options.api, target: readStructuredFile(options.from), etag: options.etag });
    else if (options.delete) result = await executeAction("dotmock_delete_realtime_target", { apiId: options.api, targetId: options.delete, etag: options.etag, approved: true });
    else result = await executeAction<any>("dotmock_list_realtime_targets", { apiId: options.api });
    if (isJsonMode() || options.from || options.delete) json(result);
    else table(["Transport", "Name", "Path / channel", "ID"], (result.targets || []).map((item: any) => [item.transport, item.name, item.path || item.channelId || "-", item.id]));
  });

const scenarios = new Command("scenarios")
  .description("List, apply, or delete declarative realtime scenarios")
  .requiredOption("--api <id>", "Workspace ID")
  .option("--target <id>", "Filter to a target")
  .option("--from <file>", "Create or update a scenario from JSON or YAML")
  .option("--delete <id>", "Delete a scenario")
  .option("--etag <etag>", "Draft ETag for optimistic concurrency")
  .action(async (options) => {
    let result: any;
    if (options.from) result = await executeAction("dotmock_upsert_realtime_scenario", { apiId: options.api, scenario: readStructuredFile(options.from), etag: options.etag });
    else if (options.delete) result = await executeAction("dotmock_delete_realtime_scenario", { apiId: options.api, scenarioId: options.delete, etag: options.etag, approved: true });
    else result = await executeAction<any>("dotmock_list_realtime_scenarios", { apiId: options.api, targetId: options.target });
    if (isJsonMode() || options.from || options.delete) json(result);
    else table(["Trigger", "Name", "Target", "Enabled", "ID"], (result.scenarios || []).map((item: any) => [item.trigger?.type, item.name, item.targetId, item.enabled ? "yes" : "no", item.id]));
  });

const tokenCommand = new Command("token")
  .description("Issue a short-lived browser-native connection URL")
  .requiredOption("--api <id>", "Workspace ID")
  .requiredOption("--target <id>", "Target ID")
  .requiredOption("--transport <sse|websocket>", "Transport")
  .requiredOption("--path <path>", "Target path")
  .option("--seed <seed>", "Replay seed")
  .option("--expires <seconds>", "Token lifetime, at most one hour", Number)
  .action(async (options) => json(await token(options)));

const sse = new Command("sse")
  .description("Listen to an SSE target with optional replay inputs")
  .requiredOption("--api <id>", "Workspace ID")
  .requiredOption("--target <id>", "Target ID")
  .requiredOption("--path <path>", "SSE path")
  .option("--method <method>", "OpenAPI method", "GET")
  .option("--body <json|@file>", "Request body")
  .option("--last-event-id <id>", "Resume after an event ID")
  .option("--seed <seed>", "Fixed or recorded seed")
  .option("--duration <seconds>", "Stop after this duration", "30")
  .option("--routed", "Use the Caddy /mock route")
  .action(async (options) => {
    const issued = await token({ ...options, transport: "sse" });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), duration(options.duration));
    try {
      const response = await fetch(options.routed ? issued.routedUrl : issued.url, {
        method: options.method.toUpperCase(),
        headers: {
          Accept: "text/event-stream",
          ...(options.lastEventId ? { "Last-Event-ID": options.lastEventId } : {}),
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body ? JSON.stringify(payload(options.body)) : undefined,
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`SSE handshake failed with HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      for (;;) {
        const { value, done } = await reader.read();
        buffered += decoder.decode(value, { stream: !done });
        const boundary = buffered.lastIndexOf("\n\n");
        if (boundary >= 0) {
          const complete = buffered.slice(0, boundary + 2);
          buffered = buffered.slice(boundary + 2);
          for (const event of parseSSE(complete)) console.log(JSON.stringify(event));
        }
        if (done) break;
      }
    } catch (cause) {
      if (!(cause instanceof Error && cause.name === "AbortError")) throw cause;
    } finally {
      clearTimeout(timeout);
    }
  });

const ws = new Command("ws")
  .description("Connect one or more WebSocket clients and exchange UTF-8 text or JSON")
  .requiredOption("--api <id>", "Workspace ID")
  .requiredOption("--target <id>", "Target ID")
  .requiredOption("--path <path>", "WebSocket path")
  .option("--message <json|text|@file>", "Message sent by every client")
  .option("--clients <count>", "Virtual client count", Number, 1)
  .option("--subprotocol <name>", "Negotiated subprotocol")
  .option("--seed <seed>", "Fixed or recorded seed")
  .option("--duration <seconds>", "Connection duration", "10")
  .option("--routed", "Use the Caddy /mock route")
  .action(async (options) => {
    const issued = await token({ ...options, transport: "websocket" });
    const clients = Math.max(1, Math.min(100, options.clients));
    const events: Array<Record<string, unknown>> = [];
    const started = Date.now();
    const sockets = Array.from({ length: clients }, (_, index) => {
      const socket = new WebSocket(options.routed ? issued.routedUrl : issued.url, options.subprotocol ? [options.subprotocol] : undefined);
      socket.on("open", () => {
        events.push({ client: index + 1, direction: "open", atMs: Date.now() - started, protocol: socket.protocol });
        if (options.message) {
          const value = payload(options.message);
          socket.send(typeof value === "string" ? value : JSON.stringify(value));
        }
      });
      socket.on("message", (data) => events.push({ client: index + 1, direction: "out", atMs: Date.now() - started, data: data.toString() }));
      socket.on("close", (code, reason) => events.push({ client: index + 1, direction: "close", atMs: Date.now() - started, code, reason: reason.toString() }));
      socket.on("error", (cause) => events.push({ client: index + 1, direction: "error", atMs: Date.now() - started, error: cause.message }));
      return socket;
    });
    await new Promise((resolve) => setTimeout(resolve, duration(options.duration)));
    for (const socket of sockets) socket.close(1000, "CLI duration elapsed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (isJsonMode()) json({ seed: issued.seed, events });
    else table(["ms", "client", "direction", "payload / close"], events.map((event) => [String(event.atMs), String(event.client), String(event.direction), String(event.data || event.reason || event.error || event.code || "")]));
  });

const exportContract = new Command("export")
  .description("Export the composite DotMock definition and AsyncAPI contract")
  .requiredOption("--api <id>", "Workspace ID")
  .action(async (options) => json(await executeAction("dotmock_get_definition", { apiId: options.api })));

const importContract = new Command("import")
  .description("Attach or replace an AsyncAPI 2.6.x/3.0.x contract in the draft")
  .requiredOption("--api <id>", "Workspace ID")
  .requiredOption("--from <file>", "AsyncAPI JSON or YAML")
  .option("--publish", "Validate and atomically publish after import")
  .action(async (options) => {
    const current = await executeAction<any>("dotmock_get_definition", { apiId: options.api });
    const definition = structuredClone(current.definition);
    definition.protocol = { ...definition.protocol, asyncapi: readStructuredFile(options.from) };
    let saved = await executeAction<any>("dotmock_update_definition_draft", { apiId: options.api, definition, etag: current.etag });
    if (options.publish) saved = await executeAction("dotmock_publish_definition", { apiId: options.api, etag: saved.etag, approved: true });
    if (isJsonMode()) json(saved); else success(options.publish ? "AsyncAPI imported and published." : "AsyncAPI imported into the draft.");
  });

const traffic = new Command("traffic")
  .description("Inspect bounded realtime connection timelines")
  .requiredOption("--api <id>", "Workspace ID")
  .option("--limit <count>", "Session count", Number, 50)
  .action(async (options) => json(await executeAction("dotmock_list_realtime_traffic", { apiId: options.api, limit: options.limit })));

const usage = new Command("usage")
  .description("Inspect realtime usage totals and limits")
  .requiredOption("--api <id>", "Workspace ID")
  .action(async (options) => json(await executeAction("dotmock_get_realtime_usage", { apiId: options.api })));

const promote = new Command("promote")
  .description("Promote a reviewed capture into a declarative scenario")
  .requiredOption("--api <id>", "Workspace ID")
  .requiredOption("--traffic <id>", "Traffic session ID")
  .requiredOption("--target <id>", "Target ID")
  .requiredOption("--from <file>", "JSON/YAML action array or object containing actions")
  .option("--name <name>", "Scenario name")
  .option("--yes", "Approve the draft mutation")
  .action(async (options) => {
    if (!options.yes) throw new Error("Capture promotion changes the draft. Re-run with --yes after reviewing it.");
    const input: any = readStructuredFile(options.from);
    const actions = Array.isArray(input) ? input : input.actions;
    const result = await executeAction("dotmock_promote_realtime_capture", { apiId: options.api, trafficId: options.traffic, targetId: options.target, name: options.name, actions, approved: true });
    if (isJsonMode()) json(result); else success("Realtime capture promoted into the draft.");
  });

export const realtimeCommand = new Command("realtime")
  .description("Manage AsyncAPI contracts, SSE streams, WebSockets, traffic, and usage")
  .addCommand(importContract)
  .addCommand(exportContract)
  .addCommand(targets)
  .addCommand(scenarios)
  .addCommand(tokenCommand)
  .addCommand(sse)
  .addCommand(ws)
  .addCommand(traffic)
  .addCommand(usage)
  .addCommand(promote);
