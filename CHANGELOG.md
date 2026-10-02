# Changelog

## 0.3.1 — 2026-10-02

### Changed

- Destructive commands (`delete api`, `config publish|rollback`) require `--yes`
  (or `--force`) when there is no TTY, in CI, or with `--json`; `--json` alone is
  no longer treated as consent.

### Fixed

- `dotmock config apply` on the `dotmock init --llm` file failed with
  "update_llm_runtime_settings requires explicit confirmation". Settings updates,
  prune deletes, `llm vcr`, `delete api|fixture`, `config publish|rollback`,
  realtime/webhook deletes, and live SOAP/gRPC tests now send `approved: true`
  (the explicit CLI command is the consent).
- `config apply` validates and plans before writing, applies settings before
  fixtures, rolls back on failure with a clear partial-state message, and writes
  the stored id and subdomain back to the file.
- `dotmock status` no longer crashes on the current plan shape
  (`usageBalanceMicrodollars`, `activeWorkspaces`, ...) or missing fields.
- API references (id, subdomain, requested subdomain prefix, or name) are
  resolved locally; unknown references fail with suggestions instead of being
  sent to the backend.
- Mock URLs prefer the backend's canonical `fullUrl` (`localUrl` against a local
  stack) and collapse a doubled team suffix.

### Added

- `dotmock create api --from` detects Postman collections and HAR files and
  converts them to OpenAPI with recorded examples.
- `dotmock test --kind llm --message ... [--provider --model --system --session]`.
- `--yes` on `delete api`, `config publish`, and `config rollback`; without it
  they fail fast in CI, `--json`, or non-TTY shells instead of waiting on stdin.
  `--json` no longer implies confirmation for `delete api`.
- `dotmock config validate` defaults to `dotmock.yaml` and validates `kind: llm`
  locally without `--api`.
- A PyPI trusted-publishing workflow for `pytest-dotmock` (not yet released).

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
