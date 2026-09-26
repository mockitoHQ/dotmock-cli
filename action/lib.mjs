import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

export function input(name, fallback = "") {
  const value = process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

export function requiredInput(name) {
  const value = input(name);
  if (!value) throw new Error(`Input "${name}" is required.`);
  return value;
}

function appendFile(variable, key, value) {
  const file = process.env[variable];
  if (!file) return;
  const delimiter = `__DOTMOCK_${Math.random().toString(36).slice(2)}__`;
  appendFileSync(file, `${key}<<${delimiter}\n${value}\n${delimiter}\n`);
}

export const setOutput = (key, value) => appendFile("GITHUB_OUTPUT", key, value);
export const saveState = (key, value) => appendFile("GITHUB_STATE", key, value);
export const getState = (key) => process.env[`STATE_${key}`] ?? "";
export function exportVariable(key, value) {
  process.env[key] = value;
  appendFile("GITHUB_ENV", key, value);
}
export function addPath(dir) {
  process.env.PATH = `${dir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;
  if (process.env.GITHUB_PATH) appendFileSync(process.env.GITHUB_PATH, `${dir}\n`);
}
export const mask = (value) => { if (value) console.log(`::add-mask::${value}`); };
export function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

/** Path of the `dotmock` binary installed under `prefix` by `npm install --prefix`. */
export const cliBin = (prefix) => join(prefix, "node_modules", ".bin", process.platform === "win32" ? "dotmock.cmd" : "dotmock");

export function run(command, args, options = {}) {
  console.log(`[dotmock] $ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    shell: process.platform === "win32",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    throw new Error(`${command} ${args[0] ?? ""} exited with ${result.status}`);
  }
  return result.stdout ?? "";
}

/** Run the CLI with --json and parse its output. */
export function dotmockJson(bin, args, env, options = {}) {
  const stdout = run(bin, ["--json", ...args], { env, ...options });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Could not parse \`dotmock ${args.join(" ")}\` output: ${stdout.slice(0, 300)}`);
  }
}

export function fail(error) {
  console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
