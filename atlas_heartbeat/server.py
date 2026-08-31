"""Small read-only HTTP server for Atlas Heartbeat."""

from __future__ import annotations

import argparse
import json
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from .metrics import MetricSampler


DEFAULT_WEB_ROOT = Path(__file__).resolve().parent.parent / "web"


def safe_static_path(root: Path, request_path: str) -> Path | None:
    """Resolve a URL path inside the static root, rejecting traversal."""
    root = root.resolve()
    decoded = unquote(urlsplit(request_path).path)
    relative = decoded.lstrip("/") or "index.html"
    try:
        candidate = (root / relative).resolve()
    except (OSError, ValueError):
        return None
    if candidate != root and root not in candidate.parents:
        return None
    return candidate


def make_handler(web_root: Path, sampler: MetricSampler) -> type[BaseHTTPRequestHandler]:
    """Bind immutable server dependencies to a request handler class."""

    class HeartbeatHandler(BaseHTTPRequestHandler):
        server_version = "AtlasHeartbeat/1"

        def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
            self._route(include_body=True)

        def do_HEAD(self) -> None:  # noqa: N802 - stdlib handler API
            self._route(include_body=False)

        def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
            self._method_not_allowed()

        do_PUT = do_POST
        do_PATCH = do_POST
        do_DELETE = do_POST

        def _route(self, *, include_body: bool) -> None:
            path = urlsplit(self.path).path
            if path == "/api/pulse":
                payload = json.dumps(
                    sampler.snapshot(), ensure_ascii=False, separators=(",", ":")
                ).encode("utf-8")
                self._send_bytes(
                    200,
                    payload,
                    "application/json; charset=utf-8",
                    "no-store",
                    include_body,
                )
                return
            if path.startswith("/api/"):
                self.send_error(404, "Unknown API endpoint")
                return
            target = safe_static_path(web_root, self.path)
            if target is None or not target.is_file():
                self.send_error(404, "Static asset not found")
                return
            try:
                payload = target.read_bytes()
            except OSError:
                self.send_error(404, "Static asset not found")
                return
            content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
            cache_control = "no-cache" if target.suffix == ".html" else "public, max-age=300"
            self._send_bytes(200, payload, content_type, cache_control, include_body)

        def _send_bytes(
            self,
            status: int,
            payload: bytes,
            content_type: str,
            cache_control: str,
            include_body: bool,
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", cache_control)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; style-src 'self'; script-src 'self'; "
                "img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
            )
            self.end_headers()
            if include_body:
                self.wfile.write(payload)

        def _method_not_allowed(self) -> None:
            self.send_response(405)
            self.send_header("Allow", "GET, HEAD")
            self.send_header("Content-Length", "0")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()

        def log_message(self, _format: str, *_args: object) -> None:
            return

    return HeartbeatHandler


def build_server(
    *,
    host: str,
    port: int,
    web_root: Path = DEFAULT_WEB_ROOT,
    sampler: MetricSampler | None = None,
) -> ThreadingHTTPServer:
    """Construct a server without starting its blocking loop."""
    active_sampler = sampler or MetricSampler()
    return ThreadingHTTPServer((host, port), make_handler(web_root.resolve(), active_sampler))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the Atlas Heartbeat dashboard")
    parser.add_argument("--host", default="127.0.0.1", help="listen address (default: loopback)")
    parser.add_argument("--port", type=int, default=8765, help="listen port (default: 8765)")
    arguments = parser.parse_args(argv)
    server = build_server(host=arguments.host, port=arguments.port)
    visible_host = "127.0.0.1" if arguments.host in {"0.0.0.0", "::"} else arguments.host
    print(f"Atlas Heartbeat is listening at http://{visible_host}:{server.server_port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
