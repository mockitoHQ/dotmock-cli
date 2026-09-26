// Example: test LLM-calling code against a local DotMock server.
// Runs `dotmock-server` from PATH, or the ghcr.io/mockitohq/dotmock-server image via Docker.
// In CI with the dotmock GitHub Action, DOTMOCK_URL is already set and startDotmock() attaches to it.
import OpenAI from "openai";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  expectFixtureMatched,
  getJournal,
  resetDotmock,
  startDotmock,
  stopDotmock,
} from "@dotmock/cli/testing";

let client: OpenAI;

beforeAll(async () => {
  const dotmock = await startDotmock({ config: "dotmock.yaml" });
  // startDotmock also exports OPENAI_BASE_URL, so `new OpenAI()` would work too.
  client = new OpenAI({ baseURL: dotmock.openaiBaseUrl("assistant"), apiKey: "dotmock" });
}, 120_000);

afterAll(() => stopDotmock());

// Fresh sequence counters and an empty journal for every test.
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
    const journal = await getJournal();
    expect(journal.at(-1)?.response?.fixtureName).toBe("rate-limit");
  });
});
