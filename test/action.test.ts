import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { renderLlmDefinitionYaml, starterLlmDefinition } from "../src/lib/llm-definition.js";
import { API_ID, fakeBackend } from "./helpers/fake-backend.js";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function parseGithubFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([^<]+)<<(.+)$/);
    if (!m) continue;
    const value: string[] = [];
    for (i++; lines[i] !== m[2]; i++) value.push(lines[i]);
    out[m[1]] = value.join("\n");
  }
  return out;
}

describe("GitHub Action (hosted)", { skip: process.platform === "win32" && "POSIX wrapper script" }, () => {
  const { state, server } = fakeBackend();
  let dir: string;
  let env: Record<string, string>;
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    dir = mkdtempSync(join(tmpdir(), "dotmock-action-test-"));
    const bin = join(dir, "dotmock");
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" --import "${import.meta.resolve("tsx")}" "${join(projectRoot, "src/index.ts")}" "$@"\n`);
    chmodSync(bin, 0o755);
    writeFileSync(join(dir, "dotmock.yaml"), renderLlmDefinitionYaml(starterLlmDefinition()));
    for (const name of ["env", "output", "state", "path", "summary"]) writeFileSync(join(dir, name), "");
    env = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? dir,
      DOTMOCK_ACTION_CLI_BIN: bin,
      GITHUB_WORKSPACE: dir,
      GITHUB_ENV: join(dir, "env"),
      GITHUB_OUTPUT: join(dir, "output"),
      GITHUB_STATE: join(dir, "state"),
      GITHUB_PATH: join(dir, "path"),
      GITHUB_STEP_SUMMARY: join(dir, "summary"),
      "INPUT_API-KEY": "mck_test",
      INPUT_CONFIG: "dotmock.yaml",
      INPUT_SESSION: "123-1",
      "INPUT_API-URL": `http://127.0.0.1:${address.port}`,
      "INPUT_JOURNAL-SUMMARY": "true",
    };
  });
  after(async () => {
    rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("applies the config, resets the session, and exports hosted URLs", async () => {
    const { stdout } = await execFileAsync(process.execPath, [join(projectRoot, "action/main.mjs")], { env });
    assert.doesNotMatch(stdout, /::error::/);
    assert.match(stdout, /::add-mask::mck_test/);
    const exported = parseGithubFile(env.GITHUB_ENV);
    assert.equal(exported.OPENAI_BASE_URL, "https://assistant-t1a2b3c4.mock.rest/v1");
    assert.equal(exported.ANTHROPIC_BASE_URL, "https://assistant-t1a2b3c4.mock.rest");
    assert.equal(exported.DOTMOCK_URL, "https://assistant-t1a2b3c4.mock.rest");
    assert.equal(exported.DOTMOCK_SESSION, "123-1");
    assert.equal(exported.DOTMOCK_API, API_ID);
    assert.equal(exported.OPENAI_API_KEY, "dotmock");
    const outputs = parseGithubFile(env.GITHUB_OUTPUT);
    assert.equal(outputs["api-id"], API_ID);
    assert.equal(outputs["openai-base-url"], "https://assistant-t1a2b3c4.mock.rest/v1");
    assert.equal(state.fixtures.length, 6);
    assert.deepEqual(state.calls.find((c) => c.action === "dotmock_reset_llm_sequences")?.params, { apiId: API_ID, session: "123-1" });
  });

  it("post step summarizes the session journal", async () => {
    state.journal.push(
      { id: "1", timestamp: 1, session: "123-1", response: { fixtureName: "greeting" } },
      { id: "2", timestamp: 2, session: "123-1", response: {} },
      { id: "3", timestamp: 3, session: "other", response: { fixtureName: "greeting" } },
    );
    const saved = parseGithubFile(env.GITHUB_STATE);
    const stateEnv = Object.fromEntries(Object.entries(saved).map(([key, value]) => [`STATE_${key}`, value]));
    const { stdout } = await execFileAsync(process.execPath, [join(projectRoot, "action/post.mjs")], { env: { ...env, ...stateEnv } });
    assert.match(stdout, /session 123-1: 2 request\(s\), 1 unmatched/);
    assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), /\| greeting \| 1 \|/);
  });
});
