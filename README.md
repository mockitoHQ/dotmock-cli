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

## Quick start: LLM mocks

DotMock is a hosted service: mocks run at `https://<subdomain>-<team>.mock.rest`
and are managed with your DotMock account or API key.

```sh
dotmock init --llm              # dotmock.yaml: greeting, tool-call round trip, structured output, refusal, rate limit
dotmock login                   # or: export DOTMOCK_API_KEY=mck_...
dotmock config apply            # creates the LLM API on first run, then syncs fixtures + settings
dotmock llm connect assistant   # base URL, env vars, and SDK snippets
```

`dotmock.yaml` is a `dotmock/v2` definition with `kind: llm`:

```yaml
schemaVersion: dotmock/v2
kind: llm
id: 0b6c1c9e-...                # written by the first `config apply`
name: Assistant
subdomain: assistant
protocol:
  source: llm
  settings: { fallback: { type: none } }
rules: []
fixtures:
  - name: greeting
    priority: 10
    match: { userMessage: "/\\b(hi|hello)\\b/" }
    response: { content: "Hello!", finishReason: stop }
```

`config apply` matches fixtures by name: new ones are created, existing ones
updated, and hosted fixtures missing from the file are kept unless you pass
`--prune`. `config plan` previews the changes. LLM fixtures are live as soon as
they are applied.

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

`<api>` is an API id, subdomain, or name. Send `X-Dotmock-Session: <id>` with
requests to isolate sequence counters and journal entries per test run.

## Tests

```ts
import { connectDotmock, disconnectDotmock, resetDotmock, expectFixtureMatched } from "@dotmock/cli/testing";

let dotmock;
beforeAll(async () => { dotmock = await connectDotmock({ api: "assistant" }); }); // exports OPENAI_BASE_URL etc.
afterAll(() => disconnectDotmock());
beforeEach(() => resetDotmock());

it("greets", async () => {
  // new OpenAI({ baseURL: dotmock.openaiBaseUrl, apiKey: "dotmock", defaultHeaders: dotmock.headers })
  await expectFixtureMatched("greeting", { times: 1 });
});
```

`connectDotmock({ api, apiKey, session })` defaults to `DOTMOCK_API`,
`DOTMOCK_API_KEY` (or the key saved by `dotmock login`) and `DOTMOCK_SESSION`
(else a random session). It returns `baseUrl`, `openaiBaseUrl`,
`anthropicBaseUrl`, `headers` (`X-Dotmock-Session`) and `env`. `resetDotmock()`,
`getJournal()` and `expectFixtureMatched()` call the hosted API for that session
and only see requests made since the last reset. The module is ESM and works
with vitest, jest (ESM mode), and `node:test`. See `examples/vitest/`. For
Python, see `integrations/python/` (`pytest-dotmock`).

## GitHub Actions

```yaml
- uses: mockitoHQ/dotmock-cli/action@v1
  with:
    api-key: ${{ secrets.DOTMOCK_API_KEY }}
    config: dotmock.yaml   # optional: apply before the tests
    # api: assistant       # id or subdomain; optional with config
- run: npm test            # OPENAI_BASE_URL, ANTHROPIC_BASE_URL, DOTMOCK_URL, DOTMOCK_SESSION are exported
```

Each run gets its own session (`<run_id>-<run_attempt>` by default), and the
post step summarizes that session's journal. Details: `action/README.md`.

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
