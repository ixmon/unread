#!/usr/bin/env python3
"""
Local ATF → English translate API for the reader UI.

Uses the T5 model from ../atf-translate-test (same recipe as infer.py).
Stdlib HTTP only — run via scripts/serve_api.sh (that project's venv).

  ./scripts/serve_api.sh          # 0.0.0.0:42226
  BIND=0.0.0.0 PORT=42226 ./scripts/serve_api.sh

Endpoints:
  GET  /api/health
  POST /api/translate       { "atf": "..." } or { "lines": ["...", ...] }
  POST /api/translate/save  { "id": "P285108", "english": [...], "english_note"?: str }
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = Path(
    os.environ.get(
        "ATF_MODEL",
        str(ROOT.parent / "atf-translate-test" / "models" / "atf-en-best-v2"),
    )
)
TEXTS_DIR = ROOT / "data" / "texts"
PROMPT = os.environ.get("ATF_PROMPT", "translate Akkadian to English: ")
MAX_LINES_PER_REQUEST = int(os.environ.get("ATF_MAX_LINES", "64"))
MAX_NEW_TOKENS = int(os.environ.get("ATF_MAX_NEW_TOKENS", "80"))
NUM_BEAMS = int(os.environ.get("ATF_NUM_BEAMS", "4"))

_model = None
_tokenizer = None
_device = None
_model_path: str | None = None
_inf_lock = threading.Lock()


def clean_atf(atf: str) -> str:
    s = (atf or "").strip()
    s = re.sub(r"[#?!*]+", "", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def load_model(model_path: Path) -> None:
    global _model, _tokenizer, _device, _model_path
    if _model is not None and _model_path == str(model_path):
        return

    import torch
    from transformers import T5ForConditionalGeneration, T5Tokenizer

    print(f"Loading model from {model_path} …", flush=True)
    if not model_path.exists():
        raise FileNotFoundError(f"Model not found: {model_path}")

    _model = T5ForConditionalGeneration.from_pretrained(str(model_path))
    try:
        _tokenizer = T5Tokenizer.from_pretrained(str(model_path))
    except Exception:
        _tokenizer = T5Tokenizer.from_pretrained("t5-small")

    _device = "cuda" if torch.cuda.is_available() else "cpu"
    _model = _model.to(_device)
    _model.eval()
    _model_path = str(model_path)
    print(f"Model ready on {_device}", flush=True)


def translate_one(atf: str) -> str:
    import torch

    cleaned = clean_atf(atf)
    if not cleaned or cleaned in (".", "x", "…", "...", "·"):
        return "…"

    text = PROMPT + cleaned
    inputs = _tokenizer(
        text, return_tensors="pt", max_length=256, truncation=True
    ).to(_device)
    with torch.no_grad():
        outputs = _model.generate(
            **inputs,
            max_new_tokens=MAX_NEW_TOKENS,
            num_beams=NUM_BEAMS,
            early_stopping=True,
        )
    return _tokenizer.decode(outputs[0], skip_special_tokens=True).strip()


def translate_lines(lines: list[str]) -> list[str]:
    with _inf_lock:
        return [translate_one(line) for line in lines]


class Handler(BaseHTTPRequestHandler):
    server_version = "AtfTranslateAPI/1.0"
    model_path: Path = DEFAULT_MODEL
    lazy: bool = False

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _cors(self) -> None:
        origin = self.headers.get("Origin") or "*"
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Vary", "Origin")

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path in ("/api/health", "/health", "/"):
            self._json(
                200,
                {
                    "ok": True,
                    "model_loaded": _model is not None,
                    "model_path": _model_path or str(self.model_path),
                    "device": _device,
                    "prompt": PROMPT,
                    "max_lines_per_request": MAX_LINES_PER_REQUEST,
                },
            )
            return
        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path.rstrip("/") or "/"
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._json(400, {"ok": False, "error": "invalid JSON"})
            return

        try:
            if path in ("/api/translate", "/translate"):
                self._handle_translate(data)
            elif path in ("/api/translate/save", "/translate/save"):
                self._handle_save(data)
            else:
                self._json(404, {"ok": False, "error": "not found"})
        except Exception as e:
            traceback.print_exc()
            self._json(500, {"ok": False, "error": str(e)})

    def _ensure_model(self) -> None:
        if _model is None:
            load_model(self.model_path)

    def _handle_translate(self, data: dict) -> None:
        self._ensure_model()

        if "lines" in data and data["lines"] is not None:
            lines = data["lines"]
            if not isinstance(lines, list):
                self._json(400, {"ok": False, "error": "lines must be an array"})
                return
            lines = [str(x) for x in lines]
        elif "atf" in data:
            lines = [str(data["atf"])]
        else:
            self._json(400, {"ok": False, "error": "provide atf or lines"})
            return

        if len(lines) > MAX_LINES_PER_REQUEST:
            self._json(
                400,
                {
                    "ok": False,
                    "error": f"max {MAX_LINES_PER_REQUEST} lines per request (got {len(lines)})",
                    "max_lines_per_request": MAX_LINES_PER_REQUEST,
                },
            )
            return

        translations = translate_lines(lines)
        self._json(
            200,
            {
                "ok": True,
                "translations": translations,
                "count": len(translations),
                "model": _model_path,
                "device": _device,
                "prompt": PROMPT,
            },
        )

    def _handle_save(self, data: dict) -> None:
        pid = (data.get("id") or "").strip()
        if not re.match(r"^P\d{6}$", pid):
            self._json(400, {"ok": False, "error": "id must be P######"})
            return
        english = data.get("english")
        if not isinstance(english, list):
            self._json(400, {"ok": False, "error": "english must be an array"})
            return

        path = TEXTS_DIR / f"{pid}.json"
        if not path.exists():
            self._json(404, {"ok": False, "error": f"no package for {pid}"})
            return

        pkg = json.loads(path.read_text(encoding="utf-8"))
        pkg["english"] = [str(x) for x in english]
        content = [ln for ln in pkg.get("lines") or [] if ln.get("type") == "line"]
        for i, eng in enumerate(pkg["english"]):
            if i < len(content):
                content[i]["english"] = eng

        meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
        pkg["status"] = data.get("status") or (
            "english" if len(pkg["english"]) >= len(content) else "partial_english"
        )
        pkg["english_note"] = data.get("english_note") or (
            f"Model draft via local API ({meta.get('model') or _model_path or 'unknown'})."
        )
        pkg["translation_meta"] = {
            **(pkg.get("translation_meta") or {}),
            **meta,
            "lines_translated": len(pkg["english"]),
            "lines_total": len(content),
            "source": "local_api",
        }
        path.write_text(json.dumps(pkg, ensure_ascii=False, indent=2), encoding="utf-8")
        self._json(
            200,
            {"ok": True, "id": pid, "path": str(path), "count": len(pkg["english"])},
        )


def main() -> None:
    ap = argparse.ArgumentParser(description="ATF → English local API")
    ap.add_argument("--host", default=os.environ.get("BIND", "0.0.0.0"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", "42226")))
    ap.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    ap.add_argument(
        "--lazy",
        action="store_true",
        help="Load model on first translate request instead of at startup",
    )
    args = ap.parse_args()

    Handler.model_path = args.model
    Handler.lazy = args.lazy

    if not args.lazy:
        load_model(args.model)
    else:
        global _model_path
        _model_path = str(args.model)
        print(f"Lazy mode — will load {args.model} on first request", flush=True)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"ATF translate API on http://{args.host}:{args.port}/", flush=True)
    print("  GET  /api/health", flush=True)
    print("  POST /api/translate", flush=True)
    print("  POST /api/translate/save", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.", flush=True)
        httpd.shutdown()


if __name__ == "__main__":
    main()
