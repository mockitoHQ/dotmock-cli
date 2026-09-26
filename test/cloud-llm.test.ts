import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { API_ID, fakeBackend } from "./helpers/fake-backend.js";
import { starterLlmDefinition, validateLlmDefinition } from "../src/lib/llm-definition.js";
import {
  connectDotmock,
  disconnectDotmock,
  expectFixtureMatched,
  getJournal,
  resetDotmock,
} from "../src/testing/index.js";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

describe("init --llm + config apply (hosted LLM API)", () => {
  const { state, server } = fakeBackend();
  let apiUrl: string;
  let dir: string;
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    apiUrl = `http://127.0.0.1:${address.port}`;
    dir = mkdtempSync(join(tmpdir(), "dotmock-cli-test-"));
  });
  after(async () => {
    rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => { state.calls = []; });

  const run = async (...args: string[]) =>
    (await execFileAsync(process.execPath, ["--import", import.meta.resolve("tsx"), join(projectRoot, "src/index.ts"), ...args], {
      cwd: dir,
      env: { ...process.env, DOTMOCK_API_KEY: "mck_test", DOTMOCK_API_URL: apiUrl },
    })).stdout;

  it("starter definition is a valid dotmock/v2 LLM definition with the documented fixtures", () => {
    const definition = starterLlmDefinition();
    assert.equal(definition.schemaVersion, "dotmock/v2");
    assert.equal(definition.kind, "llm");
    assert.deepEqual(validateLlmDefinition(definition).filter((i) => i.severity === "error"), []);
    assert.deepEqual(definition.fixtures!.map((f) => f.name), ["greeting", "weather-tool-call", "structured-output", "refusal", "rate-limit", "fallback"]);
  });

  it("init prints cloud next steps and no local server instructions", async () => {
    const text = await run("init", "--llm");
    assert.match(text, /dotmock login/);
    assert.match(text, /dotmock config apply/);
    assert.match(text, /dotmock llm connect assistant/);
    assert.doesNotMatch(text, /serve|127\.0\.0\.1|localhost/);
    const file = readFileSync(join(dir, "dotmock.yaml"), "utf8");
    assert.doesNotMatch(file, /serve|127\.0\.0\.1|docker|ghcr/);
    assert.equal(parseYaml(file).kind, "llm");
  });

  it("first apply creates the API, records its id, and creates fixtures + settings", async () => {
    const result = JSON.parse(await run("--json", "config", "apply"));
    assert.equal(result.createdApi, true);
    assert.equal(result.apiId, API_ID);
    assert.equal(result.created.length, 6);
    assert.equal(result.settingsUpdated, true);
    assert.equal(parseYaml(readFileSync(join(dir, "dotmock.yaml"), "utf8")).id, API_ID);
    const create = state.calls.find((c) => c.action === "dotmock_create_api")!;
    assert.deepEqual(create.params, { name: "Assistant", subdomain: "assistant", specificationType: "llm", mockType: "llm" });
    assert.equal(state.fixtures.length, 6);
  });

  it("re-apply updates by name, keeps extra hosted fixtures, and --prune deletes them", async () => {
    state.fixtures.push({ id: "fx-extra", name: "hand-made" });
    const second = JSON.parse(await run("--json", "config", "apply"));
    assert.equal(state.calls.some((c) => c.action === "dotmock_create_api"), false);
    assert.equal(second.updated.length, 6);
    assert.deepEqual(second.extra, ["hand-made"]);
    const pruned = JSON.parse(await run("--json", "config", "apply", "--prune"));
    assert.deepEqual(pruned.deleted, ["hand-made"]);
    assert.equal(state.fixtures.length, 6);
  });
});

describe("@dotmock/cli/testing against the hosted API", () => {
  const { state, server } = fakeBackend();
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    state.apis.push({ id: API_ID, name: "Assistant", subdomain: "assistant", fullUrl: "https://assistant-t1a2b3c4.mock.rest" });
    process.env.DOTMOCK_API_URL = `http://127.0.0.1:${address.port}`;
  });
  after(async () => {
    disconnectDotmock();
    delete process.env.DOTMOCK_API_URL;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("connects by subdomain, exports env, and scopes reset/journal to the session", async () => {
    const before = process.env.OPENAI_BASE_URL;
    const dotmock = await connectDotmock({ api: "assistant", apiKey: "mck_test", session: "run-1" });
    assert.equal(dotmock.apiId, API_ID);
    assert.equal(dotmock.openaiBaseUrl, "https://assistant-t1a2b3c4.mock.rest/v1");
    assert.deepEqual(dotmock.headers, { "X-Dotmock-Session": "run-1" });
    assert.equal(process.env.OPENAI_BASE_URL, "https://assistant-t1a2b3c4.mock.rest/v1");
    assert.equal(process.env.DOTMOCK_SESSION, "run-1");
    assert.deepEqual(state.calls.find((c) => c.action === "dotmock_reset_llm_sequences"), { action: "dotmock_reset_llm_sequences", params: { apiId: API_ID, session: "run-1" } });

    state.journal.push(
      { id: "1", timestamp: 1, path: "/v1/chat/completions", session: "run-1", response: { fixtureName: "greeting" } },
      { id: "2", timestamp: 2, path: "/v1/chat/completions", session: "other", response: { fixtureName: "greeting" } },
      { id: "3", timestamp: 3, path: "/v1/messages", session: "run-1", response: { fixtureName: "rate-limit" } },
    );
    assert.deepEqual((await getJournal()).map((e) => e.id), ["1", "3"]);
    await expectFixtureMatched("greeting", { times: 1 });
    await assert.rejects(
      expectFixtureMatched("refusal", { timeoutMs: 0 }),
      /Expected fixture "refusal" to match at least once, but it matched 0 time\(s\)[\s\S]*rate-limit/,
    );
    await resetDotmock();
    assert.equal(state.calls.filter((c) => c.action === "dotmock_reset_llm_sequences").at(-1)!.params.session, "run-1");
    assert.deepEqual(await getJournal(), [], "entries before the reset are hidden");
    assert.equal((await getJournal({ all: true })).length, 2);
    state.journal.push({ id: "4", timestamp: 4, session: "run-1", response: { fixtureName: "greeting" } });
    await expectFixtureMatched("greeting", { times: 1 });

    dotmock.disconnect();
    assert.equal(process.env.OPENAI_BASE_URL, before);
  });
});
