import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ProjectConfig } from "./project-config.js";

const execFileAsync = promisify(execFile);

/** Contract C6: image and local-mode environment. */
export const DEFAULT_SERVER_IMAGE = "ghcr.io/dotmock/dotmock-server:latest";
export const SERVER_BINARY = "dotmock-server";
export const CONTAINER_CONFIG_DIR = "/dotmock";
export const HEALTH_PATH = "/__dotmock/health";

export type RuntimePreference = "auto" | "binary" | "docker";
export type ResolvedRuntime = { kind: "binary"; command: string } | { kind: "docker"; command: string };

export interface ServeState {
  port: number;
  baseUrl: string;
  runtime: "binary" | "docker";
  configPath: string;
  pid?: number;
  containerName?: string;
  containerId?: string;
  logFile?: string;
  startedAt: string;
}

export interface ApiUrl {
  name: string;
  subdomain: string;
  type: string;
  /** Base URL with the `/{subdomain}` prefix (works for any number of APIs). */
  baseUrl: string;
  /** OpenAI-compatible base (`.../v1`) for LLM APIs. */
  openaiBaseUrl?: string;
}

export function findOnPath(command: string, pathEnv = process.env.PATH ?? ""): string | null {
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

export function resolveRuntime(preference: RuntimePreference = "auto", pathEnv?: string): ResolvedRuntime {
  const binary = process.env.DOTMOCK_SERVER_BIN || findOnPath(SERVER_BINARY, pathEnv);
  if (preference !== "docker" && binary) return { kind: "binary", command: binary };
  if (preference === "binary") {
    throw new Error(`${SERVER_BINARY} was not found on PATH (set DOTMOCK_SERVER_BIN or use --runtime docker).`);
  }
  const docker = findOnPath("docker", pathEnv);
  if (docker) return { kind: "docker", command: docker };
  throw new Error(
    `Neither ${SERVER_BINARY} nor docker is available. Install Docker or put a ${SERVER_BINARY} binary on PATH.`,
  );
}

export function localModeEnv(configPath: string, port: number): Record<string, string> {
  return {
    DOTMOCK_LOCAL_MODE: "true",
    DOTMOCK_LOCAL_CONFIG: configPath,
    PORT: String(port),
  };
}

export function containerName(port: number): string {
  return `dotmock-serve-${port}`;
}

/**
 * `docker run` arguments. The config's directory is mounted read-only (not the
 * file itself) so editor save-by-rename still hot-reloads and relative spec
 * paths resolve inside the container.
 */
export function buildDockerArgs(options: {
  configPath: string;
  port: number;
  image?: string;
  name?: string;
  detach?: boolean;
}): string[] {
  const configPath = resolve(options.configPath);
  const env = localModeEnv(`${CONTAINER_CONFIG_DIR}/${basename(configPath)}`, 8080);
  return [
    "run",
    options.detach ? "-d" : "--rm",
    "--name",
    options.name ?? containerName(options.port),
    "-p",
    `127.0.0.1:${options.port}:8080`,
    "--add-host",
    "host.docker.internal:host-gateway",
    "-v",
    `${dirname(configPath)}:${CONTAINER_CONFIG_DIR}:ro`,
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    options.image ?? process.env.DOTMOCK_SERVER_IMAGE ?? DEFAULT_SERVER_IMAGE,
  ];
}

export function apiUrls(config: ProjectConfig, baseUrl: string): ApiUrl[] {
  const root = baseUrl.replace(/\/+$/, "");
  return config.apis.map((api) => {
    const prefixed = `${root}/${api.subdomain}`;
    return {
      name: api.name,
      subdomain: api.subdomain,
      type: api.type,
      baseUrl: prefixed,
      ...(api.type === "llm" ? { openaiBaseUrl: `${prefixed}/v1` } : {}),
    };
  });
}

/** Environment variables exported for SDKs (first LLM API wins). */
export function sdkEnv(config: ProjectConfig, baseUrl: string): Record<string, string> {
  const urls = apiUrls(config, baseUrl);
  const llm = urls.find((url) => url.type === "llm");
  const env: Record<string, string> = { DOTMOCK_URL: baseUrl.replace(/\/+$/, "") };
  if (llm) {
    env.OPENAI_BASE_URL = llm.openaiBaseUrl!;
    env.ANTHROPIC_BASE_URL = llm.baseUrl;
    env.DOTMOCK_LLM_URL = llm.baseUrl;
  }
  return env;
}

export async function isHealthy(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${HEALTH_PATH}`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForHealth(
  baseUrl: string,
  options: { timeoutMs?: number; intervalMs?: number; abort?: () => string | null | Promise<string | null> } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    const reason = await options.abort?.();
    if (reason) throw new Error(reason);
    if (await isHealthy(baseUrl)) return;
    await new Promise((r) => setTimeout(r, options.intervalMs ?? 250));
  }
  throw new Error(`dotmock-server did not become healthy at ${baseUrl}${HEALTH_PATH} within ${Math.round((options.timeoutMs ?? 30_000) / 1000)}s.`);
}

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

// ---------- state files for `serve --detach` / `serve stop` ----------

export function stateDir(): string {
  return process.env.DOTMOCK_STATE_DIR || join(homedir(), ".dotmock", "serve");
}

export function statePath(port: number): string {
  return join(stateDir(), `${port}.json`);
}

export function readState(port: number): ServeState | null {
  try {
    return JSON.parse(readFileSync(statePath(port), "utf8")) as ServeState;
  } catch {
    return null;
  }
}

export function writeState(state: ServeState): void {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  writeFileSync(statePath(state.port), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

export function clearState(port: number): void {
  rmSync(statePath(port), { force: true });
}

// ---------- process management ----------

export interface StartOptions {
  configPath: string;
  port: number;
  runtime?: RuntimePreference;
  image?: string;
  timeoutMs?: number;
  /** Survive this process exiting (CLI --detach). */
  persist?: boolean;
  /** Container name override (tests use a distinct prefix). */
  name?: string;
  /** Inherit stdio (foreground `dotmock serve`). */
  inheritStdio?: boolean;
}

export interface RunningServer {
  state: ServeState;
  child?: ChildProcess;
  stop(): Promise<void>;
}

export async function startServer(options: StartOptions): Promise<RunningServer> {
  const configPath = resolve(options.configPath);
  if (!existsSync(configPath)) throw new Error(`Config file not found: ${configPath}`);
  const baseUrl = `http://127.0.0.1:${options.port}`;
  if (await isHealthy(baseUrl)) {
    throw new Error(`Something is already serving ${baseUrl}${HEALTH_PATH}. Use --port or \`dotmock serve stop --port ${options.port}\`.`);
  }
  const runtime = resolveRuntime(options.runtime ?? "auto");
  const startedAt = new Date().toISOString();

  if (runtime.kind === "docker") {
    const name = options.name ?? containerName(options.port);
    // A previous detached run may have left a stopped/stuck container behind.
    await execFileAsync(runtime.command, ["rm", "-f", name]).catch(() => undefined);
    const detachContainer = !options.inheritStdio;
    const args = buildDockerArgs({ configPath, port: options.port, image: options.image, name, detach: detachContainer });
    let child: ChildProcess | undefined;
    let containerId: string | undefined;
    let exitReason: string | null = null;
    if (detachContainer) {
      try {
        const { stdout } = await execFileAsync(runtime.command, args);
        containerId = stdout.trim();
      } catch (cause) {
        const stderr = (cause as { stderr?: string }).stderr?.trim();
        throw new Error(`docker run failed: ${stderr || (cause as Error).message}`);
      }
    } else {
      child = spawn(runtime.command, args, { stdio: "inherit" });
      child.on("exit", (code) => { exitReason = `docker exited with code ${code}`; });
    }
    const stop = async () => {
      await execFileAsync(runtime.command, ["rm", "-f", name]).catch(() => undefined);
      child?.kill("SIGTERM");
    };
    try {
      await waitForHealth(baseUrl, {
        timeoutMs: options.timeoutMs,
        abort: async () => {
          if (exitReason || !detachContainer) return exitReason;
          const running = await execFileAsync(runtime.command, ["inspect", "-f", "{{.State.Running}}", name])
            .then((r) => r.stdout.trim())
            .catch(() => "false");
          return running === "true" ? null : "dotmock-server container exited before becoming healthy";
        },
      });
    } catch (cause) {
      const logs = await execFileAsync(runtime.command, ["logs", "--tail", "40", name]).then((r) => r.stdout + r.stderr).catch(() => "");
      await stop();
      throw new Error(`${(cause as Error).message}${logs ? `\n--- container logs ---\n${logs.trim()}` : ""}`);
    }
    return {
      state: { port: options.port, baseUrl, runtime: "docker", configPath, containerName: name, containerId, startedAt },
      child,
      stop,
    };
  }

  const env = { ...process.env, ...localModeEnv(configPath, options.port) };
  let logFile: string | undefined;
  let stdio: "inherit" | "ignore" | ["ignore", number, number] = options.inheritStdio ? "inherit" : "ignore";
  if (options.persist) {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    logFile = join(stateDir(), `${options.port}.log`);
    const fd = openSync(logFile, "a");
    stdio = ["ignore", fd, fd];
  }
  const child = spawn(runtime.command, [], { env, stdio, detached: !!options.persist, cwd: dirname(configPath) });
  let exitReason: string | null = null;
  child.on("error", (cause) => { exitReason = `failed to start ${runtime.command}: ${cause.message}`; });
  child.on("exit", (code, signal) => { exitReason = `${SERVER_BINARY} exited (${signal ?? code})${logFile ? `; see ${logFile}` : ""}`; });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  try {
    await waitForHealth(baseUrl, { timeoutMs: options.timeoutMs, abort: () => exitReason });
  } catch (cause) {
    await stop();
    throw cause;
  }
  if (options.persist) child.unref();
  return {
    state: { port: options.port, baseUrl, runtime: "binary", configPath, pid: child.pid, logFile, startedAt },
    child,
    stop,
  };
}

/** Stop a detached server recorded in the state file. Returns false when nothing was recorded. */
export async function stopDetached(port: number): Promise<boolean> {
  const state = readState(port);
  if (!state) {
    // Fall back to the conventional container name (e.g. state dir wiped between CI steps).
    const docker = findOnPath("docker");
    if (docker) {
      const removed = await execFileAsync(docker, ["rm", "-f", containerName(port)]).then(() => true).catch(() => false);
      return removed;
    }
    return false;
  }
  if (state.runtime === "docker") {
    const docker = findOnPath("docker") ?? "docker";
    await execFileAsync(docker, ["rm", "-f", state.containerName ?? containerName(port)]).catch(() => undefined);
  } else if (state.pid) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  clearState(port);
  return true;
}
