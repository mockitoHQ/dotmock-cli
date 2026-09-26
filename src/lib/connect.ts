/** SDK wiring for `dotmock llm connect`: base URLs, env vars, and copy-paste snippets. */

export interface ConnectInfo {
  /** Hosted mock root, e.g. https://assistant-t1a2b3c4.mock.rest */
  baseUrl: string;
  openaiBaseUrl: string;
  env: Record<string, string>;
  snippets: Record<string, string>;
}

export const CONNECT_SNIPPET_KEYS = [
  "openai-node",
  "openai-python",
  "anthropic-node",
  "anthropic-python",
  "gemini-python",
  "vercel-ai-sdk",
  "langchain-python",
  "langchain-js",
  "curl",
] as const;

export function buildConnectInfo(baseUrl: string, model = "gpt-4o-mini", session?: string): ConnectInfo {
  const base = baseUrl.replace(/\/+$/, "");
  const v1 = `${base}/v1`;
  const env: Record<string, string> = {
    DOTMOCK_URL: base,
    OPENAI_BASE_URL: v1,
    OPENAI_API_KEY: "dotmock",
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_API_KEY: "dotmock",
    GOOGLE_GEMINI_BASE_URL: base,
    GEMINI_API_KEY: "dotmock",
    ...(session ? { DOTMOCK_SESSION: session } : {}),
  };

  const snippets: Record<string, string> = {
    "openai-node": `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${v1}", apiKey: "dotmock" });
const res = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: "hello" }],
});
console.log(res.choices[0].message.content);`,
    "openai-python": `from openai import OpenAI

client = OpenAI(base_url="${v1}", api_key="dotmock")
res = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "hello"}],
)
print(res.choices[0].message.content)`,
    "anthropic-node": `import Anthropic from "@anthropic-ai/sdk";

// The SDK appends /v1/messages to baseURL.
const client = new Anthropic({ baseURL: "${base}", apiKey: "dotmock" });
const msg = await client.messages.create({
  model: "claude-sonnet-4-5",
  max_tokens: 256,
  messages: [{ role: "user", content: "hello" }],
});
console.log(msg.content);`,
    "anthropic-python": `from anthropic import Anthropic

client = Anthropic(base_url="${base}", api_key="dotmock")
msg = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=256,
    messages=[{"role": "user", "content": "hello"}],
)
print(msg.content)`,
    "gemini-python": `from google import genai
from google.genai import types

client = genai.Client(
    api_key="dotmock",
    http_options=types.HttpOptions(base_url="${base}"),
)
res = client.models.generate_content(model="gemini-2.5-flash", contents="hello")
print(res.text)`,
    "vercel-ai-sdk": `import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

const openai = createOpenAI({ baseURL: "${v1}", apiKey: "dotmock" });
const { text } = await generateText({
  model: openai.chat("${model}"),
  prompt: "hello",
});
console.log(text);`,
    "langchain-python": `from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="${model}", base_url="${v1}", api_key="dotmock")
print(llm.invoke("hello").content)`,
    "langchain-js": `import { ChatOpenAI } from "@langchain/openai";

const llm = new ChatOpenAI({
  model: "${model}",
  apiKey: "dotmock",
  configuration: { baseURL: "${v1}" },
});
console.log((await llm.invoke("hello")).content);`,
    curl: `curl ${v1}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "X-Dotmock-Session: ${session ?? "demo"}" \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"hello"}]}'`,
  };

  return { baseUrl: base, openaiBaseUrl: v1, env, snippets };
}

export function renderEnv(env: Record<string, string>, shell: "sh" | "dotenv" = "sh"): string {
  return Object.entries(env)
    .map(([key, value]) => (shell === "sh" ? `export ${key}=${value}` : `${key}=${value}`))
    .join("\n");
}
