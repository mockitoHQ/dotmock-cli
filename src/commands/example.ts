import { Command } from 'commander';
import chalk from 'chalk';
import { api, ApiError } from '../client.js';
import { error, info, json, isJsonMode } from '../output.js';
import { detectLanguage, type Language } from '../detect.js';

interface ActionResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

async function executeAction(
  action: string,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  return api<ActionResult>('POST', '/internal/mcp/execute-action', {
    action,
    params,
    context: {},
  });
}

// ---------- LLM snippet generators ----------

function llmTypescript(url: string): string {
  return `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${url}/v1",
  apiKey: "mock",           // any string works
});

const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
});

console.log(response.choices[0].message.content);`;
}

function llmPython(url: string): string {
  return `from openai import OpenAI

client = OpenAI(
    base_url="${url}/v1",
    api_key="mock",           # any string works
)

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello"}],
)

print(response.choices[0].message.content)`;
}

function llmCurl(url: string): string {
  return `curl ${url}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer mock" \\
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`;
}

function llmGo(url: string): string {
  return `package main

import (
	"context"
	"fmt"
	openai "github.com/sashabaranov/go-openai"
)

func main() {
	cfg := openai.DefaultConfig("mock")
	cfg.BaseURL = "${url}/v1"
	client := openai.NewClientWithConfig(cfg)

	resp, err := client.CreateChatCompletion(context.Background(),
		openai.ChatCompletionRequest{
			Model:    "gpt-4o",
			Messages: []openai.ChatCompletionMessage{
				{Role: "user", Content: "Hello"},
			},
		},
	)
	if err != nil {
		panic(err)
	}
	fmt.Println(resp.Choices[0].Message.Content)
}`;
}

function llmRuby(url: string): string {
  return `require "ruby-openai"

client = OpenAI::Client.new(
  uri_base: "${url}/v1",
  access_token: "mock",
)

response = client.chat(parameters: {
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello" }],
})

puts response.dig("choices", 0, "message", "content")`;
}

function llmJava(url: string): string {
  return `import com.theokanning.openai.completion.chat.*;
import com.theokanning.openai.service.OpenAiService;

var service = new OpenAiService("mock");
// Point to mock URL: ${url}/v1

var message = new ChatMessage("user", "Hello");
var request = ChatCompletionRequest.builder()
    .model("gpt-4o")
    .messages(List.of(message))
    .build();

var result = service.createChatCompletion(request);
System.out.println(result.getChoices().get(0).getMessage().getContent());`;
}

const LLM_GENERATORS: Record<Language, (url: string) => string> = {
  typescript: llmTypescript,
  python: llmPython,
  curl: llmCurl,
  go: llmGo,
  ruby: llmRuby,
  java: llmJava,
};

// ---------- REST snippet generators ----------

function restTypescript(url: string, method: string, path: string): string {
  const upper = method.toUpperCase();
  const opts =
    upper === 'GET'
      ? ''
      : `,\n  method: "${upper}",\n  headers: { "Content-Type": "application/json" },\n  body: JSON.stringify({})`;
  return `const res = await fetch("${url}${path}"${opts ? opts + '\n' : ''});
const data = await res.json();
console.log(data);`;
}

function restPython(url: string, method: string, path: string): string {
  const lower = method.toLowerCase();
  return `import requests

res = requests.${lower}("${url}${path}")
print(res.json())`;
}

function restCurl(url: string, method: string, path: string): string {
  const upper = method.toUpperCase();
  if (upper === 'GET') return `curl ${url}${path}`;
  return `curl -X ${upper} ${url}${path} \\
  -H "Content-Type: application/json" \\
  -d '{}'`;
}

function restGo(url: string, method: string, path: string): string {
  return `resp, err := http.${method === 'GET' ? 'Get' : 'Post'}("${url}${path}", "application/json", nil)
if err != nil {
    log.Fatal(err)
}
defer resp.Body.Close()
body, _ := io.ReadAll(resp.Body)
fmt.Println(string(body))`;
}

function restRuby(url: string, method: string, path: string): string {
  return `require "net/http"
require "json"

uri = URI("${url}${path}")
res = Net::HTTP.${method.toLowerCase() === 'get' ? 'get_response' : 'post'}(uri)
puts JSON.parse(res.body)`;
}

function restJava(url: string, method: string, path: string): string {
  return `var client = HttpClient.newHttpClient();
var request = HttpRequest.newBuilder()
    .uri(URI.create("${url}${path}"))
    .${method.toUpperCase() === 'GET' ? 'GET' : `method("${method.toUpperCase()}", HttpRequest.BodyPublishers.ofString("{}"))`}()
    .build();
var response = client.send(request, HttpResponse.BodyHandlers.ofString());
System.out.println(response.body());`;
}

type RestGenerator = (url: string, method: string, path: string) => string;

const REST_GENERATORS: Record<Language, RestGenerator> = {
  typescript: restTypescript,
  python: restPython,
  curl: restCurl,
  go: restGo,
  ruby: restRuby,
  java: restJava,
};

// ---------- Command ----------

export const exampleCommand = new Command('example')
  .description('Generate usage examples for a mock API')
  .argument('<slug>', 'API slug')
  .option(
    '--lang <language>',
    'Language (typescript, python, curl, go, ruby, java)',
  )
  .action(async (slug: string, opts) => {
    try {
      const lang: Language = opts.lang || detectLanguage();

      const result = await executeAction('dotmock_get_api', { apiId: slug });

      if (!result.success) {
        error(result.error || 'API not found.');
        process.exitCode = 1;
        return;
      }

      const data = result.data || {};
      const mockUrl = String(data.url || data.mockUrl || `https://${slug}.mock.dotmock.com`);
      const apiType = String(data.type || 'rest');

      if (isJsonMode()) {
        const snippets: string[] = [];
        if (apiType === 'llm') {
          snippets.push(LLM_GENERATORS[lang](mockUrl));
        } else {
          const endpoints = (data.endpoints as Record<string, unknown>[]) || [];
          const gen = REST_GENERATORS[lang];
          for (const ep of endpoints.slice(0, 5)) {
            snippets.push(
              gen(mockUrl, String(ep.method || 'GET'), String(ep.path || '/')),
            );
          }
          if (endpoints.length === 0) {
            snippets.push(gen(mockUrl, 'GET', '/'));
          }
        }
        json({ slug, language: lang, type: apiType, mockUrl, snippets });
        return;
      }

      console.log('');
      info(`API: ${data.name || slug}`);
      info(`Mock URL: ${chalk.underline(mockUrl)}`);
      info(`Language: ${lang}`);
      console.log('');

      if (apiType === 'llm') {
        printCodeBlock(lang, LLM_GENERATORS[lang](mockUrl));
      } else {
        const endpoints = (data.endpoints as Record<string, unknown>[]) || [];
        const gen = REST_GENERATORS[lang];

        if (endpoints.length === 0) {
          printCodeBlock(lang, gen(mockUrl, 'GET', '/'));
        } else {
          for (const ep of endpoints.slice(0, 5)) {
            const method = String(ep.method || 'GET');
            const path = String(ep.path || '/');
            console.log(chalk.dim(`--- ${method} ${path} ---`));
            printCodeBlock(lang, gen(mockUrl, method, path));
          }
        }
      }
    } catch (err) {
      if (err instanceof ApiError) {
        error(`Failed to generate examples (HTTP ${err.status}): ${err.message}`);
      } else {
        error(`Failed to generate examples: ${(err as Error).message}`);
      }
      process.exitCode = 1;
    }
  });

function printCodeBlock(lang: string, code: string): void {
  console.log(chalk.dim('```' + lang));
  console.log(code);
  console.log(chalk.dim('```'));
  console.log('');
}
