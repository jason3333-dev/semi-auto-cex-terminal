import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), "..");

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function requestJson(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method || "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

async function waitForServer(baseUrl, child, output) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited before smoke test started: ${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/session`);
      if (response.ok) return;
    } catch {
      // Server is not listening yet.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for server: ${output()}`);
}

function stopServer(child) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 1_500);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

test("dry-run HTTP smoke covers core validation flows without credentials", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "semi-auto-dry-run-"));
  const sessionEnv = path.join(tempDir, ".env.session");
  const baseEnv = path.join(tempDir, ".env");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  await writeFile(sessionEnv, [
    "SESSION_EXCHANGE_ID=mememax-orderly",
    "TRADING_MODE=dry-run",
    "LIVE_UNLOCK_PHRASE=",
    "MEMEMAX_ORDERLY_ACCOUNT_ID=",
    "MEMEMAX_ORDERLY_KEY=",
    "MEMEMAX_ORDERLY_SECRET=",
    "ORDERLY_ACCOUNT_ID=",
    "ORDERLY_KEY=",
    "ORDERLY_SECRET=",
    "ACCOUNT_STREAM_ENABLED=false",
    "MEMEMAX_MARKET_DATA_MODE=mock",
    "MEMEMAX_CHASE_MIN_UPDATE_MS=50",
    "MEMEMAX_CHASE_UPDATE_MS=50",
    "MEMEMAX_CHASE_REST_FALLBACK_UPDATE_MS=50",
    ""
  ].join("\n"), "utf8");

  const child = spawn(process.execPath, [
    "src/server.js",
    "--base-env",
    baseEnv,
    "--session-env",
    sessionEnv
  ], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      LIVE_UNLOCK_PHRASE: "",
      MEMEMAX_ORDERLY_ACCOUNT_ID: "",
      MEMEMAX_ORDERLY_KEY: "",
      MEMEMAX_ORDERLY_SECRET: "",
      ORDERLY_ACCOUNT_ID: "",
      ORDERLY_KEY: "",
      ORDERLY_SECRET: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  const appendOutput = (chunk) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-4000);
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);

  t.after(async () => {
    await stopServer(child);
    await rm(tempDir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl, child, () => output);

  const session = await requestJson(baseUrl, "/api/session");
  assert.equal(session.mode, "dry-run");
  assert.equal(session.exchangeId, "mememax-orderly");
  assert.equal(session.hasApiKey, false);
  assert.equal(session.liveUnlocked, false);

  const symbols = await requestJson(baseUrl, "/api/symbols");
  assert.ok(symbols.symbols.some((symbol) => symbol.symbol === "BTCUSDC"));

  const focus = await requestJson(baseUrl, "/api/market/focus", {
    method: "POST",
    body: { symbol: "BTCUSDC", interval: "15s" }
  });
  assert.equal(focus.focused, false);

  const ticker = await requestJson(baseUrl, "/api/market/price?symbol=BTCUSDC");
  assert.equal(ticker.symbol, "BTCUSDC");
  assert.equal(ticker.price, "65000.0");

  const klines = await requestJson(baseUrl, "/api/market/klines?symbol=BTCUSDC&interval=15s&limit=4");
  assert.equal(klines.klines.length, 4);
  assert.ok(klines.klines.every((row) => Number(row.close) > 0));

  const book = await requestJson(baseUrl, "/api/market/orderbook?symbol=BTCUSDC&limit=2");
  assert.equal(book.orderBook.source, "mock");
  assert.equal(book.orderBook.bids.length, 2);
  assert.equal(book.orderBook.asks.length, 2);

  const leverage = await requestJson(baseUrl, "/api/trade/leverage", {
    method: "POST",
    body: { symbol: "BTCUSDC", leverage: 7 }
  });
  assert.equal(leverage.leverage, 7);

  const limitOrder = await requestJson(baseUrl, "/api/trade/limit-order", {
    method: "POST",
    body: {
      symbol: "BTCUSDC",
      action: "OPEN",
      positionSide: "LONG",
      quantity: "0.001",
      price: "64000",
      leverage: 7
    }
  });
  assert.equal(limitOrder.status, "NEW");
  assert.equal(limitOrder.type, "POST_ONLY");

  let snapshot = await requestJson(baseUrl, "/api/account/snapshot?symbol=BTCUSDC");
  assert.ok(snapshot.orders.some((order) => String(order.orderId) === String(limitOrder.orderId)));

  const cancelResult = await requestJson(baseUrl, "/api/trade/cancel-all", {
    method: "POST",
    body: { symbol: "BTCUSDC" }
  });
  assert.match(cancelResult.msg, /Dry-run canceled 1 open order/);

  snapshot = await requestJson(baseUrl, "/api/account/snapshot?symbol=BTCUSDC");
  assert.equal(snapshot.orders.length, 0);

  const fastOrder = await requestJson(baseUrl, "/api/trade/market-order", {
    method: "POST",
    body: {
      symbol: "BTCUSDC",
      action: "OPEN",
      positionSide: "LONG",
      quantity: "0.001",
      price: "65000",
      leverage: 7
    }
  });
  assert.equal(fastOrder.status, "FILLED");

  snapshot = await requestJson(baseUrl, "/api/account/snapshot?symbol=BTCUSDC");
  assert.ok(snapshot.positions.some((position) => position.positionSide === "LONG" && Number(position.positionAmt) > 0));

  const chaseJob = await requestJson(baseUrl, "/api/trade/chase/start", {
    method: "POST",
    body: {
      symbol: "BTCUSDC",
      action: "OPEN",
      positionSide: "SHORT",
      quantity: "0.001",
      price: "65001",
      leverage: 7
    }
  });
  assert.equal(chaseJob.status, "running");
  assert.ok(chaseJob.id);

  await delay(100);
  const stoppedJob = await requestJson(baseUrl, "/api/trade/chase/stop", {
    method: "POST",
    body: { jobId: chaseJob.id, cancelOrder: true }
  });
  assert.equal(stoppedJob.status, "stopped");

  const reverse = await requestJson(baseUrl, "/api/trade/reverse", {
    method: "POST",
    body: {
      symbol: "BTCUSDC",
      positionSide: "LONG",
      executionMode: "MARKET",
      price: "65000",
      leverage: 7
    }
  });
  assert.equal(reverse.mode, "MARKET");
  assert.equal(reverse.closed.status, "FILLED");
  assert.equal(reverse.opened.status, "FILLED");

  snapshot = await requestJson(baseUrl, "/api/account/snapshot?symbol=BTCUSDC");
  assert.ok(snapshot.positions.some((position) => position.positionSide === "SHORT" && Number(position.positionAmt) < 0));

  const emergency = await requestJson(baseUrl, "/api/trade/emergency-close", {
    method: "POST",
    body: { symbol: "BTCUSDC", confirm: "CLOSE_NOW" }
  });
  assert.equal(emergency.closed.length, 1);

  snapshot = await requestJson(baseUrl, "/api/account/snapshot?symbol=BTCUSDC");
  assert.equal(snapshot.positions.length, 0);
  assert.equal(snapshot.orders.length, 0);
});
