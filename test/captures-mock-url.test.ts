import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { extractLogs, findCapture } from "../src/lib/captures.js";
import { resolveMockBaseUrl } from "../src/lib/mock-url.js";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

describe("mock url resolution (ported from Go CLI)", () => {
  it("prefers _dx.baseUrl, then direct URL fields, then subdomain", () => {
    assert.equal(resolveMockBaseUrl({ _dx: { baseUrl: "https://x.dotmock.com/" }, url: "https://y" }), "https://x.dotmock.com");
    assert.equal(resolveMockBaseUrl({ fullUrl: "https://full.example" }), "https://full.example");
    assert.equal(resolveMockBaseUrl({ mockUrl: "https://m.example//" }), "https://m.example");
    assert.equal(resolveMockBaseUrl({ subdomain: "payments" }), "https://payments.mock.rest");
    assert.throws(() => resolveMockBaseUrl({}), /did not include a mock URL/);
    // Canonical backend fields: localUrl on a local stack, and no doubled team suffix.
    assert.equal(resolveMockBaseUrl({ fullUrl: "https://a.mock.rest", localUrl: "http://a.localhost:6200" }, true), "http://a.localhost:6200");
    assert.equal(resolveMockBaseUrl({ fullUrl: "https://a.mock.rest", localUrl: "http://a.localhost:6200" }, false), "https://a.mock.rest");
    assert.equal(resolveMockBaseUrl({ fullUrl: "http://assistant-x1y2-t1a2b3c4-t1a2b3c4.localhost:7778" }), "http://assistant-x1y2-t1a2b3c4.localhost:7778");
    assert.equal(resolveMockBaseUrl({ fullUrl: "https://api-v2-v2.mock.rest" }), "https://api-v2-v2.mock.rest");
  });
});

describe("capture matching (ported from Go CLI)", () => {
  const logs = extractLogs({
    logs: [
      { method: "get", path: "/v1/orders" },
      { request: { method: "POST", url: "/v1/orders" }, body: { sku: "sku_123" } },
    ],
  });

  it("accepts wrapped and bare log arrays", () => {
    assert.equal(logs.length, 2);
    assert.equal(extractLogs([{ path: "/a" }]).length, 1);
    assert.throws(() => extractLogs({ nope: true }), /logs array/);
  });

  it("matches method case-insensitively, path exactly, body by substring", () => {
    assert.equal(findCapture(logs, { method: "GET", path: "/v1/orders" }), logs[0]);
    assert.equal(findCapture(logs, { method: "post", bodyContains: "sku_123" }), logs[1]);
    assert.equal(findCapture(logs, { path: "/v1/orders/" }), undefined);
    assert.equal(findCapture(logs, { bodyContains: "missing" }), undefined);
  });
});

describe("mock url + captures CLI", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const { action } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const result =
        action === "dotmock_list_apis"
          ? [{ id: "6f1c0d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f", subdomain: "payments" }]
          : action === "dotmock_get_api"
          ? { id: "api-1", subdomain: "payments", _dx: { baseUrl: "https://payments.mock.rest" } }
          : { logs: [{ method: "POST", path: "/v1/orders", body: '{"sku":"sku_123"}' }] };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: true, data: result }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const run = (...args: string[]) =>
    execFileAsync(process.execPath, ["--import", "tsx", "src/index.ts", ...args], {
      cwd: projectRoot,
      env: { ...process.env, DOTMOCK_API_KEY: "mck_test", DOTMOCK_API_URL: baseUrl },
    });

  it("prints the mock URL as text and JSON", async () => {
    assert.equal((await run("mock", "url", "payments")).stdout.trim(), "https://payments.mock.rest");
    assert.deepEqual(JSON.parse((await run("--json", "mock", "url", "payments")).stdout), {
      apiId: "payments",
      baseUrl: "https://payments.mock.rest",
    });
  });

  it("captures assert exits 0 with the matched capture", async () => {
    const { stdout } = await run("--json", "captures", "assert", "--api", "payments", "--method", "post", "--path", "/v1/orders", "--body-contains", "sku_123");
    const result = JSON.parse(stdout);
    assert.equal(result.matched, true);
    assert.equal(result.method, "POST");
    assert.equal(result.capture.path, "/v1/orders");
  });

  it("captures assert exits 1 when nothing matched", async () => {
    await assert.rejects(
      run("--json", "captures", "assert", "--api", "payments", "--path", "/v1/refunds"),
      (cause: { code?: number; stdout?: string }) => {
        assert.equal(cause.code, 1);
        assert.equal(JSON.parse(cause.stdout ?? "{}").matched, false);
        return true;
      },
    );
  });

  it("captures assert requires a filter", async () => {
    await assert.rejects(run("captures", "assert", "--api", "payments"), /requires at least --method/);
  });
});
