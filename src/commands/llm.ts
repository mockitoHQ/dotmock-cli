import chalk from "chalk";
import { Command } from "commander";
import { ApiError } from "../client.js";
import { buildConnectInfo, CONNECT_SNIPPET_KEYS, renderEnv } from "../lib/connect.js";
import {
  entryKey,
  fetchLocalJournal,
  filterJournal,
  fixtureOf,
  formatTimestamp,
  normalizeJournal,
  resetLocal,
  type JournalEntry,
} from "../lib/journal.js";
import {
  getJournal,
  listRecordings,
  promoteRecording,
  resetSequences,
  updateLlmSettings,
} from "../lib/llm-runtime.js";
import { fetchMockBaseUrl } from "../lib/mock-url.js";
import { error, info, isJsonMode, json, success, table } from "../output.js";

export const DEFAULT_LOCAL_URL = "http://127.0.0.1:8080";

export function localUrl(value: unknown): string | null {
  if (value === undefined || value === false) return null;
  const url = typeof value === "string" && value ? value : process.env.DOTMOCK_URL || DEFAULT_LOCAL_URL;
  return url.replace(/\/+$/, "");
}

function fail(cause: unknown, what: string): void {
  if (cause instanceof ApiError) error(`${what} failed (HTTP ${cause.status}): ${cause.message}`);
  else error(`${what} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 1;
}

function parseIntStrict(label: string, min = 0) {
  return (value: string): number => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < min) throw new Error(`${label} must be an integer >= ${min}.`);
    return parsed;
  };
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

// ---------- journal ----------

function journalRow(entry: JournalEntry): string[] {
  const status = entry.response?.status;
  const chaos = entry.response?.chaosAction;
  const vcr = entry.response?.vcrProxied ? "vcr:proxy" : entry.response?.vcrReplayed ? "vcr:replay" : "";
  return [
    formatTimestamp(entry.timestamp),
    String(entry.provider ?? ""),
    String(entry.path ?? ""),
    fixtureOf(entry) || chalk.dim("(no match)"),
    status === undefined ? "" : String(status),
    String(entry.session ?? "default"),
    [chaos ? `chaos:${chaos}` : "", vcr].filter(Boolean).join(" "),
  ];
}

const JOURNAL_HEADERS = ["Time", "Provider", "Path", "Fixture", "Status", "Session", "Notes"];

function chronological(entries: JournalEntry[]): JournalEntry[] {
  return [...entries].sort((a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0));
}

const journalCommand = new Command("journal")
  .description("Show recent LLM requests and which fixture answered them")
  .argument("<api>", "API ID or slug (subdomain with --local)")
  .option("--session <id>", "Only entries for this X-Dotmock-Session")
  .option("--fixture <name>", "Only entries answered by this fixture name or id")
  .option("--limit <n>", "Entries to fetch (1-1000)", parseIntStrict("--limit", 1), 50)
  .option("-f, --follow", "Keep polling and print new entries")
  .option("--interval <ms>", "Polling interval for --follow", parseIntStrict("--interval", 100), 1000)
  .option("--local [url]", "Read a local `dotmock serve` journal (default $DOTMOCK_URL or http://127.0.0.1:8080)")
  .action(async (apiId: string, opts) => {
    const local = localUrl(opts.local);
    const fetchEntries = async (): Promise<JournalEntry[]> => {
      const entries = local
        ? await fetchLocalJournal(local, apiId, { session: opts.session, limit: opts.limit })
        : normalizeJournal(await getJournal(apiId, { limit: opts.limit, session: opts.session }));
      return filterJournal(entries, { session: opts.session, fixture: opts.fixture });
    };
    try {
      if (!opts.follow) {
        const entries = await fetchEntries();
        if (isJsonMode()) { json(entries); return; }
        if (!entries.length) { info("No journal entries (the journal keeps the last hour)."); return; }
        table(JOURNAL_HEADERS, chronological(entries).map(journalRow));
        return;
      }

      const seen = new Set<string>();
      let stopped = false;
      process.once("SIGINT", () => { stopped = true; });
      if (!isJsonMode()) info(`Following journal for ${apiId} (Ctrl+C to stop)...`);
      while (!stopped) {
        for (const entry of chronological(await fetchEntries())) {
          const key = entryKey(entry);
          if (seen.has(key)) continue;
          seen.add(key);
          if (isJsonMode()) console.log(JSON.stringify(entry));
          else console.log(journalRow(entry).filter(Boolean).join("  "));
        }
        await new Promise((r) => setTimeout(r, opts.interval));
      }
    } catch (cause) { fail(cause, "Journal request"); }
  });

// ---------- reset ----------

const resetCommand = new Command("reset")
  .description("Reset LLM sequence counters (all sessions, or one with --session)")
  .argument("<api>", "API ID or slug (subdomain with --local)")
  .option("--session <id>", "Only reset this X-Dotmock-Session")
  .option("--local [url]", "Reset a local `dotmock serve` (counters + journal)")
  .action(async (apiId: string, opts) => {
    try {
      const local = localUrl(opts.local);
      const result = local
        ? await resetLocal(local, { api: apiId, session: opts.session })
        : await resetSequences(apiId, opts.session);
      if (isJsonMode()) { json(result ?? { reset: true }); return; }
      const record = (result ?? {}) as Record<string, unknown>;
      if (record.reset === false) {
        error(`Sequences were not reset: ${JSON.stringify(record.warnings ?? record)}`);
        process.exitCode = 1;
        return;
      }
      success(`Reset sequence counters for ${apiId}${opts.session ? ` (session ${opts.session})` : " (all sessions)"}.`);
    } catch (cause) { fail(cause, "Reset"); }
  });

// ---------- recordings / promote ----------

const recordingsCommand = new Command("recordings")
  .description("List VCR recordings captured from upstream providers")
  .argument("<api>", "API ID or slug")
  .option("--limit <n>", "Recordings to fetch (1-1000)", parseIntStrict("--limit", 1), 50)
  .option("--provider <name>", "Only recordings from this provider (openai, anthropic, ...)")
  .action(async (apiId: string, opts) => {
    try {
      const result = await listRecordings(apiId, { limit: opts.limit, provider: opts.provider });
      const items = Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
      if (isJsonMode()) { json(result); return; }
      if (!items.length) { info("No recordings. Enable VCR with `dotmock llm vcr <api> --upstream openai=https://api.openai.com --mode record`."); return; }
      table(
        ["Index", "Id", "Recorded", "Provider", "Model", "Status", "Endpoint"],
        items.map((item) => [
          String(item.index ?? ""),
          String(item.id ?? ""),
          formatTimestamp(item.recordedAt),
          String(item.provider ?? ""),
          String(item.model ?? ""),
          String(item.status ?? ""),
          String(item.endpoint ?? ""),
        ]),
      );
      info("Promote one to a fixture with `dotmock llm promote <api> <id-or-index>`.");
    } catch (cause) { fail(cause, "Recordings request"); }
  });

const promoteCommand = new Command("promote")
  .description("Turn a VCR recording into a fixture")
  .argument("<api>", "API ID or slug")
  .argument("<recording>", "Recording id or list index from `dotmock llm recordings`")
  .option("--name <name>", "Fixture name")
  .option("--priority <n>", "Fixture priority", parseIntStrict("--priority", 0))
  .action(async (apiId: string, recording: string, opts) => {
    try {
      const overrides: { name?: string; priority?: number } = {};
      if (opts.name) overrides.name = opts.name;
      if (opts.priority !== undefined) overrides.priority = opts.priority;
      const result = (await promoteRecording(apiId, recording, overrides)) as Record<string, unknown> | undefined;
      if (isJsonMode()) { json(result); return; }
      success(`Promoted recording ${recording} to fixture ${String(result?.name ?? result?.id ?? "")}.`);
    } catch (cause) { fail(cause, "Promote"); }
  });

// ---------- vcr ----------

export const VCR_MODES: Record<string, string> = { record: "record", replay: "replay", off: "none" };

export function buildVcrSettings(upstreams: string[], mode?: string): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  if (upstreams.length) {
    const map: Record<string, string> = {};
    for (const pair of upstreams) {
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new Error(`--upstream must be provider=https://host (got ${pair}).`);
      const provider = pair.slice(0, eq).trim().toLowerCase();
      const url = pair.slice(eq + 1).trim();
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new Error(`Invalid upstream URL for ${provider}: ${url}`); }
      if (parsed.protocol !== "https:") throw new Error(`Upstream for ${provider} must use https:// (got ${url}).`);
      map[provider] = url.replace(/\/+$/, "");
    }
    settings.vcrUpstreams = map;
  }
  if (mode !== undefined) {
    const type = VCR_MODES[mode];
    if (!type) throw new Error("--mode must be record, replay, or off.");
    settings.fallback = { type };
  }
  if (!Object.keys(settings).length) throw new Error("Pass --upstream provider=url and/or --mode record|replay|off.");
  return settings;
}

const vcrCommand = new Command("vcr")
  .description("Configure Lite VCR: proxy unmatched requests to real providers and record them")
  .argument("<api>", "API ID or slug")
  .option("--upstream <provider=url>", "Upstream base URL per provider, e.g. openai=https://api.openai.com (repeatable)", collect, [])
  .option("--mode <mode>", "record (proxy + record unmatched), replay (serve recordings), or off")
  .action(async (apiId: string, opts) => {
    try {
      const settings = buildVcrSettings(opts.upstream, opts.mode);
      const result = await updateLlmSettings(apiId, settings);
      if (isJsonMode()) { json(result); return; }
      success(`Updated VCR settings for ${apiId}.`);
      const upstreams = settings.vcrUpstreams as Record<string, string> | undefined;
      for (const [provider, url] of Object.entries(upstreams ?? {})) info(`${provider} -> ${url}`);
      if (opts.mode) info(`Mode: ${opts.mode} (fallback.type=${VCR_MODES[opts.mode]})`);
      if (opts.mode === "record") info("Client API keys are forwarded upstream; review recordings with `dotmock llm recordings`.");
    } catch (cause) { fail(cause, "VCR update"); }
  });

// ---------- connect ----------

const connectCommand = new Command("connect")
  .description("Print the base URL, env vars, and SDK snippets for an LLM mock")
  .argument("<api>", "API ID or slug (subdomain with --local)")
  .option("--local [url]", "Use a local `dotmock serve` (default $DOTMOCK_URL or http://127.0.0.1:8080)")
  .option("--sdk <name>", `Only print one snippet (${CONNECT_SNIPPET_KEYS.join(", ")})`)
  .option("--model <model>", "Model name used in snippets", "gpt-4o-mini")
  .option("--env", "Only print shell exports (eval \"$(dotmock llm connect <api> --env)\")")
  .action(async (apiId: string, opts) => {
    try {
      const local = localUrl(opts.local);
      const baseUrl = local ? `${local}/${apiId}` : await fetchMockBaseUrl(apiId);
      const connect = buildConnectInfo(baseUrl, opts.model);
      if (opts.sdk && !connect.snippets[opts.sdk]) throw new Error(`Unknown --sdk ${opts.sdk}. Use one of: ${CONNECT_SNIPPET_KEYS.join(", ")}.`);
      if (isJsonMode()) {
        json(opts.sdk ? { ...connect, snippets: { [opts.sdk]: connect.snippets[opts.sdk] } } : connect);
        return;
      }
      if (opts.env) { console.log(renderEnv(connect.env)); return; }
      info(`Base URL:        ${chalk.underline(connect.baseUrl)}`);
      info(`OpenAI base URL: ${chalk.underline(connect.openaiBaseUrl)}`);
      console.log("\n" + chalk.bold("Environment"));
      console.log(renderEnv(connect.env));
      const keys = opts.sdk ? [opts.sdk] : Object.keys(connect.snippets);
      for (const key of keys) {
        console.log("\n" + chalk.bold(key));
        console.log(connect.snippets[key]);
      }
      console.log("\n" + chalk.dim("Tip: send X-Dotmock-Session to isolate sequence counters per test and X-Dotmock-Seed for reproducible chaos."));
    } catch (cause) { fail(cause, "Connect"); }
  });

export const llmCommand = new Command("llm")
  .description("LLM mock runtime: journal, sequences, VCR recordings, and SDK wiring")
  .addCommand(journalCommand)
  .addCommand(resetCommand)
  .addCommand(recordingsCommand)
  .addCommand(promoteCommand)
  .addCommand(vcrCommand)
  .addCommand(connectCommand);
