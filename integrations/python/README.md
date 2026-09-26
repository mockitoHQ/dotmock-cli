# pytest-dotmock

pytest plugin for hosted [DotMock](https://dotmock.com) LLM mocks. Each test gets
its own `X-Dotmock-Session`, so sequence counters and the request journal are
isolated per test, and tests can assert which fixture answered each request.

```sh
pip install pytest-dotmock
npx @dotmock/cli init --llm && npx @dotmock/cli login && npx @dotmock/cli config apply
export DOTMOCK_API_KEY=mck_...   # or rely on the key saved by `dotmock login`
export DOTMOCK_API=assistant     # API id or subdomain
```

```python
from openai import OpenAI

def test_greeting(dotmock):
    client = OpenAI(base_url=dotmock.openai_base_url(), api_key="dotmock",
                    default_headers=dotmock.headers)
    res = client.chat.completions.create(
        model="gpt-4o-mini", messages=[{"role": "user", "content": "hello"}]
    )
    assert "DotMock" in res.choices[0].message.content
    dotmock.assert_fixture_matched("greeting", times=1)
```

Tests that use the fixtures are skipped when no API key is available.

## Fixtures

- `dotmock_api` (session): resolves the API and exports `DOTMOCK_URL`,
  `DOTMOCK_API`, `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` and
  `GOOGLE_GEMINI_BASE_URL` for the run.
- `dotmock` (function): a handle with a per-test session (exported as
  `DOTMOCK_SESSION`), reset before the test runs.

Handle: `openai_base_url()`, `anthropic_base_url()`, `headers` (send these with
every request), `env()`, `reset()`, `journal(fixture=None, all=False)`,
`assert_fixture_matched(name, times=None, timeout=5.0)`, `with_session(session)`.
`Dotmock(api, api_key=None, api_url=None, session=None)` works outside pytest too.

## Configuration

| Setting | Source |
| --- | --- |
| API key | `DOTMOCK_API_KEY`, else `~/.dotmock/config.json` from `dotmock login` |
| API | `--dotmock-api`, `DOTMOCK_API`, or the `dotmock_api` ini key |
| Session prefix | `--dotmock-session` or `DOTMOCK_SESSION` (set per run by the DotMock GitHub Action) |
| DotMock API URL | `DOTMOCK_API_URL` (default `https://dotmock.com/api`) |

## Development

```sh
python -m venv .venv && . .venv/bin/activate
pip install -e . pytest && pytest
```

The hosted end-to-end test runs only when `DOTMOCK_API_KEY` and `DOTMOCK_API` are set.
