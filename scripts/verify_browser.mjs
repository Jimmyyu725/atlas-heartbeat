#!/usr/bin/env node

import { spawn } from "node:child_process";
import assert from "node:assert/strict";
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
  const buffer = Buffer.from(result.data, "base64");
  await writeFile(path, buffer);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
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
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: targetUrl });
  await waitFor(
    send,
    "document.querySelector('#connection-status')?.dataset.connected === 'true' && Number(document.querySelector('#sequence')?.textContent) > 0",
    "live metrics did not arrive",
  );
  const firstSequence = await evaluate(send, "Number(document.querySelector('#sequence').textContent)");
  await waitFor(
    send,
    `Number(document.querySelector('#sequence')?.textContent) > ${firstSequence}`,
    "metrics did not refresh to a second sample",
  );

  const desktop = await evaluate(send, `(() => ({
    title: document.title,
    hostname: document.querySelector('#hostname')?.textContent,
    cpu: document.querySelector('#cpu-value')?.textContent,
    metricCards: document.querySelectorAll('[data-metric]').length,
    metricValues: [...document.querySelectorAll('[data-metric] > strong')].map((item) => item.textContent.trim()),
    sequence: document.querySelector('#sequence')?.textContent,
    connected: document.querySelector('#connection-status')?.dataset.connected,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    width: window.innerWidth,
    height: window.innerHeight,
    dustCount: Number(document.querySelector('#starfield')?.dataset.dustCount),
    surfaceAnimation: getComputedStyle(document.querySelector('.planet-surface')).animationName
  }))()`);
  assert.equal(desktop.title, "Atlas Heartbeat · 实时系统星球");
  assert.notEqual(desktop.hostname, "Atlas");
  assert.match(desktop.cpu, /^\d+\.\d%$/);
  assert.equal(desktop.metricCards, 6);
  assert.equal(desktop.metricValues.length, 6);
  assert.ok(desktop.metricValues.every((value) => value && value !== "—"));
  assert.ok(Number(desktop.sequence) > firstSequence);
  assert.equal(desktop.connected, "true");
  assert.equal(desktop.horizontalOverflow, false);
  assert.deepEqual([desktop.width, desktop.height], [1440, 1000]);
  assert.ok(desktop.dustCount >= 42);
  assert.match(desktop.surfaceAnimation, /surface-rotate/);

  await evaluate(send, "document.querySelector('#pulse-button').click(); true");
  const buttonPulse = await waitFor(
    send,
    "document.querySelector('#planet-system').classList.contains('is-pulsing')",
    "pulse button did not activate the planet",
  );
  await waitFor(
    send,
    "!document.querySelector('#planet-system').classList.contains('is-pulsing')",
    "button pulse did not finish",
  );
  await evaluate(send, "document.querySelector('#quiet-toggle').click(); true");
  const quietMode = await waitFor(
    send,
    `(() => ({
      active: document.body.classList.contains('is-quiet'),
      checked: document.querySelector('#quiet-toggle').checked,
      canvasPaused: document.querySelector('#starfield').dataset.paused,
      planetPaused: getComputedStyle(document.querySelector('.planet')).animationPlayState,
      surfacePaused: getComputedStyle(document.querySelector('.planet-surface')).animationPlayState
    }))()`,
    "quiet mode state was unavailable",
  );
  assert.deepEqual(quietMode, {
    active: true,
    checked: true,
    canvasPaused: "true",
    planetPaused: "paused",
    surfacePaused: "paused",
  });
  await evaluate(send, "document.querySelector('#quiet-toggle').click(); true");
  await waitFor(send, "document.querySelector('#starfield').dataset.paused === 'false'", "motion did not resume");

  await evaluate(send, "document.querySelector('#planet').focus(); true");
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    text: "\r",
    unmodifiedText: "\r",
    windowsVirtualKeyCode: 13,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  const enterPulse = await waitFor(
    send,
    "document.querySelector('#planet-system').classList.contains('is-pulsing')",
    "Enter did not pulse the planet",
  );
  await waitFor(
    send,
    "!document.querySelector('#planet-system').classList.contains('is-pulsing')",
    "Enter pulse did not finish",
  );
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: " ",
    code: "Space",
    text: " ",
    unmodifiedText: " ",
    windowsVirtualKeyCode: 32,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: " ",
    code: "Space",
    windowsVirtualKeyCode: 32,
  });
  const spacePulse = await waitFor(
    send,
    "document.querySelector('#planet-system').classList.contains('is-pulsing')",
    "Space did not pulse the planet",
  );
  await waitFor(
    send,
    "!document.querySelector('#planet-system').classList.contains('is-pulsing')",
    "Space pulse did not finish",
  );

  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  const reducedMotion = await waitFor(
    send,
    `(() => document.body.classList.contains('is-quiet') ? ({
      checked: document.querySelector('#quiet-toggle').checked,
      canvasPaused: document.querySelector('#starfield').dataset.paused,
      stored: localStorage.getItem('atlas-heartbeat-quiet')
    }) : null)()`,
    "reduced-motion preference did not pause visuals",
  );
  assert.equal(reducedMotion.checked, false);
  assert.equal(reducedMotion.canvasPaused, "true");
  assert.notEqual(reducedMotion.stored, "1");
  await send("Emulation.setEmulatedMedia", { features: [] });
  await waitFor(send, "document.querySelector('#starfield').dataset.paused === 'false'", "motion did not resume after media reset");

  const desktopScreenshot = await screenshot(send, "/tmp/atlas-heartbeat-verified-desktop.png");
  assert.deepEqual(desktopScreenshot, { width: 1440, height: 1000 });
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(250);
  const mobile = await evaluate(send, `(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    contentHeight: document.documentElement.scrollHeight,
    planetWidth: Math.round(document.querySelector('#planet-system').getBoundingClientRect().width),
    telemetryWidth: Math.round(document.querySelector('.telemetry').getBoundingClientRect().width),
    scrollWidth: document.documentElement.scrollWidth,
    overflowElements: [...document.querySelectorAll('body *')].flatMap((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < -0.5 || rect.right > window.innerWidth + 0.5
        ? [{ tag: element.tagName, className: element.className || '', left: Math.round(rect.left), right: Math.round(rect.right) }]
        : [];
    }).slice(0, 8)
  }))()`);
  assert.deepEqual([mobile.width, mobile.height], [390, 844]);
  assert.equal(mobile.horizontalOverflow, false, JSON.stringify(mobile));
  assert.ok(mobile.telemetryWidth <= mobile.width);
  const mobileScreenshot = await screenshot(send, "/tmp/atlas-heartbeat-verified-mobile.png");
  assert.deepEqual(mobileScreenshot, { width: 390, height: 844 });

  await sleep(100);
  if (errors.length) throw new Error(`browser errors: ${errors.join(" | ")}`);
  console.log(JSON.stringify({
    desktop,
    mobile,
    screenshots: { desktop: desktopScreenshot, mobile: mobileScreenshot },
    buttonPulse,
    keyboardPulse: { enter: enterPulse, space: spacePulse },
    quietMode,
    reducedMotion,
    errors,
  }, null, 2));
} finally {
  cdp?.socket.close();
  await stopProcess(chrome);
  await retry(() => rm(profile, { recursive: true, force: true }), { attempts: 20, delay: 50 });
}
