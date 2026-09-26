// Example: test LLM-calling code against a hosted DotMock LLM mock.
//
//   dotmock login && dotmock config apply   # once: creates the mock from dotmock.yaml
//   DOTMOCK_API=assistant npm test
//
// In CI, the DotMock GitHub Action exports DOTMOCK_API, DOTMOCK_API_KEY and a
// per-run DOTMOCK_SESSION, so connectDotmock() needs no arguments.
import OpenAI from "openai";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  connectDotmock,
  disconnectDotmock,
  expectFixtureMatched,
  getJournal,
  resetDotmock,
  type DotmockConnection,
} from "@dotmock/cli/testing";

let dotmock: DotmockConnection;
let client: OpenAI;

beforeAll(async () => {
  dotmock = await connectDotmock({ api: process.env.DOTMOCK_API ?? "assistant" });
  // connectDotmock also exports OPENAI_BASE_URL; the session header keeps this run isolated.
  client = new OpenAI({ baseURL: dotmock.openaiBaseUrl, apiKey: "dotmock", defaultHeaders: dotmock.headers });
}, 30_000);

afterAll(() => disconnectDotmock());

// Fresh sequence counters before every test; journal assertions only see requests made after the reset.
beforeEach(() => resetDotmock());

describe("assistant", () => {
  it("greets the user", async () => {
    const res = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(res.choices[0].message.content).toContain("DotMock");
    await expectFixtureMatched("greeting", { times: 1 });
  });

  it("completes a tool-call round trip", async () => {
    const tools = [{
      type: "function" as const,
      function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
    }];
    const first = await client.chat.completions.create({
      model: "gpt-4o-mini",
      tools,
      messages: [{ role: "user", content: "What's the weather in Paris?" }],
    });
    const call = first.choices[0].message.tool_calls![0];
    expect(call.function.name).toBe("get_weather");

    const second = await client.chat.completions.create({
      model: "gpt-4o-mini",
      tools,
      messages: [
        { role: "user", content: "What's the weather in Paris?" },
        first.choices[0].message,
        { role: "tool", tool_call_id: call.id, content: '{"temperatureC":18,"condition":"sunny"}' },
      ],
    });
    expect(second.choices[0].message.content).toContain("Paris");
    await expectFixtureMatched("weather-tool-call", { times: 2 });
  });

  it("surfaces provider rate limits", async () => {
    await expect(
      client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "please trigger a rate limit" }],
        // Disable SDK retries so the 429 reaches the test immediately.
      }, { maxRetries: 0 }),
    ).rejects.toMatchObject({ status: 429 });
    await expectFixtureMatched("rate-limit", { times: 1 });
    const journal = await getJournal();
    expect(journal.at(-1)?.response?.fixtureName).toBe("rate-limit");
  });
});
