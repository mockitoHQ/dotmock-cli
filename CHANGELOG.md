# Changelog

## 0.3.0

DotMock runs as a hosted service only; the CLI no longer runs or manages a mock
server on your machine.

### Removed

- `dotmock serve` and the `ghcr.io/mockitohq/dotmock-server` image it used
  (added in 0.2.0), together with `--local` on `dotmock llm journal`, `reset`,
  and `connect`, and the `dotmock-project` project-file format and schema.
- `startDotmock()` / `stopDotmock()` in `@dotmock/cli/testing`, which launched
  a server.

### Changed

- `dotmock init --llm` writes a `dotmock/v2` LLM definition (same starter
  fixtures) and prints the next steps: `dotmock login`, `dotmock config apply`,
  `dotmock llm connect <api>`.
- `dotmock config apply` / `plan` accept `kind: llm` definitions: the API is
  created on first apply (its id is written back to the file), fixtures are
  synced by name (`--prune` deletes hosted fixtures missing from the file), and
  settings are updated. `--api` and `-f` are optional (`-f` defaults to
  `dotmock.yaml`).
- `dotmock llm ...` and `dotmock mock url` accept an API id, subdomain, or name.
  `dotmock llm connect --session <id>` adds `DOTMOCK_SESSION` and reports `apiId`.
- The mock URL fallback is `https://<subdomain>.mock.rest`.
- `@dotmock/cli/testing`: `connectDotmock({ api, apiKey, session })` returns the
  hosted base URLs and `X-Dotmock-Session` headers; `resetDotmock()`,
  `getJournal()`, and `expectFixtureMatched()` call the hosted API for that
  session and only see requests since the last reset. `disconnectDotmock()`
  restores the environment.
- GitHub Action: now takes `api-key` (required), `api`, `config`, and `session`
  (default `<run_id>-<run_attempt>`); it applies the optional config, resets the
  session, exports `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `DOTMOCK_URL`, and
  `DOTMOCK_SESSION`, and summarizes the session's journal in the post step.
- `pytest-dotmock` 0.2.0 targets the hosted API with a session per test and
  skips when no API key is set.

## 0.2.0

- LLM tooling (`dotmock llm journal|reset|recordings|promote|vcr|connect`),
  test helpers, a GitHub Action, and a pytest plugin. Its local mode
  (`dotmock serve`) was removed in 0.3.0.
