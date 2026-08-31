#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";


const targetUrl = process.argv[2] ?? "http://127.0.0.1:8765/";
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function retry(action, { attempts = 80, delay = 100 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      await sleep(delay);
    }
  }
  throw lastError;
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const errors = [];

  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      errors.push(message.params.exceptionDetails.text || "Uncaught exception");
    }
    if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
      const entry = message.params.entry;
      errors.push(`${entry.text}${entry.url ? ` (${entry.url})` : ""}`);
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      errors.push(message.params.args.map((item) => item.value ?? item.description).join(" "));
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  return { errors, send, socket };
}

async function evaluate(send, expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(send, expression, message) {
  return retry(async () => {
    const value = await evaluate(send, expression);
    if (!value) throw new Error(message);
    return value;
  }, { attempts: 100, delay: 100 });
}

async function screenshot(send, path, { fullPage = false } = {}) {
  const result = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: fullPage,
    fromSurface: true,
  });
  await writeFile(path, Buffer.from(result.data, "base64"));
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  await closed;
}

const profile = await mkdtemp(join(tmpdir(), "atlas-heartbeat-cdp-"));
const chrome = spawn("google-chrome", [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--hide-scrollbars",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "--window-size=1440,1000",
  "about:blank",
], { stdio: "ignore" });

let cdp;
try {
  const portInfo = await retry(async () => {
    const content = await readFile(join(profile, "DevToolsActivePort"), "utf8");
    const [port] = content.trim().split("\n");
    if (!port) throw new Error("Chrome did not expose a debug port");
    return port;
  });
  const targets = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${portInfo}/json/list`);
    const list = await response.json();
    if (!list.some((target) => target.type === "page" && target.url === "about:blank")) {
      throw new Error("Chrome did not expose the blank page target");
    }
    return list;
  });
  const pageTarget = targets.find((target) => target.type === "page" && target.url === "about:blank");
  cdp = await connectCdp(pageTarget.webSocketDebuggerUrl);
  const { send, errors } = cdp;
  await Promise.all([
    send("Page.enable"),
    send("Runtime.enable"),
    send("Log.enable"),
  ]);
  await send("Page.navigate", { url: targetUrl });
  await waitFor(
    send,
    "document.querySelector('#connection-status')?.dataset.connected === 'true' && Number(document.querySelector('#sequence')?.textContent) > 0",
    "live metrics did not arrive",
  );

  const desktop = await evaluate(send, `(() => ({
    title: document.title,
    hostname: document.querySelector('#hostname')?.textContent,
    cpu: document.querySelector('#cpu-value')?.textContent,
    metricCards: document.querySelectorAll('[data-metric]').length,
    sequence: document.querySelector('#sequence')?.textContent,
    connected: document.querySelector('#connection-status')?.dataset.connected,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    width: window.innerWidth,
    height: window.innerHeight
  }))()`);
  if (desktop.metricCards !== 6 || desktop.connected !== "true" || desktop.horizontalOverflow) {
    throw new Error(`desktop contract failed: ${JSON.stringify(desktop)}`);
  }

  await evaluate(send, "document.querySelector('#pulse-button').click(); true");
  const buttonPulse = await waitFor(
    send,
    "document.querySelector('#planet-system').classList.contains('is-pulsing')",
    "pulse button did not activate the planet",
  );
  await evaluate(send, "document.querySelector('#quiet-toggle').click(); true");
  const quietMode = await evaluate(
    send,
    "document.body.classList.contains('is-quiet') && document.querySelector('#quiet-toggle').checked",
  );

  await evaluate(send, "document.querySelector('#planet').focus(); true");
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  const keyboardPulse = await waitFor(
    send,
    "document.querySelector('#planet-system').classList.contains('is-pulsing')",
    "keyboard activation did not pulse the planet",
  );

  await screenshot(send, "/tmp/atlas-heartbeat-verified-desktop.png");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await sleep(250);
  const mobile = await evaluate(send, `(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    contentHeight: document.documentElement.scrollHeight,
    planetWidth: Math.round(document.querySelector('#planet-system').getBoundingClientRect().width),
    telemetryWidth: Math.round(document.querySelector('.telemetry').getBoundingClientRect().width)
  }))()`);
  if (mobile.horizontalOverflow || mobile.telemetryWidth > mobile.width) {
    throw new Error(`mobile contract failed: ${JSON.stringify(mobile)}`);
  }
  await screenshot(send, "/tmp/atlas-heartbeat-verified-mobile.png", { fullPage: true });

  await sleep(100);
  if (errors.length) throw new Error(`browser errors: ${errors.join(" | ")}`);
  console.log(JSON.stringify({ desktop, mobile, buttonPulse, keyboardPulse, quietMode, errors }, null, 2));
} finally {
  cdp?.socket.close();
  await stopProcess(chrome);
  await rm(profile, { recursive: true, force: true });
}
