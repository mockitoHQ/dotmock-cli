import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { generatedOpenApiSpec } from "../src/commands/create.js";
import { buildTarget } from "../src/commands/test.js";

describe("CLI lifecycle contract", () => {
  it("accepts direct and analysis-wrapped generated OpenAPI specifications", () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "Generated", version: "1.0.0" },
      paths: {},
    };
    assert.equal(generatedOpenApiSpec(spec, "generation"), spec);
    assert.equal(
      generatedOpenApiSpec({ openApiSpec: spec }, "analysis"),
      spec,
    );
  });

  it("builds safe REST and webhook dry-run targets", () => {
    assert.deepEqual(
      buildTarget("rest", { method: "post", path: "/checkout" }),
      { kind: "rest", method: "POST", path: "/checkout" },
    );
    assert.deepEqual(buildTarget("webhook", { event: "invoice.created" }), {
      kind: "webhook",
      eventKey: "invoice.created",
    });
  });

  it("registers agent JSON mode and the expanded lifecycle commands", () => {
    const help = execFileSync(
      process.execPath,
      ["--import", "tsx", "src/index.ts", "--help"],
      { encoding: "utf8" },
    );
    for (const command of [
      "create",
      "configure",
      "config",
      "test",
      "reorder",
      "analyze",
    ]) {
      assert.match(help, new RegExp(`\\b${command}\\b`));
    }
    assert.match(help, /--json/);
  });
});
