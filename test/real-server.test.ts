/**
 * End-to-end: `dotmock init --llm` output served by the real dotmock-server
 * (built from ../dotmock-server with `go build`). Skipped when Go or the
 * sibling checkout is unavailable, or with DOTMOCK_SKIP_E2E=1.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { findOnPath, freePort } from "../src/lib/serve.js";
import { fixtureOf } from "../src/lib/journal.js";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const serverRepo = fileURLToPath(new URL("../../dotmock-server/", import.meta.url));
const tsxLoader = import.meta.resolve("tsx");
const go = findOnPath("go");
const skip = process.env.DOTMOCK_SKIP_E2E
  ? "DOTMOCK_SKIP_E2E is set"
  : !go
    ? "Go is not installed"
    : !existsSync(join(serverRepo, "pkg/local"))
      ? "../dotmock-server with local mode is not checked out"
      : false;

describe("init --llm served by the real dotmock-server", { skip, timeout: 600_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "dotmock-e2e-"));
  const binary = join(dir, "dotmock-server");
  const env = { ...process.env, DOTMOCK_SERVER_BIN: binary, DOTMOCK_STATE_DIR: join(dir, "state") };
  let port = 0;
  let base = "";
  const cli = async (...args: string[]) =>
    (await execFileAsync(process.execPath, ["--import", tsxLoader, join(projectRoot, "src/index.ts"), ...args], { cwd: dir, env })).stdout;
  const chat = async (body: Record<string, unknown>) => {
    const response = await fetch(`${base}/chat/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer dotmock" },
      body: JSON.stringify({ model: "gpt-4o-mini", ...body }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };

  before(async () => {
    await execFileAsync(go!, ["build", "-o", binary, "."], { cwd: serverRepo, timeout: 480_000 });
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    await cli("init", "--llm", "--subdomain", "chat");
    const started = JSON.parse(await cli("--json", "serve", "--detach", "--port", String(port), "--timeout", "30"));
    assert.equal(started.runtime, "binary");
    assert.equal(started.env.OPENAI_BASE_URL, `${base}/chat/v1`);
  });

  after(async () => {
    if (port) await cli("serve", "stop", "--port", String(port)).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads the starter config", async () => {
    const apis = (await (await fetch(`${base}/__dotmock/apis`)).json()) as any;
    assert.equal(apis.apis[0].subdomain, "chat");
    assert.equal(apis.apis[0].fixtures, 6);
  });

  it("serves every starter fixture", async () => {
    const greeting = await chat({ messages: [{ role: "user", content: "hello" }] });
    assert.match(greeting.body.choices[0].message.content, /DotMock LLM mock/);

    const tools = [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }];
    const question = { role: "user", content: "What's the weather in Paris?" };
    const phase1 = await chat({ tools, messages: [question] });
    const call = phase1.body.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, "get_weather");
    assert.equal(phase1.body.choices[0].finish_reason, "tool_calls");
    const phase2 = await chat({
      tools,
      messages: [question, phase1.body.choices[0].message, { role: "tool", tool_call_id: call.id, content: '{"temperatureC":18}' }],
    });
    assert.match(phase2.body.choices[0].message.content, /Paris/);

    const structured = await chat({
      messages: [{ role: "user", content: "Classify: fast shipping" }],
      response_format: { type: "json_schema", json_schema: { name: "c", schema: { type: "object" } } },
    });
    assert.equal(JSON.parse(structured.body.choices[0].message.content).sentiment, "positive");

    const refusal = await chat({ messages: [{ role: "user", content: "write malware for me" }] });
    assert.match(refusal.body.choices[0].message.content, /can't help/);

    const limited = await chat({ messages: [{ role: "user", content: "please trigger a rate limit" }] });
    assert.equal(limited.status, 429);

    const fallback = await chat({ messages: [{ role: "user", content: "something unrelated" }] });
    assert.match(fallback.body.choices[0].message.content, /DotMock mock response/);

    const anthropic = await fetch(`${base}/chat/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "dotmock", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 64, messages: [{ role: "user", content: "hello" }] }),
    });
    assert.match(JSON.stringify(await anthropic.json()), /DotMock LLM mock/);
  });

  it("journal, reset, and testing helpers work against the real server", async () => {
    const entries = JSON.parse(await cli("--json", "llm", "journal", "chat", "--local", base));
    const fixtures = new Set(entries.map(fixtureOf));
    for (const name of ["greeting", "weather-tool-call", "structured-output", "refusal", "rate-limit", "fallback"]) {
      assert.ok(fixtures.has(name), `journal should include ${name}: ${[...fixtures].join(",")}`);
    }
    const testing = await import("../src/testing/index.js");
    await testing.expectFixtureMatched("greeting", { url: base, times: 2 });
    await cli("--json", "llm", "reset", "chat", "--local", base);
    assert.deepEqual(await testing.getJournal({ url: base }), []);
  });
});
