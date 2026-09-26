"""Talk to a hosted DotMock LLM mock: resolve its URLs, reset sessions, and read the journal."""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

DEFAULT_API_URL = "https://dotmock.com/api"
SESSION_HEADER = "X-Dotmock-Session"
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


class DotmockError(RuntimeError):
    pass


def api_key_from_env() -> Optional[str]:
    """DOTMOCK_API_KEY, else the key saved by `dotmock login` (~/.dotmock/config.json)."""
    key = os.environ.get("DOTMOCK_API_KEY")
    if key:
        return key
    try:
        return json.loads((Path.home() / ".dotmock" / "config.json").read_text()).get("apiKey") or None
    except (OSError, ValueError):
        return None


def session_for(prefix: str, test_id: str) -> str:
    """A stable, header-safe session id for one test within a run."""
    digest = hashlib.sha1(test_id.encode()).hexdigest()[:10]
    return f"{prefix}-{digest}"[:128]


def _unwrap(payload: Any) -> Any:
    if isinstance(payload, dict) and ("success" in payload or "data" in payload or "result" in payload):
        if payload.get("success") is False:
            raise DotmockError(payload.get("message") or payload.get("error") or "action failed")
        return payload.get("result", payload.get("data"))
    return payload


def _as_list(payload: Any, key: str) -> List[Dict[str, Any]]:
    if isinstance(payload, dict):
        payload = payload.get(key) or payload.get("entries") or payload.get("data") or []
    return [item for item in payload or [] if isinstance(item, dict)]


def _entry_key(entry: Dict[str, Any]) -> str:
    return str(entry.get("id") or f"{entry.get('timestamp')}:{entry.get('method')}:{entry.get('path')}:{_fixture_of(entry)}")


def _fixture_of(entry: Dict[str, Any]) -> str:
    response = entry.get("response") or {}
    return str(response.get("fixtureName") or response.get("fixtureId") or entry.get("fixtureName") or entry.get("fixtureId") or "")


def _base_url(api: Dict[str, Any]) -> str:
    dx = api.get("_dx") or {}
    for value in (dx.get("baseUrl"), api.get("baseUrl"), api.get("fullUrl"), api.get("url"), api.get("mockUrl")):
        if isinstance(value, str) and value.strip():
            return value.strip().rstrip("/")
    if api.get("subdomain"):
        return f"https://{api['subdomain']}.mock.rest"
    raise DotmockError("API response did not include a mock URL")


class Dotmock:
    """A hosted DotMock LLM mock plus the X-Dotmock-Session this handle uses.

    ``api`` is the API id, subdomain, or name. Nothing runs locally: requests go
    to ``https://<subdomain>-<team>.mock.rest`` and the reset/journal helpers call
    the DotMock API with ``api_key``.
    """

    def __init__(
        self,
        api: str,
        api_key: Optional[str] = None,
        api_url: Optional[str] = None,
        session: Optional[str] = None,
        timeout: float = 15.0,
    ) -> None:
        self.api = api
        self.api_key = api_key or api_key_from_env()
        if not self.api_key:
            raise DotmockError("No DotMock API key: set DOTMOCK_API_KEY or run `dotmock login`.")
        self.api_url = (api_url or os.environ.get("DOTMOCK_API_URL") or DEFAULT_API_URL).rstrip("/")
        self.session = session or os.environ.get("DOTMOCK_SESSION") or f"pytest-{int(time.time())}-{os.getpid()}"
        self.timeout = timeout
        self.api_id: Optional[str] = None
        self.base_url: Optional[str] = None
        self._baseline: set = set()

    # ---- API calls ----

    def _action(self, action: str, params: Dict[str, Any]) -> Any:
        body = json.dumps({"action": action, "params": params, "context": {}}).encode()
        req = urllib.request.Request(
            f"{self.api_url}/agent/actions/execute",
            data=body,
            method="POST",
            headers={"Content-Type": "application/json", "x-api-key": self.api_key},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:  # noqa: S310 - DotMock API URL
                raw = resp.read().decode()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:300]
            raise DotmockError(f"DotMock {action} failed (HTTP {exc.code}): {detail}") from exc
        return _unwrap(json.loads(raw) if raw else None)

    def connect(self) -> "Dotmock":
        """Resolve the API id and hosted base URL (idempotent)."""
        if self.api_id and self.base_url:
            return self
        api_id = self.api
        if not _UUID.match(api_id):
            wanted = api_id.lower()
            apis = _as_list(self._action("dotmock_list_apis", {}), "apis")
            hit = next((a for a in apis if a.get("id") == api_id), None) or next(
                (a for a in apis if str(a.get("subdomain") or a.get("slug") or "").lower() == wanted), None
            ) or next((a for a in apis if str(a.get("name") or "").lower() == wanted), None)
            if hit and hit.get("id"):
                api_id = str(hit["id"])
        record = self._action("dotmock_get_api", {"apiId": api_id}) or {}
        self.api_id = api_id
        self.base_url = _base_url(record)
        return self

    def with_session(self, session: str) -> "Dotmock":
        """Another handle on the same API using a different X-Dotmock-Session."""
        clone = Dotmock.__new__(Dotmock)
        clone.__dict__.update(self.__dict__)
        clone.session = session
        clone._baseline = set()
        return clone

    # ---- URLs ----

    def _require(self) -> str:
        if not self.base_url:
            self.connect()
        return self.base_url  # type: ignore[return-value]

    def openai_base_url(self) -> str:
        return f"{self._require()}/v1"

    def anthropic_base_url(self) -> str:
        return self._require()

    @property
    def headers(self) -> Dict[str, str]:
        """Send these with every request so the test's counters and journal stay isolated."""
        return {SESSION_HEADER: self.session}

    def env(self) -> Dict[str, str]:
        base = self._require()
        return {
            "DOTMOCK_URL": base,
            "DOTMOCK_API": str(self.api_id),
            "DOTMOCK_SESSION": self.session,
            "OPENAI_BASE_URL": f"{base}/v1",
            "ANTHROPIC_BASE_URL": base,
            "GOOGLE_GEMINI_BASE_URL": base,
        }

    # ---- runtime ----

    def reset(self) -> None:
        """Reset this session's sequence counters; earlier journal entries are hidden afterwards."""
        self.connect()
        result = self._action("dotmock_reset_llm_sequences", {"apiId": self.api_id, "session": self.session}) or {}
        if isinstance(result, dict) and result.get("reset") is False:
            raise DotmockError(f"DotMock did not reset sequences: {result.get('warnings') or result}")
        self._baseline = {_entry_key(e) for e in self._fetch_journal()}

    def _fetch_journal(self) -> List[Dict[str, Any]]:
        payload = self._action("dotmock_get_llm_journal", {"apiId": self.api_id, "session": self.session, "limit": 1000})
        return [e for e in _as_list(payload, "entries") if (e.get("session") or "default") == self.session]

    def journal(self, fixture: Optional[str] = None, all: bool = False) -> List[Dict[str, Any]]:  # noqa: A002
        """This session's journal since the last reset (``all=True`` for everything), oldest first."""
        self.connect()
        entries = [e for e in self._fetch_journal() if all or _entry_key(e) not in self._baseline]
        if fixture:
            entries = [e for e in entries if fixture in _names(e)]
        return sorted(entries, key=lambda e: float(e.get("timestamp") or 0) if isinstance(e.get("timestamp"), (int, float)) else 0)

    def assert_fixture_matched(self, name: str, times: Optional[int] = None, timeout: float = 5.0) -> List[Dict[str, Any]]:
        """Assert a fixture (name or id) answered >= 1 request, or exactly ``times``. Polls briefly for async journal writes."""
        deadline = time.monotonic() + timeout
        while True:
            entries = self.journal()
            hits = [e for e in entries if name in _names(e)]
            enough = len(hits) > 0 if times is None else len(hits) >= times
            if enough or time.monotonic() >= deadline:
                break
            time.sleep(0.25)
        ok = len(hits) > 0 if times is None else len(hits) == times
        if not ok:
            seen = "\n  ".join(f"{e.get('path', '?')} -> {_fixture_of(e) or '(no match)'}" for e in entries)
            expected = "at least once" if times is None else f"{times} time(s)"
            raise AssertionError(
                f'Expected fixture "{name}" to match {expected}, but it matched {len(hits)} time(s).'
                + (f"\nJournal:\n  {seen}" if seen else "\nJournal is empty.")
            )
        return hits


def _names(entry: Dict[str, Any]) -> List[str]:
    response = entry.get("response") or {}
    return [str(v) for v in (response.get("fixtureName"), response.get("fixtureId"), entry.get("fixtureName"), entry.get("fixtureId")) if v]
