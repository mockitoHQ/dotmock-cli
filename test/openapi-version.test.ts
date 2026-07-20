import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const target = path.join(directory, entry.name);
        return entry.isDirectory()
          ? files(target)
          : Promise.resolve(entry.name.endsWith(".ts") ? [target] : []);
      }),
    )
  ).flat();
}

test("CLI production generators do not emit legacy OpenAPI versions", async () => {
  const offenders = [];
  for (const file of await files(sourceRoot)) {
    const source = await readFile(file, "utf8");
    if (/openapi\s*:\s*["']3\.[01](?:\.[0-9]+)?["']/.test(source)) {
      offenders.push(path.relative(sourceRoot, file));
    }
  }
  assert.deepEqual(offenders, []);
});
