// Pure state mapping shared by the browser and Node tests.

export function clamp(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(100, Math.max(0, numeric));
}

function finiteOrNull(value) {
  const numeric = Number(value);
  return value !== null && value !== undefined && Number.isFinite(numeric) ? numeric : null;
}

export function normalizePulse(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const rawLoad = Array.isArray(source.load) ? source.load : [];
  return {
    hostname: typeof source.hostname === "string" && source.hostname ? source.hostname : "Atlas",
    cpuPercent: clamp(source.cpu_percent, null),
    memoryPercent: clamp(source.memory_percent, null),
    diskPercent: clamp(source.disk_percent, null),
    memoryTotalBytes: finiteOrNull(source.memory_total_bytes),
    diskTotalBytes: finiteOrNull(source.disk_total_bytes),
    load: [0, 1, 2].map((index) => finiteOrNull(rawLoad[index])),
    loadPerCpu: finiteOrNull(source.load_per_cpu),
    uptimeSeconds: finiteOrNull(source.uptime_seconds),
    sampledAt: typeof source.sampled_at === "string" ? source.sampled_at : null,
    backup: source.backup && typeof source.backup === "object" ? source.backup : null,
    status: source.status === "nominal" ? "nominal" : "degraded",
    issues: Array.isArray(source.issues) ? source.issues.filter((item) => typeof item === "string") : [],
  };
}

export function describeSystem(pulse) {
  if (pulse.status === "degraded") return "部分传感器正在穿越静默区，保留上一次可用信号。";
  if ((pulse.cpuPercent ?? 0) >= 75) return "核心活动增强，星球自转正在加速。";
  if ((pulse.memoryPercent ?? 0) >= 85) return "内存潮汐偏高，核心光正在变亮。";
  if ((pulse.diskPercent ?? 0) >= 85) return "磁盘光环接近闭合，值得留意剩余空间。";
  if ((pulse.loadPerCpu ?? 0) >= 0.8) return "星尘密度升高，Atlas 正在处理一阵任务流。";
  return "Atlas 很安静，各条轨道平稳运行。";
}

export function visualTuning(pulse) {
  const cpu = clamp(pulse.cpuPercent, 0);
  const memory = clamp(pulse.memoryPercent, 0);
  const disk = clamp(pulse.diskPercent, 0);
  const load = Math.min(1, Math.max(0, finiteOrNull(pulse.loadPerCpu) ?? 0));
  return {
    orbitSeconds: Number((32 - cpu * 0.24).toFixed(1)),
    surfaceSeconds: Number((48 - cpu * 0.36).toFixed(1)),
    breathSeconds: Number((6.2 - cpu * 0.032).toFixed(1)),
    glow: Number((0.45 + memory * 0.006).toFixed(2)),
    dustCount: 36 + Math.round(load * 72),
    diskArc: Math.round(disk * 3.6),
    hue: Math.round(188 + memory * 0.42),
  };
}

export function reconcileStarCount(stars, targetCount, factory) {
  const desired = Math.min(300, Math.max(0, Math.round(Number(targetCount) || 0)));
  if (stars.length >= desired) return stars.slice(0, desired);
  const next = stars.slice();
  while (next.length < desired) next.push(factory(next.length));
  return next;
}

export function formatPercent(value) {
  const numeric = finiteOrNull(value);
  return numeric === null ? "—" : `${numeric.toFixed(1)}%`;
}

export function formatBytes(value) {
  const numeric = finiteOrNull(value);
  if (numeric === null || numeric < 0) return "—";
  if (numeric >= 1_000_000_000) return `${(numeric / 1_000_000_000).toFixed(1)} GB`;
  if (numeric >= 1_000_000) return `${(numeric / 1_000_000).toFixed(1)} MB`;
  if (numeric >= 1_000) return `${(numeric / 1_000).toFixed(1)} kB`;
  return `${Math.round(numeric)} B`;
}

export function formatUptime(value) {
  const numeric = finiteOrNull(value);
  if (numeric === null || numeric < 0) return "—";
  const totalMinutes = Math.floor(numeric / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  if (days > 0) return `${days}天 ${hours}小时`;
  if (hours > 0) return `${hours}小时 ${totalMinutes % 60}分钟`;
  return totalMinutes > 0 ? `${totalMinutes}分钟` : "刚刚";
}
