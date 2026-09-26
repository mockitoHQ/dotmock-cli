import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

pytest_plugins = ["pytester"]

API_ID = "0b6c1c9e-5d4f-4f0e-9c1a-2b3c4d5e6f70"


class FakeBackend:
    """Stand-in for the DotMock API-key action endpoint (POST /agent/actions/execute)."""

    def __init__(self):
        self.journal = []
        self.calls = []

    def record(self, session, fixture, path="/v1/chat/completions"):
        """What the hosted mock does after answering a request."""
        self.journal.append({
            "id": str(len(self.journal) + 1), "timestamp": len(self.journal) + 1, "path": path,
            "session": session, "response": {"status": 200, "fixtureName": fixture},
        })


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

        def do_POST(self):
            if self.path != "/agent/actions/execute" or self.headers.get("x-api-key") != "mck_test":
                return self._send(401, {"message": "bad key"})
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            action, params = body["action"], body["params"]
            state.calls.append((action, params))
            ok = lambda data: self._send(200, {"success": True, "data": data})  # noqa: E731
            if action == "dotmock_list_apis":
                return ok([{"id": API_ID, "name": "Assistant", "subdomain": "assistant"}])
            if action == "dotmock_get_api":
                return ok({"id": params["apiId"], "subdomain": "assistant", "fullUrl": "https://assistant-t1a2b3c4.mock.rest"})
            if action == "dotmock_reset_llm_sequences":
                return ok({"reset": True, "apiId": params["apiId"], "session": params.get("session")})
            if action == "dotmock_get_llm_journal":
                entries = [e for e in reversed(state.journal) if not params.get("session") or e["session"] == params["session"]]
                return ok(entries)
            self._send(400, {"message": f"unexpected action {action}"})

    return Handler


@pytest.fixture
def fake_backend():
    state = FakeBackend()
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(state))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    state.url = f"http://127.0.0.1:{server.server_address[1]}"
    yield state
    server.shutdown()
