#!/usr/bin/env node
// Minimal stand-in for dotmock-server local mode (contract C6) used by CLI tests.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

if (process.env.DOTMOCK_LOCAL_MODE !== "true") { console.error("expected DOTMOCK_LOCAL_MODE=true"); process.exit(2); }
readFileSync(process.env.DOTMOCK_LOCAL_CONFIG, "utf8");

let journal = [];
let resets = [];
let counter = 0;

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/__dotmock/health") return send(200, { status: "ok", mode: "local" });
  if (url.pathname === "/__dotmock/journal") {
    const api = url.searchParams.get("api");
    return send(200, journal.filter((e) => !api || e.api === api).slice().reverse());
  }
  if (url.pathname === "/__dotmock/reset" && req.method === "POST") {
    resets.push(Object.fromEntries(url.searchParams));
    journal = [];
    return send(200, { reset: true });
  }
  if (url.pathname === "/__test/resets") return send(200, resets);
  const match = url.pathname.match(/^\/([a-z0-9-]+)\/v1\/chat\/completions$/);
  if (match && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    const last = body.messages?.at(-1)?.content ?? "";
    const fixtureName = /hello/i.test(last) ? "greeting" : "fallback";
    journal.push({
      id: String(++counter), timestamp: Date.now() + counter, api: match[1], method: "POST",
      path: url.pathname, provider: "openai", session: req.headers["x-dotmock-session"] || "default",
      response: { status: 200, fixtureName, fixtureId: fixtureName },
    });
    return send(200, { choices: [{ message: { role: "assistant", content: fixtureName } }] });
  }
  send(404, { error: "not found" });
}).listen(Number(process.env.PORT), "127.0.0.1");
