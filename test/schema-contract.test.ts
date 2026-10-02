import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { renderLlmDefinitionYaml, starterLlmDefinition } from "../src/lib/llm-definition.js";
import { validateSchema } from "./helpers/json-schema.js";

/**
 * The published schema (/api/schemas/dotmock-v2.schema.json) must accept what
 * `dotmock init --llm` writes, before and after the first apply records the id.
 * Point DOTMOCK_SCHEMA_PATH at the schema when the backend checkout is not a sibling.
 */
const schemaPath =
  process.env.DOTMOCK_SCHEMA_PATH ??
  fileURLToPath(new URL("../../dotmock-backend/src/definitions/dotmock-v2.schema.json", import.meta.url));
const hasSchema = existsSync(schemaPath);

describe("dotmock-v2 schema contract", { skip: hasSchema ? false : `schema not found at ${schemaPath}` }, () => {
  const schema = hasSchema ? JSON.parse(readFileSync(schemaPath, "utf8")) : {};
  const initOutput = () => parseYaml(renderLlmDefinitionYaml(starterLlmDefinition("Assistant", "assistant")));

  it("accepts the `dotmock init --llm` template (no id, with subdomain)", () => {
    const definition = initOutput();
    assert.equal(definition.id, undefined);
    assert.deepEqual(validateSchema(schema, definition), []);
  });

  it("accepts the definition after apply writes back id and stored subdomain", () => {
    const definition = { ...initOutput(), id: "0b6c1c9e-5d4f-4f0e-9c1a-2b3c4d5e6f70", subdomain: "assistant-x1y2-t1a2b3c4" };
    assert.deepEqual(validateSchema(schema, definition), []);
  });

  it("still rejects typos and incomplete non-LLM definitions", () => {
    assert.notDeepEqual(validateSchema(schema, { ...initOutput(), fixturez: [] }), []);
    assert.notDeepEqual(validateSchema(schema, { ...initOutput(), subdomain: "Not Valid" }), []);
    assert.notDeepEqual(validateSchema(schema, { ...initOutput(), fixtures: [{ response: { content: "x" } }] }), [], "fixtures need a name");
    assert.notDeepEqual(validateSchema(schema, { schemaVersion: "dotmock/v2", kind: "rest", name: "x", protocol: {}, rules: [] }), [], "rest requires id");
  });
});
