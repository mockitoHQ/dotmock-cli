import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { detectImportFormat, harToOpenApi, postmanToOpenApi, toImportSpec } from "../src/lib/import-formats.js";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

const POSTMAN = {
  info: { name: "Petstore", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  item: [
    {
      name: "Pets",
      item: [
        {
          name: "Get pet",
          request: { method: "GET", url: { raw: "{{baseUrl}}/pets/:petId?expand=owner", path: ["pets", ":petId"], query: [{ key: "expand", value: "owner" }] } },
          response: [{ code: 200, header: [{ key: "Content-Type", value: "application/json" }], body: '{"id":1,"name":"Rex"}' }],
        },
        { name: "Create pet", request: { method: "POST", url: "https://api.example.com/pets", body: { mode: "raw", raw: '{"name":"Rex"}' } } },
      ],
    },
  ],
};

const HAR = {
  log: {
    version: "1.2",
    entries: [
      {
        request: { method: "GET", url: "https://api.example.com/orders/42?status=open" },
        response: { status: 200, content: { mimeType: "application/json", text: '{"id":42}' } },
      },
      {
        request: { method: "GET", url: "https://api.example.com/static/app.js" },
        response: { status: 200, content: { mimeType: "application/javascript", text: "x" } },
      },
      {
        request: { method: "POST", url: "https://api.example.com/orders", postData: { mimeType: "application/json", text: '{"sku":"a"}' } },
        response: { status: 201, content: { mimeType: "application/json", text: Buffer.from('{"id":43}').toString("base64"), encoding: "base64" } },
      },
    ],
  },
};

describe("create api --from format detection", () => {
  it("detects OpenAPI, AsyncAPI, Postman, and HAR", () => {
    assert.equal(detectImportFormat({ openapi: "3.1.0" }), "openapi");
    assert.equal(detectImportFormat({ swagger: "2.0" }), "openapi");
    assert.equal(detectImportFormat({ asyncapi: "3.0.0" }), "asyncapi");
    assert.equal(detectImportFormat(POSTMAN), "postman");
    assert.equal(detectImportFormat(HAR), "har");
    assert.equal(detectImportFormat({ hello: 1 }, "x.json"), "unknown");
    assert.throws(() => toImportSpec({ hello: 1 }, "x.json"), /unrecognized format/);
  });

  it("converts Postman collections with path params, query params, and saved examples", () => {
    const spec = postmanToOpenApi(POSTMAN);
    assert.equal(spec.info.title, "Petstore");
    const get = spec.paths["/pets/{petId}"].get;
    assert.deepEqual(get.parameters.map((p: any) => `${p.in}:${p.name}`), ["path:petId", "query:expand"]);
    assert.deepEqual(get.responses["200"].content["application/json"].example, { id: 1, name: "Rex" });
    assert.deepEqual(spec.paths["/pets"].post.requestBody.content["application/json"].example, { name: "Rex" });
  });

  it("converts HAR entries, templating ids and skipping static assets", () => {
    const spec = harToOpenApi(HAR);
    assert.match(spec.info.title, /api\.example\.com/);
    assert.deepEqual(Object.keys(spec.paths).sort(), ["/orders", "/orders/{orderId}"]);
    assert.deepEqual(spec.paths["/orders/{orderId}"].get.responses["200"].content["application/json"].example, { id: 42 });
    assert.deepEqual(spec.paths["/orders"].post.responses["201"].content["application/json"].example, { id: 43 });
  });
});

describe("create api --from <postman|har> against the backend", () => {
  const calls: Array<{ action: string; params: any }> = [];
  let supportsImport = true;
  let baseUrl = "";
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const { action, params } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push({ action, params });
    const reply = (body: unknown) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
    if (action === "dotmock_import_api" && !supportsImport) return reply({ success: false, error: "UNCLASSIFIED_ACTION", message: "The requested action has no security policy and was denied." });
    if (action === "dotmock_import_api") return reply({ success: true, data: { id: "a1", name: "Petstore", import: { format: "postman", warnings: [], summary: { endpointCount: 2 } } } });
    return reply({ success: true, data: { id: "a2", name: params.name } });
  });
  let dir = "";
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    baseUrl = `http://127.0.0.1:${address.port}`;
    dir = mkdtempSync(join(tmpdir(), "dotmock-import-"));
    writeFileSync(join(dir, "pets.postman_collection.json"), JSON.stringify(POSTMAN));
  });
  after(async () => {
    rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const run = (...args: string[]) =>
    execFileAsync(process.execPath, ["--import", import.meta.resolve("tsx"), join(projectRoot, "src/index.ts"), ...args], {
      cwd: dir,
      env: { ...process.env, DOTMOCK_API_KEY: "mck_test", DOTMOCK_API_URL: baseUrl },
    });

  it("uses the backend importer when available", async () => {
    calls.length = 0;
    await run("create", "api", "--from", "pets.postman_collection.json");
    assert.deepEqual(calls.map((c) => c.action), ["dotmock_import_api"]);
    assert.equal(calls[0].params.content.info.name, "Petstore");
  });

  it("falls back to client-side conversion on older backends", async () => {
    supportsImport = false;
    calls.length = 0;
    await run("create", "api", "--from", "pets.postman_collection.json");
    assert.deepEqual(calls.map((c) => c.action), ["dotmock_import_api", "dotmock_create_api"]);
    assert.ok(calls[1].params.openApiSpec.paths["/pets/{petId}"]);
    assert.equal(calls[1].params.name, "Petstore");
  });
});
