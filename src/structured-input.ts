import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export function readStructuredFile(file: string): unknown {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  return parseStructured(readFileSync(path, "utf8"), path);
}

export function readStructuredValue(value: string, label: string): unknown {
  if (value.startsWith("@")) return readStructuredFile(value.slice(1));
  return parseStructured(value, label);
}

export function readBodyFile(file: string): unknown {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  const source = readFileSync(path, "utf8");
  try {
    return parseStructured(source, path);
  } catch {
    return source;
  }
}

export function asRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function collect(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

export function parseHeaders(values: string[]): Record<string, string> {
  return Object.fromEntries(
    values.map((entry) => {
      const separator = entry.indexOf(":");
      if (separator < 1) {
        throw new Error(`Invalid header "${entry}". Use name:value.`);
      }
      return [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()];
    }),
  );
}

function parseStructured(source: string, label: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    try {
      const value = parseYaml(source);
      if (value !== undefined) return value;
    } catch {
      // Report one consistent error below.
    }
  }
  throw new Error(`${label} must contain valid JSON or YAML.`);
}
