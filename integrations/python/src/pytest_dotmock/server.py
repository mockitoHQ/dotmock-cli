"""Start/attach to a local dotmock-server (contract C6) and talk to its /__dotmock endpoints."""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

DEFAULT_IMAGE = "ghcr.io/dotmock/dotmock-server:latest"
HEALTH_PATH = "/__dotmock/health"


class DotmockError(RuntimeError):
    pass


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _request(method: str, url: str, body: Optional[dict] = None, timeout: float = 5.0) -> Any:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - local URL
        raw = resp.read().decode()
    return json.loads(raw) if raw else None


def _healthy(url: str) -> bool:
    try:
        with urllib.request.urlopen(url.rstrip("/") + HEALTH_PATH, timeout=1) as resp:  # noqa: S310
            return 200 <= resp.status < 300
    except (urllib.error.URLError, OSError):
        return False


def load_apis(config_path: Optional[Path]) -> List[Dict[str, Any]]:
    if not config_path or not config_path.exists():
        return []
    data = yaml.safe_load(config_path.read_text()) or {}
    apis = data.get("apis")
    if apis is None and data.get("type"):
        apis = [data]
    return [a for a in (apis or []) if isinstance(a, dict)]


def available_runtime(image: str = DEFAULT_IMAGE, require_local_image: bool = False) -> Optional[str]:
    """Return "binary", "docker", or None. With require_local_image, docker only counts if the image is present."""
    if os.environ.get("DOTMOCK_SERVER_BIN") or shutil.which("dotmock-server"):
        return "binary"
    docker = shutil.which("docker")
    if not docker:
        return None
    try:
        if subprocess.run([docker, "info"], capture_output=True, timeout=10).returncode != 0:
            return None
        if require_local_image and subprocess.run([docker, "image", "inspect", image], capture_output=True, timeout=10).returncode != 0:
            return None
    except (OSError, subprocess.TimeoutExpired):
        return None
    return "docker"


class DotmockServer:
    """A running (or attached) DotMock local-mode server."""

    def __init__(
        self,
        config: Optional[os.PathLike] = None,
        port: Optional[int] = None,
        image: str = DEFAULT_IMAGE,
        runtime: str = "auto",
        timeout: float = 60.0,
        url: Optional[str] = None,
    ) -> None:
        self.config = Path(config).resolve() if config else None
        self.port = port
        self.image = os.environ.get("DOTMOCK_SERVER_IMAGE", image)
        self.runtime = runtime
        self.timeout = timeout
        self.url = url.rstrip("/") if url else None
        self.external = url is not None
        self._proc: Optional[subprocess.Popen] = None
        self._container: Optional[str] = None
        self.apis = load_apis(self.config)

    # ---- lifecycle -------------------------------------------------------

    def start(self) -> "DotmockServer":
        if self.url:
            if not _healthy(self.url):
                raise DotmockError(f"{self.url}{HEALTH_PATH} is not healthy")
            return self
        if not self.config or not self.config.exists():
            raise DotmockError(f"DotMock config not found: {self.config} (run `dotmock init --llm`)")
        self.port = self.port or _free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        runtime = self.runtime
        binary = os.environ.get("DOTMOCK_SERVER_BIN") or shutil.which("dotmock-server")
        if runtime == "auto":
            runtime = "binary" if binary else "docker"
        if runtime == "binary":
            if not binary:
                raise DotmockError("dotmock-server binary not found on PATH")
            env = {**os.environ, "DOTMOCK_LOCAL_MODE": "true", "DOTMOCK_LOCAL_CONFIG": str(self.config), "PORT": str(self.port)}
            self._proc = subprocess.Popen([binary], env=env, cwd=self.config.parent, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        else:
            docker = shutil.which("docker")
            if not docker:
                raise DotmockError("Neither dotmock-server nor docker is available")
            self._container = f"dotmock-pytest-{self.port}"
            subprocess.run([docker, "rm", "-f", self._container], capture_output=True)
            result = subprocess.run(
                [
                    docker, "run", "-d", "--name", self._container,
                    "-p", f"127.0.0.1:{self.port}:8080",
                    "--add-host", "host.docker.internal:host-gateway",
                    "-v", f"{self.config.parent}:/dotmock:ro",
                    "-e", "DOTMOCK_LOCAL_MODE=true",
                    "-e", f"DOTMOCK_LOCAL_CONFIG=/dotmock/{self.config.name}",
                    "-e", "PORT=8080",
                    self.image,
                ],
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                raise DotmockError(f"docker run failed: {result.stderr.strip()}")
        self._wait_healthy()
        return self

    def _wait_healthy(self) -> None:
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            if self._proc is not None and self._proc.poll() is not None:
                err = self._proc.stderr.read().decode() if self._proc.stderr else ""
                raise DotmockError(f"dotmock-server exited with {self._proc.returncode}: {err[-2000:]}")
            if _healthy(self.url):
                return
            time.sleep(0.25)
        logs = ""
        if self._container:
            logs = subprocess.run(["docker", "logs", "--tail", "40", self._container], capture_output=True, text=True).stdout
        self.stop()
        raise DotmockError(f"dotmock-server not healthy at {self.url}{HEALTH_PATH} after {self.timeout}s\n{logs}")

    def stop(self) -> None:
        if self._proc is not None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._proc.kill()
            self._proc = None
        if self._container:
            subprocess.run(["docker", "rm", "-f", self._container], capture_output=True)
            self._container = None

    def __enter__(self) -> "DotmockServer":
        return self.start()

    def __exit__(self, *exc: object) -> None:
        if not self.external:
            self.stop()

    # ---- URLs ------------------------------------------------------------

    def _api(self, api: Optional[str], llm: bool = False) -> Optional[str]:
        if api:
            return api
        for entry in self.apis:
            if not llm or entry.get("type") == "llm":
                return entry.get("subdomain")
        return None

    def base_url(self, api: Optional[str] = None) -> str:
        sub = self._api(api)
        return f"{self.url}/{sub}" if sub else str(self.url)

    def openai_base_url(self, api: Optional[str] = None) -> str:
        sub = self._api(api, llm=True)
        return f"{self.url}/{sub}/v1" if sub else f"{self.url}/v1"

    def anthropic_base_url(self, api: Optional[str] = None) -> str:
        sub = self._api(api, llm=True)
        return f"{self.url}/{sub}" if sub else str(self.url)

    def env(self) -> Dict[str, str]:
        return {
            "DOTMOCK_URL": str(self.url),
            "OPENAI_BASE_URL": self.openai_base_url(),
            "ANTHROPIC_BASE_URL": self.anthropic_base_url(),
        }

    # ---- runtime ---------------------------------------------------------

    def reset(self, api: Optional[str] = None, session: Optional[str] = None) -> None:
        params = {k: v for k, v in {"api": api, "session": session}.items() if v}
        query = f"?{urllib.parse.urlencode(params)}" if params else ""
        _request("POST", f"{self.url}/__dotmock/reset{query}", params)

    def journal(self, api: Optional[str] = None, session: Optional[str] = None, fixture: Optional[str] = None) -> List[Dict[str, Any]]:
        query = f"?{urllib.parse.urlencode({'api': api})}" if api else ""
        payload = _request("GET", f"{self.url}/__dotmock/journal{query}")
        if isinstance(payload, dict):
            payload = payload.get("entries") or payload.get("journal") or payload.get("data") or []
        entries = [e for e in (payload or []) if isinstance(e, dict)]
        if session:
            entries = [e for e in entries if (e.get("session") or "default") == session]
        if fixture:
            entries = [e for e in entries if fixture in (_fixture_name(e), _fixture_id(e))]
        return sorted(entries, key=lambda e: e.get("timestamp") or 0)

    def assert_fixture_matched(self, name: str, times: Optional[int] = None, **filters: Any) -> List[Dict[str, Any]]:
        entries = self.journal(**filters)
        hits = [e for e in entries if name in (_fixture_name(e), _fixture_id(e))]
        ok = len(hits) > 0 if times is None else len(hits) == times
        if not ok:
            seen = "\n  ".join(f"{e.get('path', '?')} -> {_fixture_name(e) or '(no match)'}" for e in entries) or "(empty)"
            expected = "at least once" if times is None else f"{times} time(s)"
            raise AssertionError(f'Expected fixture "{name}" to match {expected}, but it matched {len(hits)} time(s).\nJournal:\n  {seen}')
        return hits


def _fixture_name(entry: Dict[str, Any]) -> str:
    response = entry.get("response") or {}
    return response.get("fixtureName") or entry.get("fixtureName") or ""


def _fixture_id(entry: Dict[str, Any]) -> str:
    response = entry.get("response") or {}
    return response.get("fixtureId") or entry.get("fixtureId") or ""
