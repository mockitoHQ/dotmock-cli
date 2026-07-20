import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

interface ActionCall {
  action: string;
  params: Record<string, unknown>;
}

describe("LLM fixture CLI lifecycle", () => {
  let server: Server;
  let baseUrl: string;
  const calls: ActionCall[] = [];

  before(async () => {
    server = createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/internal/mcp/execute-action") {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ message: "unexpected direct request" }));
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ActionCall;
      calls.push(envelope);

      const result = envelope.action === "dotmock_list_llm_fixtures"
        ? []
        : envelope.action === "dotmock_delete_llm_fixture"
          ? { deleted: true, fixtureId: "fixture-1" }
          : { id: "fixture-1", name: "Greeting", priority: 0 };

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: true, data: result, result }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("routes create, list, get, update, and delete through permission-checked actions", async () => {
    await runCli("create", "fixture", "--api", "api-1", "--name", "Greeting", "--match", "hello", "--response", "Hi");
    await runCli("list", "fixtures", "--api", "api-1");
    await runCli("get", "fixture", "--api", "api-1", "--id", "fixture-1");
    await runCli("update", "fixture", "--api", "api-1", "--id", "fixture-1", "--response", "Hello again");
    await runCli("delete", "fixture", "--api", "api-1", "--id", "fixture-1");

    assert.deepEqual(
      calls.map((call) => call.action),
      [
        "dotmock_create_llm_fixture",
        "dotmock_list_llm_fixtures",
        "dotmock_get_llm_fixture",
        "dotmock_update_llm_fixture",
        "dotmock_delete_llm_fixture",
      ],
    );
    assert.deepEqual(calls[0].params, {
      apiId: "api-1",
      name: "Greeting",
      match: { userMessage: "hello" },
      response: { content: "Hi" },
    });
    assert.deepEqual(calls[3].params, {
      apiId: "api-1",
      fixtureId: "fixture-1",
      response: { content: "Hello again" },
    });
  });

  async function runCli(...args: string[]): Promise<void> {
    await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/index.ts", "--json", ...args],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          DOTMOCK_API_KEY: "mck_test",
          DOTMOCK_API_URL: baseUrl,
        },
      },
    );
  }
});
