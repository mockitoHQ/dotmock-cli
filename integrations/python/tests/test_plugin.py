import json
import shutil
import textwrap
import urllib.request
from pathlib import Path

import pytest

from pytest_dotmock import DotmockServer
from pytest_dotmock.server import DEFAULT_IMAGE, available_runtime

CONFIG = textwrap.dedent(
    """\
    schemaVersion: dotmock/project-v1
    apis:
      - name: Chat
        subdomain: chat
        type: llm
        fixtures:
          - id: greeting
            name: greeting
            priority: 10
            enabled: true
            match: { userMessage: hello }
            response: { content: "Hello from DotMock", finishReason: stop }
          - id: fallback
            name: fallback
            priority: 1000
            enabled: true
            match: {}
            response: { content: "fallback", finishReason: stop }
    """
)


def chat(base_url, text, session=None):
    req = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps({"model": "gpt-4o-mini", "messages": [{"role": "user", "content": text}]}).encode(),
        headers={"Content-Type": "application/json", **({"X-Dotmock-Session": session} if session else {})},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def test_journal_reset_and_assertions_against_attached_server(fake_dotmock, tmp_path):
    (tmp_path / "dotmock.yaml").write_text(CONFIG)
    server = DotmockServer(config=tmp_path / "dotmock.yaml", url=fake_dotmock.url).start()
    assert server.openai_base_url() == f"{fake_dotmock.url}/chat/v1"
    assert server.env()["ANTHROPIC_BASE_URL"] == f"{fake_dotmock.url}/chat"

    chat(server.openai_base_url(), "hello", session="s1")
    chat(server.openai_base_url(), "something else")
    server.assert_fixture_matched("greeting", times=1)
    server.assert_fixture_matched("fallback", session="default")
    assert [e["response"]["fixtureName"] for e in server.journal()] == ["greeting", "fallback"]
    with pytest.raises(AssertionError, match=r'(?s)Expected fixture "refusal".*greeting'):
        server.assert_fixture_matched("refusal")

    server.reset(api="chat", session="s1")
    assert fake_dotmock.resets[-1] == {"api": "chat", "session": "s1"}
    assert server.journal() == []


def test_plugin_fixture_attaches_to_dotmock_url_and_resets_per_test(pytester, fake_dotmock, monkeypatch):
    monkeypatch.setenv("DOTMOCK_URL", fake_dotmock.url)
    pytester.makefile(".yaml", dotmock=CONFIG)
    pytester.makepyfile(
        """
        import json, os, urllib.request

        def _chat(url, text):
            req = urllib.request.Request(url + "/chat/completions", method="POST",
                data=json.dumps({"messages": [{"role": "user", "content": text}]}).encode(),
                headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req).read()

        def test_one(dotmock):
            assert os.environ["OPENAI_BASE_URL"] == dotmock.openai_base_url()
            _chat(dotmock.openai_base_url(), "hello")
            dotmock.assert_fixture_matched("greeting", times=1)

        def test_two_starts_clean(dotmock):
            assert dotmock.journal() == []
        """
    )
    result = pytester.runpytest()
    result.assert_outcomes(passed=2)
    assert len(fake_dotmock.resets) == 2


_RUNTIME = available_runtime(DEFAULT_IMAGE, require_local_image=True)


@pytest.mark.skipif(_RUNTIME is None, reason="needs dotmock-server on PATH or the dotmock-server Docker image pulled locally")
def test_real_server_end_to_end(tmp_path):
    (tmp_path / "dotmock.yaml").write_text(CONFIG)
    with DotmockServer(config=tmp_path / "dotmock.yaml", timeout=90) as server:
        reply = chat(server.openai_base_url(), "hello there")
        assert reply["choices"][0]["message"]["content"] == "Hello from DotMock"
        server.assert_fixture_matched("greeting", times=1)
        server.reset()
        assert server.journal() == []
