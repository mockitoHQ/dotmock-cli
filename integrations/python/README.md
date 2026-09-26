# pytest-dotmock

pytest plugin that runs a local [DotMock](https://dotmock.com) server from your
`dotmock.yaml` (LLM fixtures and OpenAPI mocks, no account needed) and lets tests
assert which fixture answered each request.

```sh
pip install pytest-dotmock
npx @dotmock/cli init --llm      # or: npm i -g @dotmock/cli && dotmock init --llm
```

The server runs from a `dotmock-server` binary on `PATH`, otherwise from the
`ghcr.io/mockitohq/dotmock-server` Docker image. If `DOTMOCK_URL` is set (for
example by the DotMock GitHub Action) the plugin attaches to that server instead.

```python
from openai import OpenAI

def test_greeting(dotmock):
    client = OpenAI(base_url=dotmock.openai_base_url(), api_key="dotmock")
    res = client.chat.completions.create(
        model="gpt-4o-mini", messages=[{"role": "user", "content": "hello"}]
    )
    assert "DotMock" in res.choices[0].message.content
    dotmock.assert_fixture_matched("greeting", times=1)
```

## Fixtures

- `dotmock_server` (session): starts or attaches once, exports `DOTMOCK_URL`,
  `OPENAI_BASE_URL`, and `ANTHROPIC_BASE_URL` for the session.
- `dotmock` (function): the same server, with sequence counters and the journal
  reset before each test.

Handle methods: `base_url(api=None)`, `openai_base_url(api=None)`,
`anthropic_base_url(api=None)`, `reset(api=None, session=None)`,
`journal(api=None, session=None, fixture=None)`,
`assert_fixture_matched(name, times=None, api=None, session=None)`.

## Options

| CLI flag | ini key | Default |
| --- | --- | --- |
| `--dotmock-config` | `dotmock_config` | `dotmock.yaml` (or `$DOTMOCK_CONFIG`) |
| `--dotmock-port` | | free port |
| `--dotmock-image` | `dotmock_image` | `ghcr.io/mockitohq/dotmock-server:latest` |
| `--dotmock-runtime` | | `auto` (`binary`, `docker`) |

## Development

```sh
python -m venv .venv && . .venv/bin/activate
pip install -e . && pytest
```

The end-to-end test is skipped unless `dotmock-server` is on `PATH` or the
Docker image has already been pulled.
