/**
 * Test helpers for vitest / jest / node:test.
 *
 *   import { startDotmock, resetDotmock, getJournal, expectFixtureMatched } from "@dotmock/cli/testing";
 *
 *   beforeAll(async () => { await startDotmock({ config: "dotmock.yaml" }); });
 *   afterAll(() => stopDotmock());
 *   beforeEach(() => resetDotmock());
 *
 * When DOTMOCK_URL is set (e.g. by the dotmock GitHub Action) and no config is
 * passed, the helpers attach to that server instead of starting a new one.
 */
import { AssertionError } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  fetchLocalJournal,
  filterJournal,
  fixtureOf,
  resetLocal,
  type JournalEntry,
  type JournalFilter,
} from "../lib/journal.js";
import {
  assertValidProject,
  loadProjectConfig,
  normalizeProjectConfig,
  type ProjectConfig,
  type ResolvedApi,
} from "../lib/project-config.js";
import { apiUrls, freePort, isHealthy, sdkEnv, startServer, type ApiUrl, type RuntimePreference } from "../lib/serve.js";

export type { JournalEntry, JournalFilter } from "../lib/journal.js";
export type { ProjectConfig } from "../lib/project-config.js";

export interface StartDotmockOptions {
  /** Path to dotmock.yaml, or an inline project object. Defaults to $DOTMOCK_CONFIG or ./dotmock.yaml. */
  config?: string | ProjectConfig | Record<string, unknown>;
  /** Port to bind (default: a free port). */
  port?: number;
  runtime?: RuntimePreference;
  image?: string;
  timeoutMs?: number;
  /** Also set OPENAI_BASE_URL / ANTHROPIC_BASE_URL / DOTMOCK_URL on process.env (default true). */
  setEnv?: boolean;
}

export interface DotmockInstance {
  /** Server root, e.g. http://127.0.0.1:53121 */
  url: string;
  apis: ApiUrl[];
  /** `/{subdomain}` base URL for an API (default: first API). */
  baseUrl(api?: string): string;
  /** OpenAI-compatible base URL (`.../v1`) for an LLM API (default: first LLM API). */
  openaiBaseUrl(api?: string): string;
  env: Record<string, string>;
  /** True when attached to an externally started server (DOTMOCK_URL). */
  external: boolean;
  stop(): Promise<void>;
}

let current: DotmockInstance | null = null;
const previousEnv: Record<string, string | undefined> = {};

function instanceFor(url: string, resolved: ResolvedApi[], stop: () => Promise<void>, external: boolean): DotmockInstance {
  const apis = apiUrls(resolved, url);
  const find = (api?: string, llm = false): ApiUrl | undefined =>
    api ? apis.find((a) => a.subdomain === api || a.name === api) : apis.find((a) => !llm || a.type === "llm");
  return {
    url,
    apis,
    external,
    env: sdkEnv(resolved, url),
    baseUrl(api) {
      const hit = find(api);
      if (hit) return hit.baseUrl;
      if (api) return `${url}/${api}`;
      return url;
    },
    openaiBaseUrl(api) {
      const hit = find(api, true);
      return hit?.openaiBaseUrl ?? `${api ? `${url}/${api}` : url}/v1`;
    },
    stop,
  };
}

function materializeConfig(config: StartDotmockOptions["config"]): { path: string; cleanup: () => void } {
  if (config === undefined || typeof config === "string") {
    return { path: config ?? process.env.DOTMOCK_CONFIG ?? "dotmock.yaml", cleanup: () => undefined };
  }
  const dir = mkdtempSync(join(tmpdir(), "dotmock-test-"));
  const path = join(dir, "dotmock.yaml");
  writeFileSync(path, stringifyYaml(normalizeProjectConfig(config)));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function applyEnv(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
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

/** Ask a running server which APIs it serves (GET /__dotmock/apis); falls back to the local config file. */
async function discoverApis(url: string): Promise<ResolvedApi[]> {
  try {
    const response = await fetch(`${url}/__dotmock/apis`, { signal: AbortSignal.timeout(2000) });
    if (response.ok) {
      const body = (await response.json()) as { apis?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
      const list = Array.isArray(body) ? body : body.apis ?? [];
      return list
        .filter((api) => typeof api.subdomain === "string")
        .map((api) => ({
          name: String(api.name ?? api.subdomain),
          subdomain: String(api.subdomain),
          type: String(api.type) === "llm" ? "llm" : "openapi",
        }));
    }
  } catch {
    // fall through
  }
  try {
    return loadProjectConfig(process.env.DOTMOCK_CONFIG ?? "dotmock.yaml").apis;
  } catch {
    return [];
  }
}

/** Start (or attach to) a local DotMock server. Idempotent: returns the running instance. */
export async function startDotmock(options: StartDotmockOptions = {}): Promise<DotmockInstance> {
  if (current) return current;
  const setEnv = options.setEnv ?? true;

  const externalUrl = process.env.DOTMOCK_URL?.replace(/\/+$/, "");
  if (externalUrl && options.config === undefined) {
    if (!(await isHealthy(externalUrl))) {
      throw new Error(`DOTMOCK_URL=${externalUrl} is set but ${externalUrl}/__dotmock/health is not healthy.`);
    }
    current = instanceFor(externalUrl, await discoverApis(externalUrl), async () => { current = null; }, true);
    return current;
  }

  const { path, cleanup } = materializeConfig(options.config);
  try {
    const loaded = loadProjectConfig(path);
    assertValidProject(loaded);
    const port = options.port ?? (await freePort());
    const server = await startServer({
      configPath: loaded.file,
      port,
      runtime: options.runtime,
      image: options.image,
      timeoutMs: options.timeoutMs ?? 60_000,
      name: `dotmock-test-${port}`,
    });
    const instance = instanceFor(server.state.baseUrl, loaded.apis, async () => {
      await server.stop();
      cleanup();
      if (setEnv) restoreEnv();
      if (current === instance) current = null;
    }, false);
    if (setEnv) applyEnv(instance.env);
    current = instance;
    return instance;
  } catch (cause) {
    cleanup();
    throw cause;
  }
}

export async function stopDotmock(): Promise<void> {
  await current?.stop();
  current = null;
}

function serverUrl(url?: string): string {
  const resolved = url ?? current?.url ?? process.env.DOTMOCK_URL;
  if (!resolved) throw new Error("No DotMock server: call startDotmock() first or set DOTMOCK_URL.");
  return resolved.replace(/\/+$/, "");
}

export interface RuntimeOptions {
  /** API subdomain (default: all APIs). */
  api?: string;
  /** X-Dotmock-Session to reset / filter. */
  session?: string;
  /** Server URL override (default: started instance or DOTMOCK_URL). */
  url?: string;
}

/** Reset sequence counters and the journal (POST /__dotmock/reset). */
export async function resetDotmock(options: RuntimeOptions = {}): Promise<void> {
  await resetLocal(serverUrl(options.url), { api: options.api, session: options.session });
}

/** Read the request journal, oldest first. */
export async function getJournal(options: RuntimeOptions & { fixture?: string } = {}): Promise<JournalEntry[]> {
  const entries = await fetchLocalJournal(serverUrl(options.url), options.api, { session: options.session, limit: 1000 });
  return filterJournal(entries, { session: options.session, fixture: options.fixture }).sort(
    (a, b) => Number(a.timestamp ?? 0) - Number(b.timestamp ?? 0),
  );
}

export interface ExpectFixtureOptions extends RuntimeOptions {
  /** Exact number of matches expected (default: at least one). */
  times?: number;
}

/**
 * Assert that a fixture (by name or id) answered at least one request — or
 * exactly `times` requests. Throws an AssertionError listing what did match,
 * so it works with any test runner.
 */
export async function expectFixtureMatched(name: string, options: ExpectFixtureOptions = {}): Promise<JournalEntry[]> {
  const all = await getJournal(options);
  const hits = filterJournal(all, { fixture: name });
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
