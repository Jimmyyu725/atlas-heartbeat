import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from atlas_heartbeat.metrics import MetricSampler
from atlas_heartbeat.server import build_server, safe_static_path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
WEB_ROOT = PROJECT_ROOT / "web"


class FakeSampler:
    def snapshot(self):
        return {
            "hostname": "atlas-test",
            "cpu_percent": 12.5,
            "status": "nominal",
            "issues": [],
        }


class StaticPathTests(unittest.TestCase):
    def test_root_resolves_to_index(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()

            self.assertEqual(safe_static_path(root, "/"), root / "index.html")

    def test_path_escape_is_rejected_after_url_decoding(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()

            self.assertIsNone(safe_static_path(root, "/../secret"))
            self.assertIsNone(safe_static_path(root, "/%2e%2e/secret"))


class BrowserContractTests(unittest.TestCase):
    def test_index_contains_accessible_landmarks_and_controls(self):
        html = (WEB_ROOT / "index.html").read_text(encoding="utf-8")

        self.assertIn('id="planet"', html)
        self.assertIn('id="pulse-button"', html)
        self.assertIn('id="quiet-toggle"', html)
        self.assertIn('aria-live="polite"', html)
        self.assertIn('rel="icon"', html)
        self.assertIn('href="/style.css"', html)
        self.assertIn('src="/app.js"', html)

    def test_styles_include_mobile_and_reduced_motion_modes(self):
        css = (WEB_ROOT / "style.css").read_text(encoding="utf-8")

        self.assertIn("@media (max-width: 760px)", css)
        self.assertIn("prefers-reduced-motion: reduce", css)


class HeartbeatServerTests(unittest.TestCase):
    def setUp(self):
        self.temp_directory = tempfile.TemporaryDirectory()
        self.web_root = Path(self.temp_directory.name)
        (self.web_root / "index.html").write_text(
            "<!doctype html><title>Test Heartbeat</title>", encoding="utf-8"
        )
        self.server = build_server(
            host="127.0.0.1", port=0, web_root=self.web_root, sampler=FakeSampler()
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.server.server_address
        self.base_url = f"http://{host}:{port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp_directory.cleanup()

    def test_api_returns_json_snapshot_without_caching(self):
        with urlopen(self.base_url + "/api/pulse", timeout=2) as response:
            payload = json.load(response)

            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers.get_content_type(), "application/json")
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertEqual(payload["hostname"], "atlas-test")
            self.assertEqual(payload["cpu_percent"], 12.5)

    def test_root_serves_index_and_head_has_no_body(self):
        with urlopen(self.base_url + "/", timeout=2) as response:
            self.assertIn(b"Test Heartbeat", response.read())
            self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")

        request = Request(self.base_url + "/", method="HEAD")
        with urlopen(request, timeout=2) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), b"")

    def test_missing_static_file_returns_404(self):
        with self.assertRaises(HTTPError) as caught:
            urlopen(self.base_url + "/missing.js", timeout=2)

        self.assertEqual(caught.exception.code, 404)

    def test_write_methods_are_rejected(self):
        request = Request(self.base_url + "/api/pulse", data=b"{}", method="POST")

        with self.assertRaises(HTTPError) as caught:
            urlopen(request, timeout=2)

        self.assertEqual(caught.exception.code, 405)

    def test_api_stays_available_when_cpu_count_sensor_fails(self):
        readings = {
            "/proc/stat": "cpu 10 0 10 80 0 0 0 0 0 0\n",
            "/proc/meminfo": "MemTotal: 1000 kB\nMemAvailable: 500 kB\n",
            "/proc/uptime": "100 0\n",
        }
        sampler = MetricSampler(
            read_text=readings.__getitem__,
            disk_usage=lambda _: SimpleNamespace(total=100, used=10, free=90),
            loadavg=lambda: (0.25, 0.2, 0.1),
            hostname=lambda: "atlas-test",
            cpu_count=lambda: (_ for _ in ()).throw(OSError("sensor unavailable")),
            backup_status=lambda: {"state": "active"},
            clock=lambda: "2026-08-31T12:00:00Z",
        )
        degraded_server = build_server(
            host="127.0.0.1", port=0, web_root=self.web_root, sampler=sampler
        )
        degraded_thread = threading.Thread(target=degraded_server.serve_forever, daemon=True)
        degraded_thread.start()
        host, port = degraded_server.server_address
        try:
            with urlopen(f"http://{host}:{port}/api/pulse", timeout=2) as response:
                payload = json.load(response)
        finally:
            degraded_server.shutdown()
            degraded_server.server_close()
            degraded_thread.join(timeout=2)

        self.assertEqual(payload["status"], "degraded")
        self.assertIsNone(payload["load_per_cpu"])
        self.assertIn("cpu_count: unavailable", payload["issues"])


if __name__ == "__main__":
    unittest.main()
