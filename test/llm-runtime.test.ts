import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { buildVcrSettings } from "../src/commands/llm.js";
import { buildConnectInfo, CONNECT_SNIPPET_KEYS } from "../src/lib/connect.js";
import { filterJournal, normalizeJournal } from "../src/lib/journal.js";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

const JOURNAL = [
  { id: "2", timestamp: 2, path: "/v1/chat/completions", provider: "openai", session: "s1", response: { status: 200, fixtureName: "greeting", fixtureId: "fx-greeting" } },
  { id: "1", timestamp: 1, path: "/v1/messages", provider: "anthropic", response: { status: 429, fixtureName: "rate-limit" } },
];

describe("llm helpers", () => {
  it("filters journal entries by session (default session) and fixture name or id", () => {
    const entries = normalizeJournal(JOURNAL);
    assert.deepEqual(filterJournal(entries, { session: "s1" }).map((e) => e.id), ["2"]);
    assert.deepEqual(filterJournal(entries, { session: "default" }).map((e) => e.id), ["1"]);
    assert.deepEqual(filterJournal(entries, { fixture: "fx-greeting" }).map((e) => e.id), ["2"]);
    assert.deepEqual(normalizeJournal({ entries: JOURNAL }).length, 2);
  });

  it("maps VCR flags to backend settings", () => {
    assert.deepEqual(buildVcrSettings(["OpenAI=https://api.openai.com/"], "record"), {
      vcrUpstreams: { openai: "https://api.openai.com" },
      fallback: { type: "record" },
    });
    assert.deepEqual(buildVcrSettings([], "off"), { fallback: { type: "none" } });
    assert.throws(() => buildVcrSettings(["openai=http://api.openai.com"]), /https/);
    assert.throws(() => buildVcrSettings(["openai"]), /provider=/);
    assert.throws(() => buildVcrSettings([], "sometimes"), /record, replay, or off/);
    assert.throws(() => buildVcrSettings([]), /--upstream/);
  });

  it("builds SDK wiring for every supported client", () => {
    const info = buildConnectInfo("http://127.0.0.1:8080/assistant/");
    assert.equal(info.openaiBaseUrl, "http://127.0.0.1:8080/assistant/v1");
    assert.equal(info.env.OPENAI_BASE_URL, "http://127.0.0.1:8080/assistant/v1");
    assert.equal(info.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8080/assistant");
    assert.deepEqual(Object.keys(info.snippets).sort(), [...CONNECT_SNIPPET_KEYS].sort());
    assert.match(info.snippets["vercel-ai-sdk"], /createOpenAI\(\{ baseURL: "http:\/\/127\.0\.0\.1:8080\/assistant\/v1"/);
    assert.match(info.snippets["langchain-python"], /base_url="http:\/\/127\.0\.0\.1:8080\/assistant\/v1"/);
    assert.match(info.snippets["anthropic-node"], /baseURL: "http:\/\/127\.0\.0\.1:8080\/assistant"/);
  });
});

describe("dotmock llm CLI against the backend", () => {
  let server: Server;
  let baseUrl: string;
  let requests: Array<{ method: string; url: string; body: any }> = [];
  before(async () => {
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text ? JSON.parse(text) : undefined;
      requests.push({ method: request.method!, url: request.url!, body });
      const ok = (data: unknown) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ success: true, data }));
      };
      if (request.url !== "/agent/actions/execute" || request.headers["x-api-key"] !== "mck_test") {
        response.writeHead(404, { "Content-Type": "application/json" });
        return response.end(JSON.stringify({ message: "unexpected route" }));
      }
      switch (body.action) {
        case "dotmock_get_api": return ok({ subdomain: "chat", _dx: { baseUrl: "https://chat.dotmock.com" } });
        case "dotmock_get_llm_journal": return ok(JOURNAL);
        case "dotmock_list_llm_recordings": return ok([{ index: 0, id: "rec_1", provider: "openai", model: "gpt-4o", status: 200, request: {}, response: {} }]);
        case "dotmock_promote_llm_recording": return ok({ id: "fx-new", name: body.params.name ?? "Recorded" });
        default: return ok({ reset: true, keysDeleted: 1, ...body.params });
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => { requests = []; });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const run = async (...args: string[]) =>
    (await execFileAsync(process.execPath, ["--import", "tsx", "src/index.ts", "--json", ...args], {
      cwd: projectRoot,
      env: { ...process.env, DOTMOCK_API_KEY: "mck_test", DOTMOCK_API_URL: baseUrl },
    })).stdout;

  it("journal uses the journal action and filters by fixture", async () => {
    const entries = JSON.parse(await run("llm", "journal", "api-1", "--fixture", "rate-limit", "--session", "default"));
    assert.deepEqual(entries.map((e: any) => e.id), ["1"]);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body, { action: "dotmock_get_llm_journal", params: { apiId: "api-1", limit: 50, session: "default" }, context: {} });
  });

  it("reset sends the session to the sequence-reset action", async () => {
    const result = JSON.parse(await run("llm", "reset", "api-1", "--session", "ci-42"));
    assert.equal(result.reset, true);
    assert.equal(requests[0].body.action, "dotmock_reset_llm_sequences");
    assert.deepEqual(requests[0].body.params, { apiId: "api-1", session: "ci-42" });
  });

  it("recordings and promote use the recording actions (id or index)", async () => {
    const recordings = JSON.parse(await run("llm", "recordings", "api-1", "--provider", "openai"));
    assert.equal(recordings[0].id, "rec_1");
    assert.deepEqual(requests[0].body.params, { apiId: "api-1", limit: 50, provider: "openai" });
    const promoted = JSON.parse(await run("llm", "promote", "api-1", "rec_1", "--name", "Weather", "--priority", "5"));
    assert.equal(promoted.name, "Weather");
    assert.deepEqual(requests[1].body.params, { apiId: "api-1", recordingId: "rec_1", name: "Weather", priority: 5 });
  });

  it("vcr patches settings through the runtime-settings action", async () => {
    await run("llm", "vcr", "api-1", "--upstream", "openai=https://api.openai.com", "--mode", "record");
    assert.equal(requests[0].body.action, "dotmock_update_llm_runtime_settings");
    assert.deepEqual(requests[0].body.params.settings, {
      vcrUpstreams: { openai: "https://api.openai.com" },
      fallback: { type: "record" },
    });
  });

  it("connect resolves the cloud base URL", async () => {
    const info = JSON.parse(await run("llm", "connect", "chat", "--sdk", "openai-python"));
    assert.equal(info.env.OPENAI_BASE_URL, "https://chat.dotmock.com/v1");
    assert.deepEqual(Object.keys(info.snippets), ["openai-python"]);
  });
});
