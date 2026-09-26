import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { exportVariable, fail, input, onPath, run, saveState, setOutput } from "./lib.mjs";

try {
  const workdir = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd(), input("working-directory", "."));
  const config = resolve(workdir, input("config", "dotmock.yaml"));
  const port = input("port", "8080");
  const image = input("image", "ghcr.io/dotmock/dotmock-server:latest");
  const runtime = input("runtime", "auto");
  const stateDir = join(process.env.RUNNER_TEMP ?? workdir, "dotmock-serve");
  mkdirSync(stateDir, { recursive: true });

  if (!onPath("dotmock")) {
    run("npm", ["install", "--global", `@dotmock/cli@${input("cli-version", "latest")}`], { stdio: ["ignore", "inherit", "inherit"] });
  }
  const useDocker = runtime === "docker" || (runtime === "auto" && !onPath("dotmock-server"));
  if (useDocker) run("docker", ["pull", "--quiet", image], { stdio: ["ignore", "inherit", "inherit"] });

  const env = { ...process.env, DOTMOCK_STATE_DIR: stateDir, DOTMOCK_OUTPUT: "json" };
  saveState("port", port);
  saveState("state_dir", stateDir);
  const stdout = run(
    "dotmock",
    ["--json", "serve", "--detach", "--config", config, "--port", port, "--runtime", runtime, "--image", image, "--timeout", input("timeout", "60")],
    { cwd: workdir, env },
  );
  const started = JSON.parse(stdout);

  exportVariable("DOTMOCK_CONFIG", config);
  exportVariable("DOTMOCK_STATE_DIR", stateDir);
  for (const [key, value] of Object.entries(started.env ?? {})) exportVariable(key, value);
  if (input("export-dummy-keys", "true") === "true") {
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"]) {
      if (!process.env[key]) exportVariable(key, "dotmock");
    }
  }

  setOutput("url", started.baseUrl);
  setOutput("openai-base-url", started.env?.OPENAI_BASE_URL ?? "");
  setOutput("anthropic-base-url", started.env?.ANTHROPIC_BASE_URL ?? "");
  setOutput("apis", JSON.stringify(started.apis ?? []));
  console.log(`[dotmock] ready at ${started.baseUrl} (${started.runtime})`);
  for (const api of started.apis ?? []) console.log(`[dotmock]   ${api.subdomain} (${api.type}): ${api.openaiBaseUrl ?? api.baseUrl}`);
} catch (error) {
  fail(error);
}
