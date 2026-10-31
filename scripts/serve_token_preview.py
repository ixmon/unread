#!/usr/bin/env python3
"""Preview server: static dist + local Lambda handler for /api/* (token shadow mode).

Does not call production. Loads TOKEN_HMAC_SECRET from ~/.config/unread-atlas/token-hmac-secret
(never printed). Usage:
  python3 .preview/serve_token.py 8850
"""
from __future__ import annotations
import http.server, json, os, sys, urllib.parse
from pathlib import Path

ROOT = Path(os.environ.get("ROOT") or Path(__file__).resolve().parent.parent / "dist-ui-tweaks")
LAMBDA_DIR = Path(os.environ.get("LAMBDA_DIR") or Path.home() / "cursor/aws-cunei-search/lambda")
DB = os.environ.get("LOCAL_DB") or str(Path.home() / "cursor/aws-cunei-search/out/unread-atlas-search.sqlite")
SECRET_FILE = Path(os.environ.get("TOKEN_SECRET_FILE") or Path.home() / ".config/unread-atlas/token-hmac-secret")

os.environ.setdefault("LOCAL_DB", DB)
os.environ.setdefault("TOKEN_MODE", "shadow")
os.environ.setdefault("TOKEN_TTL_SEC", "900")
if "TOKEN_HMAC_SECRET" not in os.environ:
    if not SECRET_FILE.is_file():
        sys.stderr.write(f"missing secret file: {SECRET_FILE}\n")
        sys.exit(1)
    os.environ["TOKEN_HMAC_SECRET"] = SECRET_FILE.read_text().strip()
    # Do not print the secret.

sys.path.insert(0, str(LAMBDA_DIR))
import app as lambda_app  # noqa: E402


def to_event(handler: http.server.BaseHTTPRequestHandler, method: str, body: bytes):
    parsed = urllib.parse.urlparse(handler.path)
    qs = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
    headers = {k.lower(): v for k, v in handler.headers.items()}
    # Synthesize a Function-URL-like event. Use the TCP peer as sourceIp.
    peer = handler.client_address[0] if handler.client_address else "127.0.0.1"
    return {
        "rawPath": parsed.path[4:] if parsed.path.startswith("/api") else parsed.path,
        "queryStringParameters": qs or None,
        "headers": headers,
        "body": body.decode("utf-8", "replace") if body else "",
        "isBase64Encoded": False,
        "requestContext": {"http": {"method": method, "sourceIp": peer, "path": parsed.path}},
    }


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(ROOT), **k)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _proxy_api(self, method: str):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        # Only /api/* goes to Lambda; strip prefix inside handler too.
        if not self.path.startswith("/api"):
            self.send_error(404)
            return
        ev = to_event(self, method, body)
        # Force path seen by Lambda to be without /api (to_event already strips when startswith /api)
        # Fix: rawPath should be /token not /api/token — to_event strips "/api" prefix of length 4,
        # which turns "/api/token" into "/token" — good. "/api/text/P1" -> "/text/P1" — good.
        if ev["rawPath"] == "":
            ev["rawPath"] = "/"
        try:
            resp = lambda_app.handler(ev, None)
        except Exception as e:
            resp = {"statusCode": 500, "headers": {"Content-Type": "application/json"},
                    "body": json.dumps({"error": "local handler failed", "detail": str(e)[:200]})}
        code = int(resp.get("statusCode") or 500)
        headers = dict(resp.get("headers") or {})
        payload = (resp.get("body") or "").encode("utf-8")
        self.send_response(code)
        for k, v in headers.items():
            if k.lower() == "content-length":
                continue
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if method != "HEAD":
            self.wfile.write(payload)

    def do_GET(self):
        if self.path.startswith("/api/") or self.path.split("?", 1)[0] == "/api":
            return self._proxy_api("GET")
        return super().do_GET()

    def do_HEAD(self):
        if self.path.startswith("/api/") or self.path.split("?", 1)[0] == "/api":
            return self._proxy_api("HEAD")
        return super().do_HEAD()

    def do_POST(self):
        if self.path.startswith("/api/") or self.path.split("?", 1)[0] == "/api":
            return self._proxy_api("POST")
        self.send_error(405)

    def do_OPTIONS(self):
        if self.path.startswith("/api/") or self.path.split("?", 1)[0] == "/api":
            return self._proxy_api("OPTIONS")
        self.send_error(405)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8850
    if not Path(DB).is_file():
        sys.stderr.write(f"LOCAL_DB missing: {DB}\n")
        sys.exit(1)
    http.server.ThreadingHTTPServer(("0.0.0.0", port), H).serve_forever()


if __name__ == "__main__":
    main()
