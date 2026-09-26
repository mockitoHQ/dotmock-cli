import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export function input(name, fallback = "") {
  const value = process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
  return value === undefined || value === "" ? fallback : value.trim();
}

function appendFile(variable, key, value) {
  const file = process.env[variable];
  if (!file) return;
  const delimiter = `__DOTMOCK_${Math.random().toString(36).slice(2)}__`;
  appendFileSync(file, `${key}<<${delimiter}\n${value}\n${delimiter}\n`);
}

export const setOutput = (key, value) => appendFile("GITHUB_OUTPUT", key, value);
export const saveState = (key, value) => appendFile("GITHUB_STATE", key, value);
export function exportVariable(key, value) {
  process.env[key] = value;
  appendFile("GITHUB_ENV", key, value);
}
export const getState = (key) => process.env[`STATE_${key}`] ?? "";

export function onPath(command) {
  return spawnSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" }).status === 0;
}

export function run(command, args, options = {}) {
  console.log(`[dotmock] $ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    throw new Error(`${command} exited with ${result.status}`);
  }
  return result.stdout ?? "";
}

export function fail(error) {
  console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
