/**
 * Test helpers for vitest / jest / node:test against a hosted DotMock LLM mock.
 *
 *   import { connectDotmock, resetDotmock, expectFixtureMatched } from "@dotmock/cli/testing";
 *
 *   let dotmock;
 *   beforeAll(async () => { dotmock = await connectDotmock({ api: "assistant" }); });
 *   beforeEach(() => resetDotmock());
 *   // new OpenAI({ baseURL: dotmock.openaiBaseUrl, apiKey: "dotmock", defaultHeaders: dotmock.headers })
 *
 * Defaults come from the environment, so inside the DotMock GitHub Action no
 * arguments are needed: DOTMOCK_API (id or subdomain), DOTMOCK_API_KEY (or the
 * key saved by `dotmock login`), DOTMOCK_SESSION, and DOTMOCK_API_URL.
 *
 * Every request should carry `X-Dotmock-Session: <session>` (see `headers`) so
 * sequence counters and the journal are isolated per test run.
 */
import { AssertionError } from "node:assert";
import { randomUUID } from "node:crypto";
import { getApiKey, getBaseUrl } from "../config.js";
import type { ActionCaller } from "../lib/api-ref.js";
import { buildConnectInfo } from "../lib/connect.js";
import { entryKey, filterJournal, fixtureOf, normalizeJournal, type JournalEntry } from "../lib/journal.js";
import { fetchMockApi } from "../lib/mock-url.js";

export type { JournalEntry, JournalFilter } from "../lib/journal.js";

export const SESSION_HEADER = "X-Dotmock-Session";

export interface ConnectDotmockOptions {
  /** API id, subdomain, or name. Default: $DOTMOCK_API. */
  api?: string;
  /** DotMock API key. Default: $DOTMOCK_API_KEY or the key saved by `dotmock login`. */
  apiKey?: string;
  /** DotMock API base URL. Default: $DOTMOCK_API_URL or https://dotmock.com/api. */
  apiUrl?: string;
  /** X-Dotmock-Session for this run. Default: $DOTMOCK_SESSION or a random `test-<uuid>`. */
  session?: string;
  /** Reset the session's sequence counters on connect (default true). */
  reset?: boolean;
  /**
   * Export DOTMOCK_URL / OPENAI_BASE_URL / ANTHROPIC_BASE_URL / DOTMOCK_SESSION /
   * DOTMOCK_API on process.env (and placeholder provider keys when unset). Default true.
   */
  setEnv?: boolean;
}

export interface DotmockConnection {
  /** API id. */
  apiId: string;
  session: string;
  /** Hosted mock root, e.g. https://assistant-t1a2b3c4.mock.rest */
  baseUrl: string;
  /** OpenAI-compatible base URL (`<baseUrl>/v1`). */
  openaiBaseUrl: string;
  /** Anthropic SDK base URL (the SDK appends /v1/messages). */
  anthropicBaseUrl: string;
  /** Headers to send with every request (`X-Dotmock-Session`). */
  headers: Record<string, string>;
  env: Record<string, string>;
  reset(): Promise<void>;
  journal(options?: Omit<JournalOptions, "connection">): Promise<JournalEntry[]>;
  expectFixtureMatched(name: string, options?: ExpectFixtureOptions): Promise<JournalEntry[]>;
  disconnect(): void;
}

let current: DotmockConnection | null = null;
const callers = new WeakMap<DotmockConnection, ActionCaller>();
/** Journal entries that existed at the last reset, per connection + session (the hosted journal is not cleared). */
const baselines = new WeakMap<DotmockConnection, Map<string, Set<string>>>();
const previousEnv: Record<string, string | undefined> = {};

function actionCaller(apiKey: string | undefined, apiUrl: string | undefined): ActionCaller {
  return async <T>(action: string, params: Record<string, unknown>): Promise<T> => {
    const key = apiKey ?? getApiKey();
    if (!key) throw new Error("No DotMock API key: pass { apiKey }, set DOTMOCK_API_KEY, or run `dotmock login`.");
    const response = await fetch(`${(apiUrl ?? getBaseUrl()).replace(/\/+$/, "")}/agent/actions/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify({ action, params, context: {} }),
    });
    const text = await response.text();
    let body: Record<string, any> = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
    if (!response.ok || body.success === false) {
      throw new Error(`DotMock ${action} failed${response.ok ? "" : ` (HTTP ${response.status})`}: ${body.message ?? body.error ?? text.slice(0, 300)}`);
    }
    return (body.result ?? body.data) as T;
  };
}

function applyEnv(env: Record<string, string>, onlyIfUnset: string[]): void {
  for (const [key, value] of Object.entries(env)) {
    if (onlyIfUnset.includes(key) && process.env[key]) continue;
    if (!(key in previousEnv)) previousEnv[key] = process.env[key];
    process.env[key] = value;
  }
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete previousEnv[key];
  }
}

/** Resolve a hosted LLM mock and return its base URLs, session headers, and runtime helpers. */
export async function connectDotmock(options: ConnectDotmockOptions = {}): Promise<DotmockConnection> {
  const ref = options.api ?? process.env.DOTMOCK_API;
  if (!ref) throw new Error("connectDotmock needs { api } (id or subdomain) or DOTMOCK_API.");
  const call = actionCaller(options.apiKey, options.apiUrl);
  const session = options.session ?? process.env.DOTMOCK_SESSION ?? `test-${randomUUID()}`;
  const { apiId, baseUrl } = await fetchMockApi(ref, call);
  const info = buildConnectInfo(baseUrl, undefined, session);
  const env = { ...info.env, DOTMOCK_API: apiId };

  const connection: DotmockConnection = {
    apiId,
    session,
    baseUrl: info.baseUrl,
    openaiBaseUrl: info.openaiBaseUrl,
    anthropicBaseUrl: info.baseUrl,
    headers: { [SESSION_HEADER]: session },
    env,
    reset: () => resetDotmock({ connection }),
    journal: (opts = {}) => getJournal({ ...opts, connection }),
    expectFixtureMatched: (name, opts = {}) => expectFixtureMatched(name, { ...opts, connection }),
    disconnect() {
      if (current === connection) current = null;
      restoreEnv();
    },
  };
  current = connection;
  callers.set(connection, call);
  if (options.setEnv ?? true) applyEnv(env, ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"]);
  if (options.reset ?? true) await connection.reset();
  return connection;
}

/** Forget the current connection and restore the environment variables it set. */
export function disconnectDotmock(): void {
  current?.disconnect();
  restoreEnv();
}

export interface RuntimeOptions {
  /** Connection to use (default: the last `connectDotmock()`). */
  connection?: DotmockConnection;
  /** Session override (default: the connection's session). */
  session?: string;
}

function target(options: RuntimeOptions): { connection: DotmockConnection; call: ActionCaller; session: string } {
  const connection = options.connection ?? current;
  const call = connection && callers.get(connection);
  if (!connection || !call) throw new Error("Not connected: call connectDotmock() first.");
  return { connection, call, session: options.session ?? connection.session };
}

async function fetchJournal(call: ActionCaller, apiId: string, session: string, limit: number): Promise<JournalEntry[]> {
  const payload = await call<unknown>("dotmock_get_llm_journal", { apiId, session, limit });
  return filterJournal(normalizeJournal(payload), { session });
}

/**
 * Reset the session's sequence counters on the hosted API. The hosted journal
 * keeps an hour of history, so entries recorded before the reset are
 * remembered and hidden from `getJournal()` / `expectFixtureMatched()`.
 */
export async function resetDotmock(options: RuntimeOptions = {}): Promise<void> {
  const { connection, call, session } = target(options);
  const result = (await call<Record<string, unknown> | undefined>("dotmock_reset_llm_sequences", { apiId: connection.apiId, session })) ?? {};
  if (result.reset === false) throw new Error(`DotMock did not reset sequences: ${JSON.stringify(result.warnings ?? result)}`);
  const seen = new Set((await fetchJournal(call, connection.apiId, session, 1000)).map(entryKey));
  if (!baselines.has(connection)) baselines.set(connection, new Map());
  baselines.get(connection)!.set(session, seen);
}

export interface JournalOptions extends RuntimeOptions {
  /** Only entries answered by this fixture name or id. */
  fixture?: string;
  limit?: number;
  /** Include entries recorded before the last `resetDotmock()` (default false). */
  all?: boolean;
}

/** Read the session's request journal since the last reset, oldest first. */
export async function getJournal(options: JournalOptions = {}): Promise<JournalEntry[]> {
  const { connection, call, session } = target(options);
  const baseline = options.all ? undefined : baselines.get(connection)?.get(session);
  const entries = (await fetchJournal(call, connection.apiId, session, options.limit ?? 1000)).filter(
    (entry) => !baseline?.has(entryKey(entry)),
  );
  return filterJournal(entries, { fixture: options.fixture }).sort(
    (a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0),
  );
}

export interface ExpectFixtureOptions extends RuntimeOptions {
  /** Exact number of matches expected (default: at least one). */
  times?: number;
  /** How long to wait for journal entries to arrive (default 5000 ms). */
  timeoutMs?: number;
  /** Poll interval while waiting (default 250 ms). */
  intervalMs?: number;
}

/**
 * Assert that a fixture (by name or id) answered at least one request in this
 * session since the last reset — or exactly `times` requests. Polls the hosted journal briefly
 * because entries are written asynchronously. Throws an AssertionError listing
 * what did match, so it works with any test runner.
 */
export async function expectFixtureMatched(name: string, options: ExpectFixtureOptions = {}): Promise<JournalEntry[]> {
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  let all: JournalEntry[] = [];
  let hits: JournalEntry[] = [];
  for (;;) {
    all = await getJournal(options);
    hits = filterJournal(all, { fixture: name });
    const enough = options.times === undefined ? hits.length > 0 : hits.length >= options.times;
    if (enough || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, options.intervalMs ?? 250));
  }
  const ok = options.times === undefined ? hits.length > 0 : hits.length === options.times;
  if (!ok) {
    const seen = all.map((entry) => `${entry.path ?? "?"} -> ${fixtureOf(entry) || "(no match)"}`);
    throw new AssertionError({
      message:
        `Expected fixture "${name}" to match ${options.times === undefined ? "at least once" : `${options.times} time(s)`}` +
        `, but it matched ${hits.length} time(s).` +
        (seen.length ? `\nJournal:\n  ${seen.join("\n  ")}` : "\nJournal is empty."),
      actual: hits.length,
      expected: options.times ?? ">= 1",
      operator: "expectFixtureMatched",
    });
  }
  return hits;
}
