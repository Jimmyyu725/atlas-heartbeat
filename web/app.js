import {
  describeSystem,
  formatBytes,
  formatPercent,
  formatUptime,
  normalizePulse,
  visualTuning,
} from "./state.mjs";

const root = document.documentElement;
const body = document.body;
const connection = document.querySelector("#connection-status");
const connectionLabel = document.querySelector("#connection-label");
const missionLog = document.querySelector("#mission-log");
const planetSystem = document.querySelector("#planet-system");
const quietToggle = document.querySelector("#quiet-toggle");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let sequence = 0;
let latestTuning = visualTuning({});
let refreshTimer;
let pulseTimer;

const text = (selector, value) => {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
};

const percentWidth = (selector, value) => {
  const element = document.querySelector(selector);
  if (element) element.style.width = `${value ?? 0}%`;
};

function formatLoad(values) {
  return values.map((value) => (value === null ? "—" : value.toFixed(2))).join(" · ");
}

function formatSampleTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatBackup(backup) {
  if (!backup) return ["未知", "传感器不可用"];
  const labels = {
    active: "已排程",
    waiting: "等待中",
    inactive: "未启用",
    failed: "需检查",
    unknown: "未知",
  };
  const state = labels[backup.state] ?? String(backup.state || "未知");
  return [state, backup.next_run ? `下次 ${backup.next_run}` : "未提供下次时间"];
}

function applySnapshot(raw) {
  const pulse = normalizePulse(raw);
  latestTuning = visualTuning(pulse);
  sequence += 1;

  root.style.setProperty("--cpu", pulse.cpuPercent ?? 0);
  root.style.setProperty("--memory", pulse.memoryPercent ?? 0);
  root.style.setProperty("--disk", pulse.diskPercent ?? 0);
  root.style.setProperty("--disk-arc", `${latestTuning.diskArc}deg`);
  root.style.setProperty("--planet-hue", latestTuning.hue);
  root.style.setProperty("--planet-glow", latestTuning.glow);
  root.style.setProperty("--orbit-speed", `${latestTuning.orbitSeconds}s`);
  root.style.setProperty("--breath-speed", `${latestTuning.breathSeconds}s`);

  text("#hostname", pulse.hostname);
  text("#cpu-value", formatPercent(pulse.cpuPercent));
  text("#memory-value", formatPercent(pulse.memoryPercent));
  text("#disk-value", formatPercent(pulse.diskPercent));
  text("#memory-total", `${formatBytes(pulse.memoryTotalBytes)} 总量`);
  text("#disk-total", `${formatBytes(pulse.diskTotalBytes)} 总量`);
  text("#load-value", formatLoad(pulse.load));
  text("#load-detail", pulse.loadPerCpu === null ? "每核心 —" : `每核心 ${pulse.loadPerCpu.toFixed(2)}`);
  text("#uptime-value", formatUptime(pulse.uptimeSeconds));
  const [backupLabel, backupDetail] = formatBackup(pulse.backup);
  text("#backup-value", backupLabel);
  text("#backup-detail", backupDetail);
  text("#sampled-at", formatSampleTime(pulse.sampledAt));
  text("#sequence", String(sequence).padStart(3, "0"));
  missionLog.textContent = describeSystem(pulse);

  percentWidth("#cpu-meter", pulse.cpuPercent);
  percentWidth("#memory-meter", pulse.memoryPercent);
  percentWidth("#disk-meter", pulse.diskPercent);
  body.dataset.systemStatus = pulse.status;
}

function setConnection(isConnected) {
  connection.dataset.connected = String(isConnected);
  connectionLabel.textContent = isConnected ? "实时信号稳定" : "信号暂时中断";
}

async function refresh() {
  clearTimeout(refreshTimer);
  try {
    const response = await fetch("/api/pulse", {
      cache: "no-store",
      signal: AbortSignal.timeout(1800),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    applySnapshot(await response.json());
    setConnection(true);
    refreshTimer = window.setTimeout(refresh, 2000);
  } catch (_error) {
    setConnection(false);
    if (sequence === 0) missionLog.textContent = "遥测信号暂时中断，正在重新捕获……";
    refreshTimer = window.setTimeout(refresh, 5000);
  }
}

function emitPulse() {
  window.clearTimeout(pulseTimer);
  planetSystem.classList.remove("is-pulsing");
  void planetSystem.offsetWidth;
  planetSystem.classList.add("is-pulsing");
  pulseTimer = window.setTimeout(() => planetSystem.classList.remove("is-pulsing"), 1300);
}

function setQuietMode(enabled) {
  body.classList.toggle("is-quiet", enabled);
  quietToggle.checked = enabled;
  try {
    localStorage.setItem("atlas-heartbeat-quiet", enabled ? "1" : "0");
  } catch (_error) {
    // The visual preference can remain session-only when storage is unavailable.
  }
}

function initialQuietMode() {
  try {
    return localStorage.getItem("atlas-heartbeat-quiet") === "1" || reduceMotion.matches;
  } catch (_error) {
    return reduceMotion.matches;
  }
}

function createStarfield(canvas) {
  const context = canvas.getContext("2d", { alpha: true });
  let width = 0;
  let height = 0;
  let ratio = 1;
  let stars = [];
  let frame = 0;
  let pointer = { x: 0, y: 0 };

  const seed = () => {
    const count = Math.max(42, Math.min(150, latestTuning.dustCount + Math.round(width / 24)));
    stars = Array.from({ length: count }, (_, index) => ({
      x: ((index * 97.31) % width) || width / 2,
      y: ((index * index * 13.17) % height) || height / 2,
      radius: 0.35 + ((index * 17) % 10) / 10,
      depth: 0.18 + ((index * 29) % 80) / 100,
      phase: (index * 1.618) % (Math.PI * 2),
    }));
  };

  const resize = () => {
    ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    seed();
  };

  const draw = (time) => {
    context.clearRect(0, 0, width, height);
    const quiet = body.classList.contains("is-quiet") || reduceMotion.matches;
    const drift = quiet ? 0 : time * 0.000025 * (1 + (100 - latestTuning.orbitSeconds) / 100);
    for (const star of stars) {
      const parallaxX = pointer.x * star.depth * 8;
      const parallaxY = pointer.y * star.depth * 8;
      const x = (star.x + drift * width * star.depth + parallaxX) % width;
      const y = star.y + Math.sin(drift * 7 + star.phase) * 4 * star.depth + parallaxY;
      const alpha = 0.18 + star.depth * 0.55 + Math.sin(time * 0.0015 + star.phase) * 0.08;
      context.beginPath();
      context.fillStyle = `rgba(179, 225, 255, ${Math.max(0.08, alpha)})`;
      context.arc(x, y, star.radius, 0, Math.PI * 2);
      context.fill();
    }
    frame = window.requestAnimationFrame(draw);
  };

  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("pointermove", (event) => {
    pointer = { x: event.clientX / Math.max(1, width) - 0.5, y: event.clientY / Math.max(1, height) - 0.5 };
  }, { passive: true });
  resize();
  frame = window.requestAnimationFrame(draw);
  return () => window.cancelAnimationFrame(frame);
}

document.querySelector("#planet").addEventListener("click", emitPulse);
document.querySelector("#pulse-button").addEventListener("click", emitPulse);
quietToggle.addEventListener("change", () => setQuietMode(quietToggle.checked));
setQuietMode(initialQuietMode());
createStarfield(document.querySelector("#starfield"));
refresh();
