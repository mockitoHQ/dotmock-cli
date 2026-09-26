# DotMock CLI

Build, configure, exercise, and inspect controlled API environments from a
terminal, a test suite, CI, or a coding agent. This package (`@dotmock/cli`,
command `dotmock`) is the canonical DotMock CLI; the former Go CLI
(`dotmock-go-cli`, `brew install dotmock/tap/dotmock`) is deprecated.

## Install

Node.js 18 or newer is required.

```sh
npm i -g @dotmock/cli
dotmock --version
```

Or run without installing: `npx @dotmock/cli <command>`.

## Local mode (no account)

Run LLM and REST mocks locally from a `dotmock.yaml` project file:

```sh
dotmock init --llm              # greeting, tool-call round trip, structured output, refusal, rate limit
dotmock serve                   # dotmock-server on PATH, else docker ghcr.io/mockitohq/dotmock-server
export OPENAI_BASE_URL=http://127.0.0.1:8080/assistant/v1
```

`dotmock serve [--config dotmock.yaml] [--port 8080] [--detach]` waits for
`/__dotmock/health`, prints each API's base URL, and hot-reloads edits to the
file. With `--detach` it returns once healthy; stop it with
`dotmock serve stop --port 8080` (`dotmock serve status` checks it).

Project file format (JSON Schema: `schemas/dotmock-project.schema.json`):

```yaml
version: 1
apis:
  - name: Assistant
    subdomain: assistant        # X-Dotmock-Api header or /assistant/... prefix (default: slug of name)
    type: llm                   # llm | openapi (inferred from fixtures/spec when omitted)
    settings: { fallback: { type: none } }
    fixtures:
      - id: greeting
        name: greeting
        priority: 10
        match: { userMessage: "/\\b(hi|hello)\\b/" }
        response: { content: "Hello!", finishReason: stop }
  - name: Orders
    subdomain: orders
    type: openapi
    spec: ./openapi.yaml        # or an inline OpenAPI object
  - file: ./checkout.yaml       # include a `dotmock config pull` (dotmock/v2) file
```

Fixtures and settings use the same shapes as cloud LLM fixtures, so they can be
moved between a project file and DotMock unchanged. The same file runs directly
with `dotmock-server --local --config dotmock.yaml`.

## LLM workflows

```sh
dotmock llm connect <api>                    # base URL, env vars, OpenAI/Anthropic/Gemini/Vercel AI SDK/LangChain snippets
eval "$(dotmock llm connect <api> --env)"    # export OPENAI_BASE_URL, ANTHROPIC_BASE_URL, ...
dotmock llm journal <api> --follow           # which fixture answered each request (--session, --fixture)
dotmock llm reset <api> [--session ci-42]    # reset sequence counters
dotmock llm vcr <api> --upstream openai=https://api.openai.com --mode record
dotmock llm recordings <api>                 # recorded upstream calls
dotmock llm promote <api> <index>            # turn a recording into a fixture
```

Add `--local` to `connect`, `journal`, and `reset` to target `dotmock serve`
(`$DOTMOCK_URL`, default `http://127.0.0.1:8080`) with the API's subdomain.

## Tests

```ts
import { startDotmock, stopDotmock, resetDotmock, getJournal, expectFixtureMatched } from "@dotmock/cli/testing";

beforeAll(() => startDotmock({ config: "dotmock.yaml" })); // also exports OPENAI_BASE_URL etc.
afterAll(() => stopDotmock());
beforeEach(() => resetDotmock());

it("greets", async () => {
  // ... call your code that uses the OpenAI/Anthropic SDK ...
  await expectFixtureMatched("greeting", { times: 1 });
});
```

`@dotmock/cli/testing` is ESM and works with vitest, jest (ESM mode), and
`node:test`. When `DOTMOCK_URL` is set, `startDotmock()` attaches to that
server. See `examples/vitest/`. For Python, see `integrations/python/`
(`pytest-dotmock`).

## GitHub Actions

```yaml
- uses: mockitoHQ/dotmock-cli/action@v1
  with:
    config: dotmock.yaml
- run: npm test    # OPENAI_BASE_URL, ANTHROPIC_BASE_URL, DOTMOCK_URL are exported
```

The server stops in the action's post step. Details: `action/README.md`.

## Cloud workflows

```sh
dotmock login                                  # browser approval, stores ~/.dotmock/config.json
dotmock --json list apis
dotmock create api --name "Orders" --from openapi.yaml
dotmock mock url <api>                         # base URL an app or test should call
dotmock --json test --api "$API_ID" --method GET --path /orders
dotmock captures assert --api <api> --method POST --path /v1/orders --body-contains sku_123
dotmock webhook listen --api "$WEBHOOK_API_ID" --forward-to http://localhost:3000/webhooks
dotmock skill install --scope project --agent auto
```

`captures assert` exits 1 when no captured request matches. To connect an
onboarding session already open in the browser, run the exact command shown
there: `dotmock login --setup-id <setup-id>`.

In CI, inject a scoped API key instead of logging in:

```sh
export DOTMOCK_API_KEY=mck_...
dotmock --json status
```

Read the complete [DotMock CLI guide](https://dotmock.com/docs/guides/cli) for
REST, realtime, GraphQL, SOAP, gRPC, LLM, webhook, state, and agent workflows.

## Security

The browser login creates a team-scoped CLI credential. Never commit
`~/.dotmock/config.json`, API keys, or copied setup commands. Setup IDs are
short-lived and should be treated as secrets while active. VCR record mode
forwards the client's provider API key to the configured upstream.
