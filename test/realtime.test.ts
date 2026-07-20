import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { parseSSE } from "../src/commands/realtime.js";
import { parseMockKind, specificationTypeForKind } from "../src/mock-kind.js";

describe("realtime CLI contract", () => {
  it("maps realtime workspaces to AsyncAPI", () => {
    assert.equal(parseMockKind("realtime"), "realtime");
    assert.equal(specificationTypeForKind("realtime"), "asyncapi");
  });

  it("parses full SSE fields and multiline data", () => {
    assert.deepEqual(
      parseSSE(": heartbeat\nevent: delta\nid: 2\nretry: 500\ndata: first\ndata: second\n\n"),
      [{ event: "delta", id: "2", retry: 500, data: "first\nsecond", comments: ["heartbeat"] }],
    );
  });

  it("registers realtime import/export/test/traffic commands", () => {
    const root = execFileSync(process.execPath, ["--import", "tsx", "src/index.ts", "--help"], { encoding: "utf8" });
    assert.match(root, /\brealtime\b/);
    const help = execFileSync(process.execPath, ["--import", "tsx", "src/index.ts", "realtime", "--help"], { encoding: "utf8" });
    for (const command of ["import", "export", "targets", "scenarios", "token", "sse", "ws", "traffic", "usage", "promote"]) {
      assert.match(help, new RegExp(`\\b${command}\\b`));
    }
  });
});
