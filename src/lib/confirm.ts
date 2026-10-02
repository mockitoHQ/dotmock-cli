import { createInterface } from "node:readline";
import { isJsonMode } from "../output.js";

/** True when a y/N prompt can be answered: a TTY on stdin, not CI, not --json. */
export function canPrompt(env: NodeJS.ProcessEnv = process.env, stdinIsTty = !!process.stdin.isTTY): boolean {
  if (isJsonMode()) return false;
  const ci = env.CI;
  if (ci && ci !== "0" && ci.toLowerCase() !== "false") return false;
  return stdinIsTty;
}

/**
 * Confirm a destructive operation. `--yes`/`--force` skips the prompt; in
 * non-interactive contexts (no TTY, CI, --json) the command fails with a clear
 * message instead of hanging on stdin. The user's explicit command (plus this
 * confirmation) is the consent forwarded to the backend as `approved: true`.
 */
export async function confirmDestructive(message: string, yes: boolean | undefined, flag = "--yes"): Promise<boolean> {
  if (yes) return true;
  if (!canPrompt()) {
    throw new Error(`${message.replace(/\?$/, "")} requires confirmation: re-run with ${flag} in non-interactive shells (CI, --json, piped stdin).`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => rl.question(`${message} (y/N) `, resolve));
  rl.close();
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}
