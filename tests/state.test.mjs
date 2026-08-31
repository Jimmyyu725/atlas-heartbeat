import test from "node:test";
import assert from "node:assert/strict";

import {
  clamp,
  describeSystem,
  formatBytes,
  formatPercent,
  formatUptime,
  normalizePulse,
  reconcileStarCount,
  visualTuning,
} from "../web/state.mjs";


test("clamp bounds numeric input and preserves fallback for missing input", () => {
  assert.equal(clamp(140), 100);
  assert.equal(clamp(-4), 0);
  assert.equal(clamp("42.5"), 42.5);
  assert.equal(clamp(undefined, null), null);
});

test("normalizePulse maps snake case API data to stable UI state", () => {
  const pulse = normalizePulse({
    hostname: "atlas-test",
    cpu_percent: 140,
    memory_percent: 62.3,
    disk_percent: -1,
    memory_total_bytes: 8_000_000_000,
    disk_total_bytes: 100_000_000_000,
    load: [0.25, 0.5, 0.75],
    load_per_cpu: 0.0625,
    uptime_seconds: 90061,
    sampled_at: "2026-08-31T12:00:00Z",
    backup: { state: "active", next_run: "Tue 2026-09-01 06:10:00 UTC" },
    status: "nominal",
  });

  assert.equal(pulse.hostname, "atlas-test");
  assert.equal(pulse.cpuPercent, 100);
  assert.equal(pulse.memoryPercent, 62.3);
  assert.equal(pulse.diskPercent, 0);
  assert.deepEqual(pulse.load, [0.25, 0.5, 0.75]);
  assert.equal(pulse.uptimeSeconds, 90061);
  assert.equal(pulse.status, "nominal");
});

test("normalizePulse returns understandable defaults for malformed input", () => {
  const pulse = normalizePulse(null);

  assert.equal(pulse.hostname, "Atlas");
  assert.equal(pulse.cpuPercent, null);
  assert.deepEqual(pulse.load, [null, null, null]);
  assert.equal(pulse.status, "degraded");
});

test("describeSystem turns load into a short Chinese log entry", () => {
  assert.match(
    describeSystem({ cpuPercent: 8, memoryPercent: 20, diskPercent: 30, status: "nominal" }),
    /很安静/,
  );
  assert.match(
    describeSystem({ cpuPercent: 82, memoryPercent: 20, diskPercent: 30, status: "nominal" }),
    /核心活动/,
  );
  assert.match(
    describeSystem({ cpuPercent: 8, memoryPercent: 20, diskPercent: 30, status: "degraded" }),
    /传感器/,
  );
});

test("visualTuning accelerates rotation and dust as activity rises", () => {
  const calm = visualTuning({ cpuPercent: 0, memoryPercent: 0, diskPercent: 10, loadPerCpu: 0 });
  const busy = visualTuning({ cpuPercent: 100, memoryPercent: 90, diskPercent: 80, loadPerCpu: 1 });

  assert.ok(busy.orbitSeconds < calm.orbitSeconds);
  assert.ok(busy.surfaceSeconds < calm.surfaceSeconds);
  assert.ok(busy.glow > calm.glow);
  assert.ok(busy.dustCount > calm.dustCount);
  assert.equal(busy.diskArc, 288);
});

test("reconcileStarCount grows and shrinks dust without stale particles", () => {
  const initial = [{ id: 0 }, { id: 1 }];
  const grown = reconcileStarCount(initial, 4, (index) => ({ id: index }));
  const shrunk = reconcileStarCount(grown, 1, (index) => ({ id: index }));

  assert.deepEqual(grown.map((star) => star.id), [0, 1, 2, 3]);
  assert.deepEqual(shrunk.map((star) => star.id), [0]);
  assert.notEqual(grown, initial);
});

test("formatters keep missing and large values readable", () => {
  assert.equal(formatPercent(null), "—");
  assert.equal(formatPercent(12.34), "12.3%");
  assert.equal(formatBytes(2_000_000_000), "2.0 GB");
  assert.equal(formatBytes(null), "—");
  assert.equal(formatUptime(90061), "1天 1小时");
  assert.equal(formatUptime(null), "—");
});
