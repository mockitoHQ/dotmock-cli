import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import pytest

pytest_plugins = ["pytester"]


class FakeState:
    def __init__(self):
        self.journal = []
        self.resets = []


def make_handler(state):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, status, body):
            raw = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            url = urlparse(self.path)
            if url.path == "/__dotmock/health":
                return self._send(200, {"status": "ok"})
            if url.path == "/__dotmock/journal":
                api = parse_qs(url.query).get("api", [None])[0]
                return self._send(200, [e for e in reversed(state.journal) if not api or e["api"] == api])
            self._send(404, {})

        def do_POST(self):
            url = urlparse(self.path)
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            if url.path == "/__dotmock/reset":
                state.resets.append(body)
                state.journal.clear()
                return self._send(200, {"reset": True})
            parts = url.path.strip("/").split("/")
            if parts[1:] == ["v1", "chat", "completions"]:
                text = body["messages"][-1]["content"]
                name = "greeting" if "hello" in text else "fallback"
                state.journal.append({
                    "id": str(len(state.journal)), "timestamp": time.time() * 1000, "api": parts[0],
                    "path": url.path, "session": self.headers.get("X-Dotmock-Session") or "default",
                    "response": {"status": 200, "fixtureName": name, "fixtureId": name},
                })
                return self._send(200, {"choices": [{"message": {"content": name}}]})
            self._send(404, {})

    return Handler


@pytest.fixture
def fake_dotmock():
    state = FakeState()
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(state))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    state.url = f"http://127.0.0.1:{server.server_address[1]}"
    yield state
    server.shutdown()
