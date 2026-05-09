import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class FakeClassList {
  constructor(initial = "") {
    this.classes = new Set(String(initial).split(/\s+/).filter(Boolean));
  }

  add(...names) {
    for (const name of names) this.classes.add(name);
  }

  remove(...names) {
    for (const name of names) this.classes.delete(name);
  }

  toggle(name, force) {
    if (force === undefined) {
      if (this.classes.has(name)) {
        this.classes.delete(name);
        return false;
      }
      this.classes.add(name);
      return true;
    }
    if (force) this.classes.add(name);
    else this.classes.delete(name);
    return Boolean(force);
  }

  contains(name) {
    return this.classes.has(name);
  }

  toString() {
    return Array.from(this.classes).join(" ");
  }
}

class FakeElement {
  constructor(id) {
    this.id = id;
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.textContent = "";
    this.innerHTML = "";
    this.classList = new FakeClassList();
    this.attributes = new Map();
    this.listeners = new Map();
  }

  set className(value) {
    this.classList = new FakeClassList(value);
  }

  get className() {
    return this.classList.toString();
  }

  addEventListener(event, handler) {
    this.listeners.set(event, handler);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  getAttribute(name) {
    return this.attributes.get(name) || null;
  }

  getBoundingClientRect() {
    return { width: 640, height: 320 };
  }

  getContext() {
    return {
      beginPath() {},
      clearRect() {},
      fillRect() {},
      fillText() {},
      lineTo() {},
      moveTo() {},
      setLineDash() {},
      stroke() {}
    };
  }
}

function loadTerminalApp() {
  const elements = new Map();
  const element = (selector) => {
    const id = selector.replace(/^#/, "");
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  };

  const source = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const testSource = source.replace(
    /boot\(\)\.catch\(\(error\) => \{\s*toast\(error\.message, true\);\s*\}\);/,
    `globalThis.__terminalTestHooks = {
      app,
      ui,
      beginAction,
      createRequestError,
      chartLimit,
      renderJobs,
      renderOrders,
      runTradeAction,
      serverFailureMessage,
      updateActionControls
    };`
  );

  const sandbox = {
    document: { querySelector: element },
    window: {
      addEventListener() {},
      clearTimeout() {},
      confirm: () => true,
      devicePixelRatio: 1,
      prompt: () => "CLOSE_NOW",
      setInterval: () => 1,
      setTimeout: () => 1
    },
    console,
    Event: class Event {}
  };
  sandbox.globalThis = sandbox;
  sandbox.clearTimeout = sandbox.window.clearTimeout;
  sandbox.setInterval = sandbox.window.setInterval;
  sandbox.setTimeout = sandbox.window.setTimeout;

  vm.runInNewContext(testSource, sandbox, { filename: "public/app.js" });
  const hooks = sandbox.__terminalTestHooks;
  hooks.ui.quantityInput.value = "0.001";
  hooks.ui.limitPriceInput.value = "65000";
  hooks.ui.leverageInput.value = "5";
  hooks.ui.autoChaseInput.checked = false;
  hooks.ui.fastModeInput.checked = false;
  return hooks;
}

test("formats server-side failure reasons for operator status", () => {
  const { serverFailureMessage } = loadTerminalApp();

  assert.equal(
    serverFailureMessage({
      details: {
        msg: "Margin is insufficient.",
        code: -2019,
        status: 400
      }
    }, 500),
    "Margin is insufficient. (code -2019, HTTP 400)"
  );

  assert.equal(
    serverFailureMessage({
      error: "Pegged limit job stopped after repeated transient exchange responses",
      details: {
        lastError: "Too many requests",
        status: 429
      }
    }),
    "Pegged limit job stopped after repeated transient exchange responses: Too many requests (HTTP 429)"
  );

  assert.equal(
    serverFailureMessage({
      message: "Exchange rejected reduce-only order",
      details: {
        error: "No position to reduce"
      }
    }, 400),
    "Exchange rejected reduce-only order: No position to reduce (HTTP 400)"
  );
});

test("order form defaults to auto chase with market wording", () => {
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");

  assert.match(html, /id="autoChaseInput"[^>]*checked/);
  assert.match(html, /id="stopLossAmountInput" type="text"[^>]*placeholder="USDC or %"/);
  assert.match(html, /id="takeProfitAmountInput" type="text"[^>]*placeholder="USDC or %"/);
  assert.match(html, />\s*MARKET\s*</);
  assert.doesNotMatch(html, />\s*FAST\s*</);
});

test("chart defaults to 5 minute candles and keeps 15 second width available", () => {
  const { chartLimit, ui } = loadTerminalApp();
  const source = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");

  assert.match(html, /<option value="5m" selected>5m<\/option>/);
  assert.equal(chartLimit(), 180);
  ui.intervalSelect.value = "15s";
  assert.equal(chartLimit(), 240);
  assert.match(source, /HistogramSeries/);
  assert.match(source, /priceScaleId:\s*"volume"/);
  assert.match(source, /volumeData\(rows\)/);
});

test("pending trade actions disable controls and expose concise status", () => {
  const { beginAction, ui, updateActionControls } = loadTerminalApp();

  ui.autoChaseInput.checked = true;
  updateActionControls();
  assert.equal(ui.limitOrderButton.textContent, "추격 지정가 시작");

  const release = beginAction("chaseStart");
  assert.equal(ui.limitOrderButton.disabled, true);
  assert.equal(ui.cancelAllButton.disabled, true);
  assert.equal(ui.limitOrderButton.textContent, "추격 시작 중");
  assert.equal(ui.limitOrderButton.getAttribute("aria-busy"), "true");
  assert.equal(ui.operationStatus.textContent, "CHASE START pending");
  assert.equal(ui.operationStatus.classList.contains("pending"), true);

  release();
  assert.equal(ui.limitOrderButton.disabled, false);
  assert.equal(ui.cancelAllButton.disabled, false);
  assert.equal(ui.limitOrderButton.getAttribute("aria-busy"), null);
});

test("pending state names every live operation control", () => {
  const { beginAction, ui } = loadTerminalApp();
  const cases = [
    ["limitOrder", ui.limitOrderButton, "지정가 전송 중"],
    ["marketOrder", ui.limitOrderButton, "MARKET 전송 중"],
    ["chaseStop", ui.stopChaseButton, "추격 중지 중"],
    ["reverse", ui.reverseButton, "리버스 실행 중"],
    ["cancel", ui.cancelAllButton, "취소 중"],
    ["emergency", ui.emergencyButton, "정리 중"]
  ];

  for (const [actionKey, button, label] of cases) {
    const release = beginAction(actionKey);
    assert.equal(button.textContent, label);
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute("aria-busy"), "true");
    assert.equal(ui.limitOrderButton.disabled, true);
    assert.equal(ui.reverseButton.disabled, true);
    assert.equal(ui.cancelAllButton.disabled, true);
    assert.equal(ui.emergencyButton.disabled, true);
    release();
    assert.equal(button.getAttribute("aria-busy"), null);
  }
});

test("stop chase control tracks visible running jobs", () => {
  const { app, renderJobs, ui, updateActionControls } = loadTerminalApp();

  updateActionControls();
  assert.equal(ui.stopChaseButton.disabled, true);

  renderJobs([
    {
      id: "job-running",
      status: "running",
      symbol: "BTCUSDC",
      action: "OPEN",
      side: "BUY",
      positionSide: "LONG",
      timeInForce: "GTX",
      quantity: "0.001",
      lastPrice: "65000",
      replaceCount: 1,
      maxReplaces: 25
    }
  ]);
  assert.equal(app.hasRunningChaseJob, true);
  assert.equal(app.chaseJobId, "job-running");
  assert.equal(ui.stopChaseButton.disabled, false);

  renderJobs([
    {
      id: "job-running",
      status: "error",
      symbol: "BTCUSDC",
      action: "OPEN",
      side: "BUY",
      positionSide: "LONG",
      timeInForce: "GTX",
      quantity: "0.001",
      lastPrice: "65000",
      replaceCount: 1,
      maxReplaces: 25,
      terminalReason: "post-only rejected"
    }
  ]);
  assert.equal(app.hasRunningChaseJob, false);
  assert.equal(app.chaseJobId, "");
  assert.equal(ui.stopChaseButton.disabled, true);
});

test("open orders render per-row close controls", () => {
  const { renderOrders, ui } = loadTerminalApp();

  renderOrders([
    {
      symbol: "BTCUSDC",
      orderId: "1001",
      action: "OPEN",
      positionSide: "LONG",
      type: "LIMIT",
      timeInForce: "GTX",
      origQty: "0.001",
      price: "80000",
      status: "NEW"
    }
  ]);

  assert.match(ui.ordersBody.innerHTML, /class="order-cancel-button"/);
  assert.match(ui.ordersBody.innerHTML, /data-order-id="1001"/);
  assert.match(ui.ordersBody.innerHTML, /닫기/);
});

test("running chase jobs stay visible ahead of terminal history", () => {
  const { app, renderJobs, ui } = loadTerminalApp();
  const terminalJobs = Array.from({ length: 9 }, (_, index) => ({
    id: `job-done-${index}`,
    status: "done",
    symbol: `OLD${index}USDC`,
    action: "OPEN",
    side: "BUY",
    positionSide: "LONG",
    timeInForce: "GTX",
    quantity: "0.001",
    lastPrice: "65000",
    replaceCount: index,
    maxReplaces: 25,
    updatedAt: `2026-05-09T00:0${index % 9}:00.000Z`
  }));

  renderJobs([
    ...terminalJobs,
    {
      id: "job-running-latest",
      status: "running",
      symbol: "BTCUSDC",
      action: "OPEN",
      side: "BUY",
      positionSide: "LONG",
      timeInForce: "GTX",
      quantity: "0.001",
      pendingPrice: "65001",
      lastPrice: "65000",
      replaceCount: 2,
      maxReplaces: 25,
      updatedAt: "2026-05-09T00:00:00.000Z"
    }
  ]);

  assert.equal(app.hasRunningChaseJob, true);
  assert.equal(app.chaseJobId, "job-running-latest");
  assert.equal(ui.stopChaseButton.disabled, false);
  assert.match(ui.jobsList.innerHTML, /job-running-latest|BTCUSDC/);
  assert.doesNotMatch(ui.jobsList.innerHTML, /OLD0USDC/);
});

test("failed trade actions keep server reason visible", async () => {
  const { createRequestError, runTradeAction, ui } = loadTerminalApp();

  await runTradeAction("cancel", async () => {
    throw createRequestError({
      details: {
        msg: "Unknown order sent by exchange",
        code: -2011,
        status: 400
      }
    }, 400);
  });

  assert.equal(
    ui.operationStatus.textContent,
    "CANCEL failed: Unknown order sent by exchange (code -2011, HTTP 400)"
  );
  assert.equal(ui.operationStatus.classList.contains("negative"), true);
  assert.equal(ui.cancelAllButton.disabled, false);
});

test("renders chase jobs with active target, retry, replacement, and terminal details", () => {
  const { renderJobs, ui } = loadTerminalApp();

  renderJobs([
    {
      id: "job-running",
      status: "running",
      symbol: "BTCUSDC",
      action: "OPEN",
      side: "BUY",
      positionSide: "LONG",
      timeInForce: "GTX",
      quantity: "0.001",
      pendingPrice: "65001",
      lastPrice: "65000",
      pegSide: "best bid",
      tickOffset: 0,
      replaceCount: 3,
      maxReplaces: 25,
      retryCount: 1,
      totalRetries: 2,
      effectiveUpdateMs: 800,
      lastError: "Too many requests",
      marketSource: "ws-bbo",
      replaceStrategy: "edit-order",
      backoffMs: 1200
    },
    {
      id: "job-error",
      status: "error",
      symbol: "ETHUSDC",
      action: "CLOSE",
      side: "SELL",
      positionSide: "LONG",
      timeInForce: "GTX",
      quantity: "0.02",
      lastPrice: "3000",
      replaceCount: 7,
      maxReplaces: 25,
      retryCount: 0,
      totalRetries: 3,
      updatedAt: "2026-05-09T00:00:00.000Z",
      terminalReason: "Repeated post-only rejects",
      error: "Repeated post-only rejects"
    }
  ]);

  assert.match(ui.jobsList.innerHTML, /job-active/);
  assert.match(ui.jobsList.innerHTML, /status-active/);
  assert.match(ui.jobsList.innerHTML, /65,001 pending/);
  assert.match(ui.jobsList.innerHTML, /3\/25/);
  assert.match(ui.jobsList.innerHTML, /1\/2/);
  assert.match(ui.jobsList.innerHTML, /last error: Too many requests/);
  assert.match(ui.jobsList.innerHTML, /terminal ERROR/);
  assert.match(ui.jobsList.innerHTML, /Repeated post-only rejects/);
});
