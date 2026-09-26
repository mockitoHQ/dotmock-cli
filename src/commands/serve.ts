import chalk from "chalk";
import { Command } from "commander";
import { assertValidProject, loadProjectConfig } from "../lib/project-config.js";
import {
  apiUrls,
  isHealthy,
  readState,
  sdkEnv,
  startServer,
  stopDetached,
  writeState,
  type RuntimePreference,
} from "../lib/serve.js";
import { error, info, isJsonMode, json, success, table } from "../output.js";

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1-65535.");
  return port;
}

function parseSeconds(value: string): number {
  const seconds = Number.parseFloat(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--timeout must be a positive number of seconds.");
  return seconds;
}

async function stop(port: number): Promise<void> {
  const stopped = await stopDetached(port);
  if (isJsonMode()) json({ stopped, port });
  else if (stopped) success(`Stopped dotmock-server on port ${port}.`);
  else info(`No detached dotmock-server recorded for port ${port}.`);
}

async function status(port: number): Promise<void> {
  const state = readState(port);
  const baseUrl = state?.baseUrl ?? `http://127.0.0.1:${port}`;
  const healthy = await isHealthy(baseUrl);
  if (isJsonMode()) json({ port, healthy, baseUrl, state });
  else if (healthy) success(`dotmock-server is healthy at ${baseUrl}${state ? ` (${state.runtime}, ${state.configPath})` : ""}.`);
  else info(`Nothing healthy at ${baseUrl}.`);
  if (!healthy) process.exitCode = 1;
}

export const serveCommand = new Command("serve")
  .description("Run DotMock locally from dotmock.yaml (no account needed). Actions: stop, status")
  .argument("[action]", "Omit to start; `stop` or `status` for a detached server")
  .option("-c, --config <file>", "Project file", "dotmock.yaml")
  .option("-p, --port <port>", "Port to listen on", parsePort, 8080)
  .option("-d, --detach", "Run in the background and return once healthy")
  .option("--runtime <runtime>", "auto (dotmock-server on PATH, else docker), binary, or docker", "auto")
  .option("--image <image>", "Docker image (default $DOTMOCK_SERVER_IMAGE or ghcr.io/dotmock/dotmock-server:latest)")
  .option("--timeout <seconds>", "Health-check timeout", parseSeconds, 60)
  .action(async (action: string | undefined, opts) => {
    try {
      if (action === "stop") return await stop(opts.port);
      if (action === "status") return await status(opts.port);
      if (action) throw new Error(`Unknown serve action ${action}. Use stop or status.`);

      const loaded = loadProjectConfig(opts.config);
      assertValidProject(loaded);
      for (const issue of loaded.issues.filter((i) => i.severity === "warning")) {
        if (!isJsonMode()) info(`${chalk.yellow("warning")} ${issue.path}: ${issue.message}`);
      }
      const runtime = String(opts.runtime) as RuntimePreference;
      if (!["auto", "binary", "docker"].includes(runtime)) throw new Error("--runtime must be auto, binary, or docker.");

      if (!isJsonMode()) info(`Starting dotmock-server for ${loaded.file}...`);
      const server = await startServer({
        configPath: loaded.file,
        port: opts.port,
        runtime,
        image: opts.image,
        timeoutMs: opts.timeout * 1000,
        persist: !!opts.detach,
        inheritStdio: !opts.detach && !isJsonMode(),
      });
      const urls = apiUrls(loaded.config, server.state.baseUrl);
      const env = sdkEnv(loaded.config, server.state.baseUrl);
      if (opts.detach) writeState(server.state);

      if (isJsonMode()) {
        json({ ...server.state, detached: !!opts.detach, apis: urls, env });
      } else {
        success(`dotmock-server is up at ${server.state.baseUrl} (${server.state.runtime}).`);
        table(
          ["API", "Type", "Base URL", "OpenAI base URL"],
          urls.map((url) => [`${url.name} (${url.subdomain})`, url.type, url.baseUrl, url.openaiBaseUrl ?? ""]),
        );
        console.log(Object.entries(env).map(([key, value]) => `export ${key}=${value}`).join("\n"));
        info("Journal: GET /__dotmock/journal?api=<subdomain>   Reset: POST /__dotmock/reset   Edits to the config hot-reload.");
        info(opts.detach ? `Stop with: dotmock serve stop --port ${opts.port}` : "Press Ctrl+C to stop.");
      }

      if (opts.detach) {
        // Let the CLI exit while the server keeps running.
        server.child?.unref();
        return;
      }

      await new Promise<void>((resolveExit) => {
        const shutdown = () => { void server.stop().then(resolveExit); };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
        server.child?.once("exit", (code) => {
          if (code && code !== 0 && code !== 130 && code !== 143) process.exitCode = code;
          resolveExit();
        });
      });
    } catch (cause) {
      error(cause instanceof Error ? cause.message : String(cause));
      process.exitCode = 1;
    }
  });
