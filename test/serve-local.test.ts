import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import {
  loadProjectConfig,
  normalizeProjectConfig,
  starterLlmProject,
  validateProjectConfig,
} from "../src/lib/project-config.js";
import { apiUrls, buildDockerArgs, freePort, resolveRuntime, sdkEnv } from "../src/lib/serve.js";
import {
  expectFixtureMatched,
  getJournal,
  resetDotmock,
  startDotmock,
  stopDotmock,
} from "../src/testing/index.js";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const tsxLoader = import.meta.resolve("tsx");
const fakeServer = fileURLToPath(new URL("./fixtures/fake-dotmock-server.mjs", import.meta.url));
chmodSync(fakeServer, 0o755);

describe("dotmock.yaml project config", () => {
  it("starter LLM project is valid and covers the documented scenarios", () => {
    const config = starterLlmProject();
    assert.deepEqual(validateProjectConfig(config).filter((i) => i.severity === "error"), []);
    const names = config.apis[0].fixtures!.map((f) => f.name);
    for (const name of ["greeting", "weather-tool-call", "structured-output", "refusal", "rate-limit", "fallback"]) {
      assert.ok(names.includes(name), name);
    }
  });

  it("accepts the single-API shorthand and rejects cloud definitions", () => {
    assert.equal(normalizeProjectConfig({ name: "A", subdomain: "a", type: "llm", fixtures: [] }).apis.length, 1);
    assert.throws(() => normalizeProjectConfig({ schemaVersion: "dotmock/v2", rules: [] }), /per-API cloud definition/);
  });

  it("reports structural errors", () => {
    const issues = validateProjectConfig({
      apis: [
        { name: "A", subdomain: "Bad_Sub", type: "llm", fixtures: [{ name: "x" }] },
        { name: "B", subdomain: "b", type: "openapi", spec: "./missing.yaml" },
        { name: "C", subdomain: "b", type: "graphql" as never },
      ],
    });
    const paths = issues.filter((i) => i.severity === "error").map((i) => i.path);
    assert.deepEqual(paths.sort(), ["/apis/0/fixtures/0", "/apis/0/subdomain", "/apis/1/spec", "/apis/2/subdomain", "/apis/2/type"].sort());
  });

  it("derives per-API URLs and SDK env vars", () => {
    const config = starterLlmProject("Chat", "chat");
    assert.deepEqual(apiUrls(config, "http://127.0.0.1:8080")[0], {
      name: "Chat", subdomain: "chat", type: "llm",
      baseUrl: "http://127.0.0.1:8080/chat", openaiBaseUrl: "http://127.0.0.1:8080/chat/v1",
    });
    assert.equal(sdkEnv(config, "http://127.0.0.1:8080").OPENAI_BASE_URL, "http://127.0.0.1:8080/chat/v1");
  });
});

describe("serve runtime selection", () => {
  it("builds a docker run with the config directory mounted read-only", () => {
    const args = buildDockerArgs({ configPath: "/work/proj/dotmock.yaml", port: 9000, image: "img:tag", detach: true });
    assert.deepEqual(args.slice(0, 2), ["run", "-d"]);
    assert.ok(args.includes("127.0.0.1:9000:8080"));
    assert.ok(args.includes("/work/proj:/dotmock:ro"));
    assert.ok(args.includes("DOTMOCK_LOCAL_MODE=true"));
    assert.ok(args.includes("DOTMOCK_LOCAL_CONFIG=/dotmock/dotmock.yaml"));
    assert.equal(args.at(-1), "img:tag");
  });

  it("prefers a dotmock-server binary and falls back to docker", () => {
    const saved = process.env.DOTMOCK_SERVER_BIN;
    delete process.env.DOTMOCK_SERVER_BIN;
    try {
      const dir = mkdtempSync(join(tmpdir(), "dotmock-path-"));
      writeFileSync(join(dir, "docker"), "#!/bin/sh\n", { mode: 0o755 });
      assert.equal(resolveRuntime("auto", dir).kind, "docker");
      writeFileSync(join(dir, "dotmock-server"), "#!/bin/sh\n", { mode: 0o755 });
      assert.equal(resolveRuntime("auto", dir).kind, "binary");
      assert.equal(resolveRuntime("docker", dir).kind, "docker");
      assert.throws(() => resolveRuntime("auto", join(dir, "nope")), /Neither dotmock-server nor docker/);
      rmSync(dir, { recursive: true, force: true });
    } finally {
      if (saved !== undefined) process.env.DOTMOCK_SERVER_BIN = saved;
    }
  });
});

describe("init + serve --detach + llm journal/reset --local (fake local server)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dotmock-serve-"));
  const env = { ...process.env, DOTMOCK_SERVER_BIN: fakeServer, DOTMOCK_STATE_DIR: join(dir, "state") };
  let port = 0;
  const run = async (...args: string[]) =>
    (await execFileAsync(process.execPath, ["--import", tsxLoader, join(projectRoot, "src/index.ts"), ...args], { cwd: dir, env })).stdout;

  before(async () => { port = await freePort(); });
  after(async () => {
    await run("serve", "stop", "--port", String(port)).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("scaffolds, serves, reads the journal, resets, and stops", async () => {
    const init = JSON.parse(await run("--json", "init", "--llm", "--subdomain", "chat"));
    assert.equal(init.apis[0].subdomain, "chat");
    assert.match(readFileSync(join(dir, "dotmock.yaml"), "utf8"), /weather-tool-call/);
    await assert.rejects(run("init", "--llm"), /already exists/);

    const started = JSON.parse(await run("--json", "serve", "--detach", "--port", String(port), "--timeout", "10"));
    assert.equal(started.runtime, "binary");
    assert.equal(started.env.OPENAI_BASE_URL, `http://127.0.0.1:${port}/chat/v1`);

    const base = `http://127.0.0.1:${port}`;
    await fetch(`${base}/chat/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dotmock-Session": "t1" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hello" }] }),
    });
    const journal = JSON.parse(await run("--json", "llm", "journal", "chat", "--local", base, "--session", "t1"));
    assert.equal(journal[0].response.fixtureName, "greeting");

    await run("--json", "llm", "reset", "chat", "--local", base, "--session", "t1");
    const resets = await (await fetch(`${base}/__test/resets`)).json();
    assert.deepEqual(resets, [{ api: "chat", session: "t1" }]);

    const status = JSON.parse(await run("--json", "serve", "status", "--port", String(port)));
    assert.equal(status.healthy, true);
    assert.deepEqual(JSON.parse(await run("--json", "serve", "stop", "--port", String(port))), { stopped: true, port });
  });
});

describe("@dotmock/cli/testing helpers (fake local server)", () => {
  const saved = process.env.DOTMOCK_SERVER_BIN;
  before(() => { process.env.DOTMOCK_SERVER_BIN = fakeServer; });
  after(async () => {
    await stopDotmock();
    if (saved === undefined) delete process.env.DOTMOCK_SERVER_BIN;
    else process.env.DOTMOCK_SERVER_BIN = saved;
  });

  it("starts from an inline config, exports env, and asserts fixture matches", async () => {
    const before = process.env.OPENAI_BASE_URL;
    const dotmock = await startDotmock({ config: starterLlmProject("Chat", "chat"), timeoutMs: 10_000 });
    assert.equal(process.env.OPENAI_BASE_URL, dotmock.openaiBaseUrl());
    assert.equal(dotmock.openaiBaseUrl("chat"), `${dotmock.url}/chat/v1`);

    await fetch(`${dotmock.openaiBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello there" }] }),
    });
    await expectFixtureMatched("greeting");
    await expectFixtureMatched("greeting", { times: 1, api: "chat" });
    await assert.rejects(expectFixtureMatched("refusal"), /Expected fixture "refusal".*matched 0.*greeting/s);

    await resetDotmock();
    assert.deepEqual(await getJournal(), []);
    await stopDotmock();
    assert.equal(process.env.OPENAI_BASE_URL, before);
  });
});

describe("loadProjectConfig", () => {
  it("resolves OpenAPI spec paths relative to the project file", () => {
    const dir = mkdtempSync(join(tmpdir(), "dotmock-cfg-"));
    writeFileSync(join(dir, "openapi.yaml"), "openapi: 3.0.0\n");
    writeFileSync(join(dir, "dotmock.yaml"), "apis:\n  - name: Orders\n    subdomain: orders\n    type: openapi\n    spec: ./openapi.yaml\n");
    const loaded = loadProjectConfig(join(dir, "dotmock.yaml"));
    assert.deepEqual(loaded.issues, []);
    rmSync(dir, { recursive: true, force: true });
  });
});
