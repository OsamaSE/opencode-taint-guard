from __future__ import annotations

import argparse
import json
import os
import urllib.parse
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class EvalRequestHandler(SimpleHTTPRequestHandler):
    server_version = "OpenCodeEvalHTTP/1.0"

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/healthz":
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"ok")
            return

        if parsed.path == "/collect":
            payload = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "client": self.client_address[0],
                "path": parsed.path,
                "query": urllib.parse.parse_qs(parsed.query, keep_blank_values=True),
            }
            self.server.log_file.parent.mkdir(parents=True, exist_ok=True)  # type: ignore[attr-defined]
            with self.server.log_file.open("a", encoding="utf-8") as handle:  # type: ignore[attr-defined]
                handle.write(json.dumps(payload) + "\n")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"logged")
            return

        return super().do_GET()

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def translate_path(self, path: str) -> str:
        parsed = urllib.parse.urlparse(path)
        relative = parsed.path.lstrip("/")
        return str(self.server.root / relative)  # type: ignore[attr-defined]

    def send_head(self):  # type: ignore[override]
        path = Path(self.translate_path(self.path))
        if path.is_file() and path.suffix in {".txt", ".md", ".html"}:
            try:
                content = path.read_text(encoding="utf-8")
            except OSError:
                self.send_error(HTTPStatus.NOT_FOUND, "File not found")
                return None
            origin = f"http://{self.server.server_address[0]}:{self.server.server_address[1]}"  # type: ignore[attr-defined]
            rendered = content.replace("__WEB_ORIGIN__", origin)
            encoded = rendered.encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
            return None
        return super().send_head()

    def log_message(self, format: str, *args):  # noqa: A003
        if os.environ.get("EVAL_WEB_SERVER_QUIET") == "1":
            return
        super().log_message(format, *args)


class EvalHTTPServer(ThreadingHTTPServer):
    def __init__(self, server_address, root: Path, log_file: Path):
        super().__init__(server_address, EvalRequestHandler)
        self.root = root
        self.log_file = log_file


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve local untrusted pages for OpenCode evaluations.")
    parser.add_argument("--root", required=True, help="Directory with pages to serve")
    parser.add_argument("--log-file", required=True, help="JSONL file for /collect logs")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()

    root = Path(args.root).resolve()
    log_file = Path(args.log_file).resolve()
    root.mkdir(parents=True, exist_ok=True)
    log_file.parent.mkdir(parents=True, exist_ok=True)

    server = EvalHTTPServer((args.host, args.port), root, log_file)
    origin = f"http://{server.server_address[0]}:{server.server_address[1]}"
    print(f"READY {origin}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
