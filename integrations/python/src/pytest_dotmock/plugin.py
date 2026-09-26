"""pytest entry point: `dotmock_api` (session) and `dotmock` (per test, own X-Dotmock-Session) fixtures."""

from __future__ import annotations

import os
import time
from typing import Iterator

import pytest

from .client import Dotmock, api_key_from_env, session_for


def pytest_addoption(parser: pytest.Parser) -> None:
    group = parser.getgroup("dotmock")
    group.addoption("--dotmock-api", default=None, help="DotMock API id or subdomain (default: $DOTMOCK_API)")
    group.addoption("--dotmock-session", default=None, help="Session prefix for this run (default: $DOTMOCK_SESSION)")
    parser.addini("dotmock_api", "DotMock API id or subdomain", default="")


@pytest.fixture(scope="session")
def dotmock_api(pytestconfig: pytest.Config) -> Iterator[Dotmock]:
    """The hosted API for this run. Skips when no DotMock API key is available."""
    key = api_key_from_env()
    if not key:
        pytest.skip("DOTMOCK_API_KEY is not set")
    api = pytestconfig.getoption("dotmock_api") or os.environ.get("DOTMOCK_API") or pytestconfig.getini("dotmock_api")
    if not api:
        raise pytest.UsageError("pytest-dotmock needs an API: --dotmock-api, DOTMOCK_API, or the dotmock_api ini key.")
    prefix = pytestconfig.getoption("dotmock_session") or os.environ.get("DOTMOCK_SESSION") or f"pytest-{int(time.time())}-{os.getpid()}"
    handle = Dotmock(api, api_key=key, session=prefix).connect()
    env = handle.env()
    previous = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    try:
        yield handle
    finally:
        for k, v in previous.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


@pytest.fixture
def dotmock(dotmock_api: Dotmock, request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> Iterator[Dotmock]:
    """Per-test handle with its own X-Dotmock-Session (exported as DOTMOCK_SESSION), reset before the test."""
    handle = dotmock_api.with_session(session_for(dotmock_api.session, request.node.nodeid))
    monkeypatch.setenv("DOTMOCK_SESSION", handle.session)
    handle.reset()
    yield handle
