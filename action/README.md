# DotMock GitHub Action

Runs `dotmock serve` against your repository's `dotmock.yaml` for the rest of the job
(offline local mode, no DotMock account or API key needed) and stops it in the post step.

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

      - name: Start DotMock
        id: dotmock
        uses: dotmock/dotmock-cli/action@v1
        with:
          config: dotmock.yaml   # default
          port: "8080"           # default

      - run: npm ci
      # OPENAI_BASE_URL, ANTHROPIC_BASE_URL and DOTMOCK_URL are exported for every later step,
      # and @dotmock/cli/testing's startDotmock() attaches to DOTMOCK_URL automatically.
      - run: npm test

      - name: Show which fixtures answered
        if: always()
        run: dotmock llm journal assistant --local
```

Inputs: `config`, `port`, `image` (default `ghcr.io/dotmock/dotmock-server:latest`), `runtime`
(`auto` | `binary` | `docker`), `cli-version`, `timeout`, `working-directory`, `export-dummy-keys`.

Outputs: `url`, `openai-base-url`, `anthropic-base-url`, `apis` (JSON), e.g.
`${{ steps.dotmock.outputs.openai-base-url }}`.

Environment exported to later steps: `DOTMOCK_URL`, `DOTMOCK_LLM_URL`, `OPENAI_BASE_URL`,
`ANTHROPIC_BASE_URL`, `DOTMOCK_CONFIG`, `DOTMOCK_STATE_DIR`, and (unless already set)
`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` = `dotmock`.

This is a JavaScript action rather than a composite one because composite actions cannot
register the post step that stops the server.
