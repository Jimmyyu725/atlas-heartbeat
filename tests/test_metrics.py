from collections import namedtuple
from concurrent.futures import ThreadPoolExecutor
import threading
import time
import unittest

from atlas_heartbeat.metrics import (
    MetricSampler,
    cpu_percent,
    parse_cpu_line,
    parse_meminfo,
    read_backup_status,
)


DiskUsage = namedtuple("DiskUsage", "total used free")


class MetricParsingTests(unittest.TestCase):
    def test_parse_cpu_line_sums_active_and_idle_fields(self):
        line = "cpu  10 2 3 40 5 1 2 1 0 0\n"

        self.assertEqual(parse_cpu_line(line), (64, 45))

    def test_cpu_percent_uses_change_between_samples(self):
        self.assertEqual(cpu_percent((100, 40), (200, 70)), 70.0)

    def test_cpu_percent_handles_zero_or_reversed_delta(self):
        self.assertEqual(cpu_percent((100, 40), (100, 40)), 0.0)
        self.assertEqual(cpu_percent((100, 40), (90, 30)), 0.0)

    def test_parse_meminfo_uses_available_memory(self):
        text = "MemTotal:       1000 kB\nMemAvailable:    250 kB\n"

        self.assertEqual(
            parse_meminfo(text),
            {"total_bytes": 1_024_000, "available_bytes": 256_000, "used_percent": 75.0},
        )


class MetricSamplerTests(unittest.TestCase):
    def setUp(self):
        self.cpu_lines = iter(
            [
                "cpu  10 0 10 80 0 0 0 0 0 0\n",
                "cpu  30 0 20 100 0 0 0 0 0 0\n",
            ]
        )

    def read_text(self, path):
        if path == "/proc/stat":
            return next(self.cpu_lines)
        if path == "/proc/meminfo":
            return "MemTotal: 2000 kB\nMemAvailable: 500 kB\n"
        if path == "/proc/uptime":
            return "90061.5 100.0\n"
        raise FileNotFoundError(path)

    def make_sampler(self):
        return MetricSampler(
            read_text=self.read_text,
            disk_usage=lambda _: DiskUsage(total=1000, used=420, free=580),
            loadavg=lambda: (0.25, 0.5, 0.75),
            hostname=lambda: "atlas-test",
            cpu_count=lambda: 4,
            backup_status=lambda: {"state": "waiting", "next_run": "2026-09-01T06:10:00Z"},
            clock=lambda: "2026-08-31T12:00:00Z",
        )

    def test_snapshot_exposes_normalized_read_only_metrics(self):
        sampler = self.make_sampler()

        first = sampler.snapshot()
        second = sampler.snapshot()

        self.assertEqual(first["cpu_percent"], 20.0)
        self.assertEqual(second["cpu_percent"], 60.0)
        self.assertEqual(second["memory_percent"], 75.0)
        self.assertEqual(second["memory_total_bytes"], 2_048_000)
        self.assertEqual(second["disk_percent"], 42.0)
        self.assertEqual(second["load"], [0.25, 0.5, 0.75])
        self.assertEqual(second["load_per_cpu"], 0.0625)
        self.assertEqual(second["uptime_seconds"], 90061)
        self.assertEqual(second["hostname"], "atlas-test")
        self.assertEqual(second["backup"]["state"], "waiting")
        self.assertEqual(second["sampled_at"], "2026-08-31T12:00:00Z")
        self.assertEqual(second["status"], "nominal")
        self.assertEqual(second["issues"], [])

    def test_snapshot_isolates_reader_failures(self):
        def fail(*_args):
            raise OSError("sensor unavailable")

        sampler = MetricSampler(
            read_text=fail,
            disk_usage=fail,
            loadavg=fail,
            hostname=lambda: "atlas-test",
            cpu_count=lambda: 0,
            backup_status=fail,
            clock=lambda: "2026-08-31T12:00:00Z",
        )

        snapshot = sampler.snapshot()

        self.assertEqual(snapshot["hostname"], "atlas-test")
        self.assertEqual(snapshot["status"], "degraded")
        self.assertIsNone(snapshot["cpu_percent"])
        self.assertIsNone(snapshot["memory_percent"])
        self.assertIsNone(snapshot["disk_percent"])
        self.assertIsNone(snapshot["uptime_seconds"])
        self.assertIsNone(snapshot["backup"])
        self.assertGreaterEqual(len(snapshot["issues"]), 5)

    def test_snapshot_isolates_cpu_count_failure(self):
        sampler = self.make_sampler()
        sampler._cpu_count = lambda: (_ for _ in ()).throw(OSError("cpu count unavailable"))

        snapshot = sampler.snapshot()

        self.assertEqual(snapshot["load"], [0.25, 0.5, 0.75])
        self.assertIsNone(snapshot["load_per_cpu"])
        self.assertEqual(snapshot["status"], "degraded")
        self.assertIn("cpu_count: unavailable", snapshot["issues"])

    def test_concurrent_snapshots_serialize_cpu_sample_updates(self):
        state_lock = threading.Lock()
        active_readers = 0
        maximum_readers = 0
        cpu_sample = 0

        def read_text(path):
            nonlocal active_readers, maximum_readers, cpu_sample
            if path == "/proc/stat":
                with state_lock:
                    active_readers += 1
                    maximum_readers = max(maximum_readers, active_readers)
                    cpu_sample += 1
                    sample = cpu_sample
                time.sleep(0.03)
                with state_lock:
                    active_readers -= 1
                return f"cpu {10 + sample * 10} 0 10 {80 + sample * 2} 0 0 0 0 0 0\n"
            if path == "/proc/meminfo":
                return "MemTotal: 1000 kB\nMemAvailable: 500 kB\n"
            if path == "/proc/uptime":
                return "100 0\n"
            raise FileNotFoundError(path)

        sampler = MetricSampler(
            read_text=read_text,
            disk_usage=lambda _: DiskUsage(total=100, used=10, free=90),
            loadavg=lambda: (0.1, 0.1, 0.1),
            hostname=lambda: "atlas-test",
            cpu_count=lambda: 4,
            backup_status=lambda: {"state": "active"},
            clock=lambda: "2026-08-31T12:00:00Z",
        )
        sampler.snapshot()

        with ThreadPoolExecutor(max_workers=2) as executor:
            snapshots = list(executor.map(lambda _: sampler.snapshot(), range(2)))

        self.assertEqual(len(snapshots), 2)
        self.assertEqual(maximum_readers, 1)

    def test_backup_reader_treats_systemctl_failure_as_sensor_failure(self):
        result = namedtuple("Result", "returncode stdout")(1, "")

        with self.assertRaises(OSError):
            read_backup_status(run=lambda *_args, **_kwargs: result)


if __name__ == "__main__":
    unittest.main()
