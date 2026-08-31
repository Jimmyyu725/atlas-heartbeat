"""Read-only Linux metric collection with graceful per-sensor fallbacks."""

from __future__ import annotations

from datetime import datetime, timezone
import os
from pathlib import Path
import shutil
import socket
import subprocess
import threading
from typing import Callable, NamedTuple


class CpuTimes(NamedTuple):
    total: int
    idle: int


def parse_cpu_line(line: str) -> CpuTimes:
    """Return cumulative total and idle ticks from the aggregate /proc/stat row."""
    fields = line.split()
    if not fields or fields[0] != "cpu" or len(fields) < 5:
        raise ValueError("invalid aggregate CPU line")
    values = [int(value) for value in fields[1:9]]
    return CpuTimes(sum(values), values[3] + (values[4] if len(values) > 4 else 0))


def cpu_percent(previous: tuple[int, int], current: tuple[int, int]) -> float:
    """Calculate busy CPU percentage between two cumulative samples."""
    total_delta = current[0] - previous[0]
    idle_delta = current[1] - previous[1]
    if total_delta <= 0:
        return 0.0
    busy = (total_delta - max(0, idle_delta)) * 100 / total_delta
    return round(max(0.0, min(100.0, busy)), 1)


def parse_meminfo(text: str) -> dict[str, float | int]:
    """Parse the total and available Linux memory values."""
    values: dict[str, int] = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        key, raw = line.split(":", 1)
        parts = raw.split()
        if parts:
            values[key] = int(parts[0]) * 1024
    total = values.get("MemTotal", 0)
    available = values.get("MemAvailable", values.get("MemFree", 0))
    if total <= 0:
        raise ValueError("MemTotal is unavailable")
    used = (total - min(total, available)) * 100 / total
    return {
        "total_bytes": total,
        "available_bytes": available,
        "used_percent": round(max(0.0, min(100.0, used)), 1),
    }


def _read_text(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def _clock() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def read_backup_status(
    run: Callable[..., object] = subprocess.run,
) -> dict[str, str | None]:
    """Read the configured restic timer state without changing systemd state."""
    result = run(
        [
            "systemctl",
            "show",
            "atlas-restic-backup.timer",
            "--property=ActiveState",
            "--property=NextElapseUSecRealtime",
            "--property=LastTriggerUSec",
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=1.5,
    )
    if result.returncode != 0:
        raise OSError("systemd timer status is unavailable")
    properties = dict(
        line.split("=", 1) for line in result.stdout.splitlines() if "=" in line
    )
    return {
        "state": properties.get("ActiveState", "unknown"),
        "next_run": properties.get("NextElapseUSecRealtime") or None,
        "last_run": properties.get("LastTriggerUSec") or None,
    }


class MetricSampler:
    """Collect a consistent metric snapshot while isolating sensor failures."""

    def __init__(
        self,
        *,
        read_text: Callable[[str], str] = _read_text,
        disk_usage: Callable[[str], object] = shutil.disk_usage,
        loadavg: Callable[[], tuple[float, float, float]] = os.getloadavg,
        hostname: Callable[[], str] = socket.gethostname,
        cpu_count: Callable[[], int | None] = os.cpu_count,
        backup_status: Callable[[], dict[str, str | None]] = read_backup_status,
        clock: Callable[[], str] = _clock,
    ) -> None:
        self._read_text = read_text
        self._disk_usage = disk_usage
        self._loadavg = loadavg
        self._hostname = hostname
        self._cpu_count = cpu_count
        self._backup_status = backup_status
        self._clock = clock
        self._previous_cpu: CpuTimes | None = None
        self._cpu_lock = threading.Lock()

    def snapshot(self) -> dict[str, object]:
        issues: list[str] = []
        result: dict[str, object] = {
            "sampled_at": self._clock(),
            "hostname": self._safe("hostname", self._hostname, issues),
        }

        with self._cpu_lock:
            current_cpu = self._safe(
                "cpu",
                lambda: parse_cpu_line(self._read_text("/proc/stat").splitlines()[0]),
                issues,
            )
            if isinstance(current_cpu, CpuTimes):
                baseline = self._previous_cpu or CpuTimes(0, 0)
                result["cpu_percent"] = cpu_percent(baseline, current_cpu)
                self._previous_cpu = current_cpu
            else:
                result["cpu_percent"] = None

        memory = self._safe(
            "memory", lambda: parse_meminfo(self._read_text("/proc/meminfo")), issues
        )
        result["memory_percent"] = memory["used_percent"] if isinstance(memory, dict) else None
        result["memory_total_bytes"] = memory["total_bytes"] if isinstance(memory, dict) else None

        disk = self._safe("disk", lambda: self._disk_usage("/"), issues)
        if disk is not None and getattr(disk, "total", 0):
            result["disk_percent"] = round(disk.used * 100 / disk.total, 1)
            result["disk_total_bytes"] = disk.total
        else:
            result["disk_percent"] = None
            result["disk_total_bytes"] = None

        load = self._safe("load", self._loadavg, issues)
        if isinstance(load, tuple) and len(load) == 3:
            result["load"] = [round(value, 2) for value in load]
            cores = self._safe("cpu_count", self._cpu_count, issues)
            if isinstance(cores, int) and cores > 0:
                result["load_per_cpu"] = round(load[0] / cores, 4)
            else:
                result["load_per_cpu"] = None
        else:
            result["load"] = None
            result["load_per_cpu"] = None

        uptime = self._safe(
            "uptime", lambda: int(float(self._read_text("/proc/uptime").split()[0])), issues
        )
        result["uptime_seconds"] = uptime
        result["backup"] = self._safe("backup", self._backup_status, issues)
        result["status"] = "degraded" if issues else "nominal"
        result["issues"] = issues
        return result

    @staticmethod
    def _safe(label: str, reader: Callable[[], object], issues: list[str]) -> object | None:
        try:
            return reader()
        except (OSError, ValueError, IndexError, StopIteration, subprocess.SubprocessError):
            issues.append(f"{label}: unavailable")
            return None
