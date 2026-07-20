import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

describe("webhook event creation", () => {
  let server: Server;
  let baseUrl: string;
  let fixtureDir: string;
  let capturedEvent: Record<string, unknown> | undefined;

  before(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "dotmock-webhook-cli-"));
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const envelope = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      ) as { params: { event: Record<string, unknown> } };
      capturedEvent = envelope.params.event;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ success: true, data: capturedEvent, result: capturedEvent }),
      );
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
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it("preserves full-definition headers and content type while merging CLI headers", async () => {
    const definitionPath = join(fixtureDir, "event.json");
    await writeFile(
      definitionPath,
      JSON.stringify({
        name: "Invoice created",
        contentType: "application/cloudevents+json",
        headers: { "X-From-File": "yes" },
        bodyTemplate: { type: "invoice.created" },
      }),
    );

    await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/index.ts",
        "--json",
        "webhook",
        "event",
        "create",
        "--api",
        "api-1",
        "--event",
        "invoice.created",
        "--from",
        definitionPath,
        "--header",
        "X-From-CLI:yes",
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          DOTMOCK_API_KEY: "mck_test",
          DOTMOCK_API_URL: baseUrl,
        },
      },
    );

    assert.equal(capturedEvent?.contentType, "application/cloudevents+json");
    assert.deepEqual(capturedEvent?.headers, {
      "X-From-File": "yes",
      "X-From-CLI": "yes",
    });
  });
});
