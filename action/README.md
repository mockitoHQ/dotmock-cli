# DotMock GitHub Action

Points a job at a hosted DotMock LLM mock. It installs `@dotmock/cli` (`^0.3.0`),
authenticates with your API key, optionally applies a `dotmock.yaml` definition,
resets sequence counters for a per-run session, and exports the mock's base URLs
for every later step. The post step prints the session's journal summary (which
fixture answered each request) and adds it to the job summary.

```yaml
name: test
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22

      - name: DotMock
        id: dotmock
        uses: mockitoHQ/dotmock-cli/action@v1
        with:
          api-key: ${{ secrets.DOTMOCK_API_KEY }}
          config: dotmock.yaml      # optional: `dotmock config apply` first
          # api: assistant          # id or subdomain; optional when config is set
          # session defaults to ${{ github.run_id }}-${{ github.run_attempt }}

      - run: npm ci
      # Send `X-Dotmock-Session: $DOTMOCK_SESSION` with each request (e.g. the
      # OpenAI SDK's defaultHeaders) so parallel runs do not share sequence counters.
      - run: npm test
```

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `api-key` | yes | | DotMock API key, from a secret. It is masked in logs. |
| `api` | when no `config` | | API id or subdomain. |
| `config` | no | | Definition to apply with `dotmock config apply` before the tests. |
| `session` | no | `${{ github.run_id }}-${{ github.run_attempt }}` | `X-Dotmock-Session` isolating this run's sequence counters and journal. |
| `cli-version` | no | `^0.3.0` | `@dotmock/cli` version range. |
| `api-url` | no | hosted service | DotMock API base URL override. |
| `working-directory` | no | `.` | Directory `config` is resolved against. |
| `export-dummy-keys` | no | `true` | Set `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` to `dotmock` when unset. |
| `journal-summary` | no | `true` | Report the session's journal in the post step. |

## Outputs and environment

Outputs: `url`, `openai-base-url`, `anthropic-base-url`, `api-id`, `session`, e.g.
`${{ steps.dotmock.outputs.openai-base-url }}`.

Exported to later steps: `DOTMOCK_URL`, `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`,
`GOOGLE_GEMINI_BASE_URL`, `DOTMOCK_SESSION`, `DOTMOCK_API` (the API id), and
`DOTMOCK_API_KEY` (masked), so `dotmock llm journal "$DOTMOCK_API" --session "$DOTMOCK_SESSION"`
and `connectDotmock()` from `@dotmock/cli/testing` work without arguments. The
installed `dotmock` binary is added to `PATH`.

This is a dependency-free JavaScript action rather than a composite one because
composite actions cannot register a post step.
