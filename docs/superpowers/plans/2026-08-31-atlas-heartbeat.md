# Atlas Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dependency-free live dashboard that turns Atlas system metrics into an interactive, accessible planet.

**Architecture:** A Python standard-library HTTP server exposes a read-only JSON snapshot and static assets. Pure Python and JavaScript modules contain parsing and state-mapping logic; a thin browser layer renders the live state as CSS and Canvas visuals.

**Tech Stack:** Python 3.12 standard library, browser HTML/CSS/Canvas, Node 24 native test runner, Chrome headless.

---

## File map

- `atlas_heartbeat/metrics.py`: system readers, parsers, CPU sampling, graceful fallbacks.
- `atlas_heartbeat/server.py`: CLI, static serving, `/api/pulse`, path containment.
- `atlas_heartbeat/__main__.py`: `python -m atlas_heartbeat` entry point.
- `web/state.mjs`: pure UI normalization, messages, and visual tuning.
- `web/app.js`: polling, DOM updates, Canvas animation, interactions.
- `web/index.html`: accessible page structure.
- `web/style.css`: responsive visual design and motion preferences.
- `tests/test_metrics.py`: Python metric behavior.
- `tests/test_server.py`: server and routing behavior.
- `tests/state.test.mjs`: JavaScript state behavior.
- `scripts/verify_browser.mjs`: Chrome CDP smoke verification.
- `README.md`: start, test, and usage instructions.

### Task 1: Metric model

**Files:**
- Create: `tests/test_metrics.py`
- Create: `atlas_heartbeat/__init__.py`
- Create: `atlas_heartbeat/metrics.py`

- [ ] **Step 1: Write failing parser and CPU-delta tests**

```python
from atlas_heartbeat.metrics import cpu_percent, parse_cpu_line, parse_meminfo

def test_cpu_percent_uses_idle_delta():
    assert cpu_percent((100, 40), (200, 70)) == 70.0

def test_parse_meminfo_uses_available_memory():
    text = "MemTotal: 1000 kB\nMemAvailable: 250 kB\n"
    assert parse_meminfo(text) == {"total_bytes": 1_024_000, "used_percent": 75.0}
```

- [ ] **Step 2: Run `python3 -m unittest tests.test_metrics -v`; expect import failure**

- [ ] **Step 3: Implement parsers and `MetricSampler.snapshot()` with injected readers**

```python
def cpu_percent(previous, current):
    total = current[0] - previous[0]
    idle = current[1] - previous[1]
    return round(max(0.0, min(100.0, (total - idle) * 100 / total)), 1) if total else 0.0
```

- [ ] **Step 4: Add failure-isolation test, run the file, and keep all tests green**

- [ ] **Step 5: Commit metric model**

### Task 2: Read-only HTTP service

**Files:**
- Create: `tests/test_server.py`
- Create: `atlas_heartbeat/server.py`
- Create: `atlas_heartbeat/__main__.py`

- [ ] **Step 1: Write failing tests for safe paths, pulse schema, and a live local endpoint**

```python
def test_safe_static_path_rejects_escape(self):
    self.assertIsNone(safe_static_path(self.web_root, "/../secret"))

def test_api_returns_json(self):
    with urlopen(self.base_url + "/api/pulse") as response:
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers.get_content_type(), "application/json")
```

- [ ] **Step 2: Run `python3 -m unittest tests.test_server -v`; expect import failure**

- [ ] **Step 3: Implement `ThreadingHTTPServer`, immutable caching headers, GET/HEAD, CLI host and port**

```python
def safe_static_path(root: Path, request_path: str) -> Path | None:
    candidate = (root / unquote(request_path).lstrip("/")).resolve()
    return candidate if candidate == root or root in candidate.parents else None
```

- [ ] **Step 4: Run the server tests and the entire Python suite**

- [ ] **Step 5: Commit the service**

### Task 3: UI state contract

**Files:**
- Create: `tests/state.test.mjs`
- Create: `web/state.mjs`

- [ ] **Step 1: Write failing Node tests for normalization, prose, and visual tuning**

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { normalizePulse, describeSystem, visualTuning } from "../web/state.mjs";

test("normalization clamps percentages", () => {
  assert.equal(normalizePulse({ cpu_percent: 140 }).cpuPercent, 100);
});

test("quiet systems receive a calm log entry", () => {
  assert.match(describeSystem({ cpuPercent: 8, memoryPercent: 20, diskPercent: 30 }), /quiet/i);
});
```

- [ ] **Step 2: Run `node --test tests/state.test.mjs`; expect module-not-found failure**

- [ ] **Step 3: Implement the pure functions with stable defaults and accessible text**

```javascript
export const clamp = (value, fallback = 0) =>
  Number.isFinite(Number(value)) ? Math.min(100, Math.max(0, Number(value))) : fallback;
```

- [ ] **Step 4: Run Node and Python suites**

- [ ] **Step 5: Commit UI state contract**

### Task 4: Interactive planet

**Files:**
- Create: `web/index.html`
- Create: `web/style.css`
- Create: `web/app.js`

- [ ] **Step 1: Add a failing browser contract test that expects the core landmarks and controls**

```python
def test_index_contains_accessible_landmarks(self):
    html = (WEB_ROOT / "index.html").read_text()
    self.assertIn('id="planet"', html)
    self.assertIn('id="quiet-toggle"', html)
    self.assertIn('aria-live="polite"', html)
```

- [ ] **Step 2: Run the contract test and observe the missing-file failure**

- [ ] **Step 3: Build semantic markup and responsive CSS with atmosphere, rings, scanline, cards, and one-column mobile layout**

- [ ] **Step 4: Build the polling and Canvas layer; pulse activates on click, Enter, and Space; quiet mode and reduced-motion stop decorative motion**

- [ ] **Step 5: Run all tests and commit the interface**

### Task 5: Documentation and browser verification

**Files:**
- Create: `scripts/verify_browser.mjs`
- Create: `README.md`

- [ ] **Step 1: Document exact start and test commands plus remote access caution**

```text
python3 -m atlas_heartbeat --port 8765
python3 -m unittest discover -s tests -v
node --test tests/state.test.mjs
```

- [ ] **Step 2: Start on an ephemeral local port and query `/api/pulse`**

- [ ] **Step 3: Use Chrome CDP to assert title, six values, successful refresh, pulse activation, and quiet mode**

- [ ] **Step 4: Capture 1440×1000 and 390×844 screenshots; inspect for overflow and visual regressions**

- [ ] **Step 5: Run fresh full verification, inspect diff, and commit the finished project**

- [ ] **Step 6: If GitHub authentication is available, create a private repository, verify `PRIVATE`, push, and compare commit hashes**
