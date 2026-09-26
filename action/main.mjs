import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  addPath,
  cliBin,
  dotmockJson,
  exportVariable,
  fail,
  input,
  mask,
  requiredInput,
  run,
  saveState,
  setOutput,
} from "./lib.mjs";

const DUMMY_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"];

try {
  const apiKey = requiredInput("api-key");
  mask(apiKey);
  const workdir = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd(), input("working-directory", "."));
  const config = input("config");
  let api = input("api");
  if (!api && !config) throw new Error('Set "api" (id or subdomain) or "config" (a dotmock.yaml definition to apply).');
  const runId = process.env.GITHUB_RUN_ID;
  const session = input("session", runId ? `${runId}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}` : `local-${Date.now()}`);

  // Install the CLI into a private prefix so a different `dotmock` on PATH is never picked up.
  // DOTMOCK_ACTION_CLI_BIN (tests only) points at an existing CLI instead.
  let bin = process.env.DOTMOCK_ACTION_CLI_BIN;
  if (!bin) {
    const prefix = join(process.env.RUNNER_TEMP ?? workdir, "dotmock-cli");
    mkdirSync(prefix, { recursive: true });
    run("npm", ["install", "--no-save", "--no-audit", "--no-fund", "--prefix", prefix, `@dotmock/cli@${input("cli-version", "^0.3.0")}`], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    bin = cliBin(prefix);
    addPath(join(prefix, "node_modules", ".bin"));
  }

  const env = { ...process.env, DOTMOCK_API_KEY: apiKey };
  const apiUrl = input("api-url");
  if (apiUrl) {
    env.DOTMOCK_API_URL = apiUrl;
    exportVariable("DOTMOCK_API_URL", apiUrl);
  }

  if (config) {
    const applied = dotmockJson(bin, ["config", "apply", "-f", resolve(workdir, config), ...(api ? ["--api", api] : [])], env, { cwd: workdir });
    if (!api) api = applied.apiId;
    console.log(`[dotmock] applied ${config}: ${applied.created?.length ?? 0} created, ${applied.updated?.length ?? 0} updated`);
    if (!api) throw new Error(`\`dotmock config apply\` did not report an API id for ${config}; set the "api" input.`);
  }

  const connect = dotmockJson(bin, ["llm", "connect", api, "--session", session], env);
  const apiId = connect.apiId ?? api;
  dotmockJson(bin, ["llm", "reset", apiId, "--session", session], env);

  for (const [key, value] of Object.entries(connect.env ?? {})) {
    if (DUMMY_KEYS.includes(key)) continue;
    exportVariable(key, value);
  }
  exportVariable("DOTMOCK_SESSION", session);
  exportVariable("DOTMOCK_API", apiId);
  exportVariable("DOTMOCK_API_KEY", apiKey); // masked; used by `dotmock` and @dotmock/cli/testing in later steps
  if (input("export-dummy-keys", "true") === "true") {
    for (const key of DUMMY_KEYS) if (!process.env[key]) exportVariable(key, "dotmock");
  }

  saveState("bin", bin);
  saveState("api_id", apiId);
  saveState("session", session);
  setOutput("url", connect.baseUrl);
  setOutput("openai-base-url", connect.openaiBaseUrl ?? `${connect.baseUrl}/v1`);
  setOutput("anthropic-base-url", connect.env?.ANTHROPIC_BASE_URL ?? connect.baseUrl);
  setOutput("api-id", apiId);
  setOutput("session", session);
  console.log(`[dotmock] ${connect.baseUrl} (api ${apiId}, session ${session})`);
  console.log("[dotmock] send `X-Dotmock-Session: $DOTMOCK_SESSION` with each request to keep this run isolated.");
} catch (error) {
  fail(error);
}
