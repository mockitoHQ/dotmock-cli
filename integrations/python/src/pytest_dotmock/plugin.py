"""pytest entry point: `dotmock_server` (session) and `dotmock` (per test, reset first) fixtures."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator

import pytest

from .server import DEFAULT_IMAGE, DotmockServer


def pytest_addoption(parser: pytest.Parser) -> None:
    group = parser.getgroup("dotmock")
    group.addoption("--dotmock-config", default=None, help="DotMock project file (default: dotmock.yaml)")
    group.addoption("--dotmock-port", type=int, default=None, help="Port for the local server (default: free port)")
    group.addoption("--dotmock-image", default=None, help=f"Docker image (default: {DEFAULT_IMAGE})")
    group.addoption("--dotmock-runtime", default=None, choices=["auto", "binary", "docker"], help="How to run dotmock-server")
    parser.addini("dotmock_config", "DotMock project file", default="dotmock.yaml")
    parser.addini("dotmock_image", "dotmock-server Docker image", default=DEFAULT_IMAGE)


@pytest.fixture(scope="session")
def dotmock_server(pytestconfig: pytest.Config) -> Iterator[DotmockServer]:
    """Session-wide DotMock server. Attaches to $DOTMOCK_URL (e.g. the GitHub Action) when set."""
    config_opt = pytestconfig.getoption("dotmock_config") or os.environ.get("DOTMOCK_CONFIG") or pytestconfig.getini("dotmock_config")
    config = Path(config_opt)
    if not config.is_absolute():
        config = Path(pytestconfig.rootpath) / config
    server = DotmockServer(
        config=config,
        port=pytestconfig.getoption("dotmock_port"),
        image=pytestconfig.getoption("dotmock_image") or pytestconfig.getini("dotmock_image"),
        runtime=pytestconfig.getoption("dotmock_runtime") or "auto",
        url=os.environ.get("DOTMOCK_URL") or None,
    )
    server.start()
    previous = {key: os.environ.get(key) for key in server.env()}
    os.environ.update(server.env())
    try:
        yield server
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        if not server.external:
            server.stop()


@pytest.fixture
def dotmock(dotmock_server: DotmockServer) -> Iterator[DotmockServer]:
    """Per-test handle: sequence counters and journal are reset before the test runs."""
    dotmock_server.reset()
    yield dotmock_server
