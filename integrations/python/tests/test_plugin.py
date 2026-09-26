import json
import os
import time
import urllib.request

import pytest

from pytest_dotmock import Dotmock, DotmockError

from conftest import API_ID


def test_client_resolves_hosted_urls_and_scopes_journal_to_session(fake_backend):
    dm = Dotmock("assistant", api_key="mck_test", api_url=fake_backend.url, session="run-1").connect()
    assert dm.api_id == API_ID
    assert dm.openai_base_url() == "https://assistant-t1a2b3c4.mock.rest/v1"
    assert dm.anthropic_base_url() == "https://assistant-t1a2b3c4.mock.rest"
    assert dm.headers == {"X-Dotmock-Session": "run-1"}
    assert dm.env()["DOTMOCK_SESSION"] == "run-1"

    fake_backend.record("run-1", "greeting")
    fake_backend.record("other", "greeting")
    fake_backend.record("run-1", "rate-limit")
    assert [e["id"] for e in dm.journal()] == ["1", "3"]
    dm.assert_fixture_matched("greeting", times=1)
    with pytest.raises(AssertionError, match=r'(?s)Expected fixture "refusal".*rate-limit'):
        dm.assert_fixture_matched("refusal", timeout=0)

    dm.reset()
    assert fake_backend.calls[-2] == ("dotmock_reset_llm_sequences", {"apiId": API_ID, "session": "run-1"})
    assert dm.journal() == []
    assert len(dm.journal(all=True)) == 2


def test_client_requires_an_api_key(monkeypatch, tmp_path):
    monkeypatch.delenv("DOTMOCK_API_KEY", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    with pytest.raises(DotmockError, match="DOTMOCK_API_KEY"):
        Dotmock("assistant")


def test_plugin_gives_each_test_its_own_session(pytester, fake_backend, monkeypatch):
    monkeypatch.setenv("DOTMOCK_API_KEY", "mck_test")
    monkeypatch.setenv("DOTMOCK_API", "assistant")
    monkeypatch.setenv("DOTMOCK_API_URL", fake_backend.url)
    monkeypatch.setenv("DOTMOCK_SESSION", "ci-7")
    pytester.makepyfile(
        """
        import os

        def test_one(dotmock):
            assert os.environ["OPENAI_BASE_URL"] == dotmock.openai_base_url()
            assert os.environ["DOTMOCK_SESSION"] == dotmock.session
            assert dotmock.session.startswith("ci-7-")
            assert dotmock.journal() == []

        def test_two(dotmock, dotmock_api):
            assert dotmock.session != dotmock_api.session
        """
    )
    result = pytester.runpytest()
    result.assert_outcomes(passed=2)
    resets = [params["session"] for action, params in fake_backend.calls if action == "dotmock_reset_llm_sequences"]
    assert len(resets) == 2 and len(set(resets)) == 2


def test_plugin_skips_without_an_api_key(pytester, monkeypatch, tmp_path):
    monkeypatch.delenv("DOTMOCK_API_KEY", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    pytester.makepyfile("def test_needs_dotmock(dotmock):\n    pass\n")
    result = pytester.runpytest("-rs")
    result.assert_outcomes(skipped=1)
    result.stdout.fnmatch_lines(["*DOTMOCK_API_KEY is not set*"])


@pytest.mark.skipif(
    not (os.environ.get("DOTMOCK_API_KEY") and os.environ.get("DOTMOCK_API")),
    reason="set DOTMOCK_API_KEY and DOTMOCK_API to run against the hosted service",
)
def test_hosted_end_to_end(dotmock):
    req = urllib.request.Request(
        dotmock.openai_base_url() + "/chat/completions",
        data=json.dumps({"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "hello"}]}).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer dotmock", **dotmock.headers},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        assert resp.status == 200
    entries = []
    for _ in range(20):
        entries = dotmock.journal()
        if entries:
            break
        time.sleep(0.25)
    assert entries, "the hosted journal should record the request for this session"
