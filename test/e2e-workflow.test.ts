import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { API_ID, fakeBackend } from "./helpers/fake-backend.js";
import { planRows } from "../src/commands/status.js";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * End-to-end: the documented first-run flow against a fake backend that
 * enforces the same approval gate as the real one.
 *   dotmock init --llm -> config validate -> config plan -> config apply -> status
 */
describe("e2e: init -> validate -> plan -> apply -> status", () => {
  const { state, server } = fakeBackend();
  let apiUrl: string;
  let dir: string;
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    apiUrl = `http://127.0.0.1:${address.port}`;
    dir = mkdtempSync(join(tmpdir(), "dotmock-e2e-"));
  });
  after(async () => {
    rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => { state.calls = []; });

  const run = async (args: string[], env: Record<string, string> = {}) => {
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), join(projectRoot, "src/index.ts"), ...args],
        { cwd: dir, env: { ...process.env, CI: "true", DOTMOCK_OUTPUT: "", DOTMOCK_API_KEY: "mck_test", DOTMOCK_API_URL: apiUrl, ...env } },
      );
      return { code: 0, stdout, stderr };
    } catch (cause) {
      const failure = cause as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  };
  const ok = async (...args: string[]) => {
    const result = await run(args);
    assert.equal(result.code, 0, `dotmock ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const file = () => parseYaml(readFileSync(join(dir, "dotmock.yaml"), "utf8"));

  it("init writes a definition that validates locally without --api", async () => {
    await ok("init", "--llm");
    const out = await ok("config", "validate");
    assert.match(out, /dotmock\.yaml is valid/);
    assert.equal(state.calls.length, 0, "LLM validation is local");
  });

  it("plan previews the create without writing anything", async () => {
    const plan = JSON.parse(await ok("--json", "config", "plan"));
    assert.equal(plan.createApi, true);
    assert.equal(plan.create.length, 6);
    assert.ok(state.calls.every((call) => ["dotmock_list_apis", "dotmock_list_llm_fixtures"].includes(call.action)));
  });

  it("first apply creates the API, applies settings with approval before fixtures, and records the real id + subdomain", async () => {
    const out = await ok("config", "apply");
    assert.match(out, /Created LLM API/);
    assert.match(out, /Recorded id: .*subdomain: assistant-x1y2-t1a2b3c4/);
    const actions = state.calls.map((call) => call.action);
    const settingsAt = actions.indexOf("dotmock_update_llm_runtime_settings");
    assert.ok(settingsAt > 0 && settingsAt < actions.indexOf("dotmock_create_llm_fixture"), `settings must precede fixtures: ${actions.join(",")}`);
    assert.equal(state.calls[settingsAt].params.approved, true);
    assert.equal(state.fixtures.length, 6);
    assert.equal(file().id, API_ID);
    assert.equal(file().subdomain, "assistant-x1y2-t1a2b3c4");
    assert.match(readFileSync(join(dir, "dotmock.yaml"), "utf8"), /^# DotMock LLM mock definition/, "comments are preserved");
  });

  it("re-apply is idempotent and targets the recorded id", async () => {
    const result = JSON.parse(await ok("--json", "config", "apply"));
    assert.equal(result.createdApi, false);
    assert.equal(result.updated.length, 6);
    assert.equal(result.wroteBack, undefined);
    assert.equal(state.calls.some((call) => call.action === "dotmock_create_api"), false);
  });

  it("a failing fixture rolls back earlier changes and explains the state", async () => {
    const before = JSON.stringify(state.fixtures);
    state.failOn = { action: "dotmock_update_llm_fixture", name: "refusal", message: "fixture refusal: invalid regex" };
    const result = await run(["config", "apply"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr + result.stdout, /Apply failed: fixture refusal: invalid regex/);
    assert.match(result.stderr + result.stdout, /Rolled back \d+ change\(s\)/);
    assert.equal(JSON.stringify(state.fixtures), before, "fixtures restored");
  });

  it("status renders the current plan shape", async () => {
    const out = await ok("status");
    assert.match(out, /Authenticated/);
    assert.match(out, /Usage balance/);
    assert.match(out, /\$1\.00/);
    assert.match(out, /Active workspaces/);
  });

  it("status survives legacy, partial, and missing plan payloads", async () => {
    for (const plan of [
      { name: "pro", limits: { apis: 10, requestsPerMonth: 100000, teamMembers: 5 }, current: { apis: 2, requestsThisMonth: 1234, teamMembers: 1 } },
      { name: "free", limits: { activeWorkspaces: null } },
      { name: "free" },
      null,
    ]) {
      state.plan = plan;
      const result = await run(["status"]);
      assert.equal(result.code, 0, `status crashed for ${JSON.stringify(plan)}: ${result.stderr}`);
    }
    assert.deepEqual(planRows({ name: "x", limits: { activeWorkspaces: null }, current: { apis: 3 } }).at(-1), ["Active workspaces", "3", "unlimited"]);
  });

  it("llm vcr --mode record sends approval", async () => {
    await ok("llm", "vcr", "assistant", "--mode", "record", "--upstream", "openai=https://api.openai.com");
    const call = state.calls.find((c) => c.action === "dotmock_update_llm_runtime_settings")!;
    assert.equal(call.params.apiId, API_ID, "subdomain prefix resolved to the id");
    assert.equal(call.params.approved, true);
  });

  it("unknown API references fail locally with suggestions", async () => {
    const result = await run(["llm", "connect", "asistant"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /API "asistant" not found.*Did you mean: assistant-x1y2-t1a2b3c4/);
    assert.equal(state.calls.some((call) => call.action === "dotmock_get_api"), false, "never sends a non-id to the backend");
  });

  it("delete api requires --yes in non-interactive shells instead of hanging", async () => {
    const refused = await run(["delete", "api", API_ID]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /re-run with --yes/);
    assert.equal(state.calls.some((call) => call.action === "dotmock_delete_api"), false);
    await ok("delete", "api", "assistant", "--yes");
    assert.deepEqual(state.calls.find((call) => call.action === "dotmock_delete_api")!.params, { apiId: API_ID, approved: true });
  });
});
