import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractPrivateOrderUpdate, uiSymbolFromExchangeSymbol } from "./account-stream-normalizers.js";
import { getExchange, listExchanges } from "./exchanges/registry.js";
import { ExchangeError } from "./exchanges/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const BASE_ENV_PATH = path.join(ROOT_DIR, ".env");
const SESSION_ENV_PATH = path.join(ROOT_DIR, ".env.session");
const LIVE_UNLOCK_PHRASE = "I_ACCEPT_LIVE_RISK";
const MAX_BODY_BYTES = 1024 * 1024;

function parseEnvValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readEnvText(envPath) {
  const buffer = fs.readFileSync(envPath);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8");
  }
  return buffer.toString("utf8");
}

function parseEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const entries = {};
  const lines = readEnvText(envPath).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [rawKey, ...rawValue] = trimmed.split("=");
    const key = rawKey.trim().replace(/^\uFEFF/, "");
    const value = parseEnvValue(rawValue.join("="));
    if (key) entries[key] = value;
  }
  return entries;
}

function applyEnvFile(envPath, { override = false } = {}) {
  const exists = fs.existsSync(envPath);
  const entries = exists ? parseEnvFile(envPath) : {};
  let appliedCount = 0;
  let skippedCount = 0;
  for (const [key, value] of Object.entries(entries)) {
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
      appliedCount += 1;
    } else {
      skippedCount += 1;
    }
  }
  return {
    file: path.basename(envPath),
    exists,
    keyCount: Object.keys(entries).length,
    appliedCount,
    skippedCount,
    override
  };
}

function loadDotEnv() {
  return [
    applyEnvFile(BASE_ENV_PATH, { override: false }),
    applyEnvFile(SESSION_ENV_PATH, { override: true })
  ];
}

const ENV_LOAD_REPORT = loadDotEnv();

function envNumber(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

const PORT = envNumber("PORT", 8787);
const ORDER_POST_ONLY = envBoolean("ORDER_POST_ONLY", true);
const BINANCE_ACCOUNT_MODE = (process.env.BINANCE_ACCOUNT_MODE || "portfolio").toLowerCase();
const BINANCE_POSITION_MODE = (process.env.BINANCE_POSITION_MODE || "hedge").toLowerCase();
const BINANCE_MARGIN_MODE = (process.env.BINANCE_MARGIN_MODE || "cross").toLowerCase();
const CHASE_MIN_UPDATE_MS = envNumber("CHASE_MIN_UPDATE_MS", 500);
const CHASE_UPDATE_MS = Math.max(CHASE_MIN_UPDATE_MS, envNumber("CHASE_UPDATE_MS", 500));
const CHASE_TICK_OFFSET = envNumber("CHASE_TICK_OFFSET", 0);
const CHASE_MAX_REPLACES = Math.min(2000, Math.max(1, envNumber("CHASE_MAX_REPLACES", 240)));
const CHASE_POST_ONLY = envBoolean("CHASE_POST_ONLY", true);
const CHASE_MAX_BACKOFF_MS = envNumber("CHASE_MAX_BACKOFF_MS", 30000);
const CHASE_MAX_TRANSIENT_ERRORS = Math.max(1, envNumber("CHASE_MAX_TRANSIENT_ERRORS", 8));
const CHASE_RETRY_PAD_MS = envNumber("CHASE_RETRY_PAD_MS", 750);
const CHASE_RATE_LIMIT_10S_ORDERS = Math.max(1, envNumber("CHASE_RATE_LIMIT_10S_ORDERS", 300));
const CHASE_RATE_LIMIT_SAFETY = Math.min(1, Math.max(0.1, envNumber("CHASE_RATE_LIMIT_SAFETY", 0.7)));
const CHASE_ORDER_OPS_PER_REPLACE = Math.max(1, envNumber("CHASE_ORDER_OPS_PER_REPLACE", 2));
const BRACKET_WATCH_INTERVAL_MS = envNumber("BRACKET_WATCH_INTERVAL_MS", 5000);
const BRACKET_WATCH_MAX_POLLS = Math.max(1, envNumber("BRACKET_WATCH_MAX_POLLS", 120));
const ACCOUNT_REFRESH_MS = Math.max(250, envNumber("ACCOUNT_REFRESH_MS", 1000));
const ACCOUNT_STREAM_ENABLED = envBoolean("ACCOUNT_STREAM_ENABLED", true);
const ACCOUNT_STREAM_KEEPALIVE_MS = Math.max(60_000, envNumber("ACCOUNT_STREAM_KEEPALIVE_MS", 50 * 60_000));
const ACCOUNT_STREAM_RECONNECT_MS = Math.max(1000, envNumber("ACCOUNT_STREAM_RECONNECT_MS", 5000));
const CHART_VWAP_ENABLED = envBoolean("CHART_VWAP_ENABLED", true);
const CHART_VWAP_PERIOD = Math.max(1, Math.min(500, envNumber("CHART_VWAP_PERIOD", 80)));

const state = {
  exchangeId: process.env.SESSION_EXCHANGE_ID || process.env.EXCHANGE_ID || "binance-usdm",
  mode: process.env.TRADING_MODE || "dry-run",
  credentialsByExchange: {
    "binance-usdm": {
      apiKey: process.env.BINANCE_API_KEY || "",
      apiSecret: process.env.BINANCE_API_SECRET || ""
    },
    "mememax-orderly": {
      accountId: process.env.MEMEMAX_ORDERLY_ACCOUNT_ID || process.env.ORDERLY_ACCOUNT_ID || "",
      orderlyKey: process.env.MEMEMAX_ORDERLY_KEY || process.env.ORDERLY_KEY || "",
      orderlySecret: process.env.MEMEMAX_ORDERLY_SECRET || process.env.ORDERLY_SECRET || "",
      orderTag: process.env.MEMEMAX_ORDER_TAG || "",
      baseUrl: process.env.MEMEMAX_ORDERLY_BASE_URL || "",
      testnetBaseUrl: process.env.MEMEMAX_ORDERLY_TESTNET_BASE_URL || "",
      publicWsBaseUrl: process.env.MEMEMAX_ORDERLY_PUBLIC_WS_BASE_URL || "",
      testnetPublicWsBaseUrl: process.env.MEMEMAX_ORDERLY_TESTNET_PUBLIC_WS_BASE_URL || "",
      privateWsBaseUrl: process.env.MEMEMAX_ORDERLY_PRIVATE_WS_BASE_URL || "",
      testnetPrivateWsBaseUrl: process.env.MEMEMAX_ORDERLY_TESTNET_PRIVATE_WS_BASE_URL || ""
    }
  },
  liveUnlocked: process.env.LIVE_UNLOCK_PHRASE === LIVE_UNLOCK_PHRASE,
  sessionStartTime: new Date().toISOString(),
  accountBaselines: new Map(),
  accountStream: {
    status: "idle",
    listenKey: "",
    lastEventTime: "",
    lastError: "",
    sequence: 0,
    ws: null,
    reconnectTimer: null,
    keepAliveTimer: null,
    clients: new Set()
  },
  logs: [],
  orderIntents: new Map(),
  chaseJobs: new Map(),
  orderRateLimit: new Map()
};

function exchangeCredentials(exchangeId = state.exchangeId) {
  return state.credentialsByExchange[exchangeId] || {};
}

function activeCredentials() {
  return exchangeCredentials(state.exchangeId);
}

function activeAccountMode() {
  return state.exchangeId === "binance-usdm" ? BINANCE_ACCOUNT_MODE : "orderly";
}

function activePositionMode() {
  return state.exchangeId === "binance-usdm" ? BINANCE_POSITION_MODE : "one-way";
}

function activeCredentialPreview(credentials = activeCredentials()) {
  const value = credentials.apiKey || credentials.orderlyKey || credentials.accountId || "";
  return value ? `${value.slice(0, 4)}...${value.slice(-4)}` : "";
}

function hasActiveApiKey(credentials = activeCredentials()) {
  return Boolean(credentials.apiKey || credentials.orderlyKey || credentials.accountId);
}

function hasActiveApiSecret(credentials = activeCredentials()) {
  return Boolean(credentials.apiSecret || credentials.orderlySecret);
}

function exchangeEnvPrefix(exchangeId = state.exchangeId) {
  if (exchangeId === "mememax-orderly") return "MEMEMAX_";
  if (exchangeId === "binance-usdm") return "BINANCE_";
  return "";
}

function envNumberForExchange(name, fallback) {
  const scopedName = `${exchangeEnvPrefix()}${name}`;
  if (scopedName !== name && process.env[scopedName] !== undefined && process.env[scopedName] !== "") {
    return envNumber(scopedName, fallback);
  }
  return fallback;
}

function envBooleanForExchange(name, fallback) {
  const scopedName = `${exchangeEnvPrefix()}${name}`;
  if (scopedName !== name && process.env[scopedName] !== undefined && process.env[scopedName] !== "") {
    return envBoolean(scopedName, fallback);
  }
  return fallback;
}

function activeChaseConfig(adapter = getExchange(state.exchangeId)) {
  const adapterConfig = adapter.chaseConfig?.(context()) || {};
  const minUpdateMs = Math.max(1, envNumberForExchange(
    "CHASE_MIN_UPDATE_MS",
    adapterConfig.minUpdateMs || CHASE_MIN_UPDATE_MS
  ));
  const updateMs = Math.max(minUpdateMs, envNumberForExchange(
    "CHASE_UPDATE_MS",
    adapterConfig.updateMs || CHASE_UPDATE_MS
  ));
  return {
    tickOffset: CHASE_TICK_OFFSET,
    updateMs,
    minUpdateMs,
    maxReplaces: CHASE_MAX_REPLACES,
    postOnly: CHASE_POST_ONLY,
    timeInForce: CHASE_POST_ONLY ? "GTX" : "GTC",
    rateLimit10sOrders: Math.max(1, envNumberForExchange(
      "CHASE_RATE_LIMIT_10S_ORDERS",
      adapterConfig.rateLimit10sOrders || CHASE_RATE_LIMIT_10S_ORDERS
    )),
    rateLimitSafety: Math.min(1, Math.max(0.1, envNumberForExchange(
      "CHASE_RATE_LIMIT_SAFETY",
      adapterConfig.rateLimitSafety || CHASE_RATE_LIMIT_SAFETY
    ))),
    rateLimitWindowMs: Math.max(100, envNumberForExchange(
      "CHASE_RATE_LIMIT_WINDOW_MS",
      adapterConfig.rateLimitWindowMs || 10_000
    )),
    orderOpsPerReplace: Math.max(1, envNumberForExchange(
      "CHASE_ORDER_OPS_PER_REPLACE",
      adapterConfig.orderOpsPerReplace || CHASE_ORDER_OPS_PER_REPLACE
    )),
    restFallbackUpdateMs: Math.max(updateMs, envNumberForExchange(
      "CHASE_REST_FALLBACK_UPDATE_MS",
      adapterConfig.restFallbackUpdateMs || updateMs
    )),
    statusCheckMs: Math.max(250, envNumberForExchange(
      "CHASE_STATUS_CHECK_MS",
      adapterConfig.statusCheckMs || 1000
    )),
    statusPollWithPrivateStream: envBooleanForExchange(
      "CHASE_STATUS_POLL_WITH_PRIVATE_STREAM",
      adapterConfig.statusPollWithPrivateStream ?? true
    ),
    replaceStrategy: adapterConfig.replaceStrategy || "cancel-replace"
  };
}

if (!["dry-run", "testnet", "live"].includes(state.mode)) {
  state.mode = "dry-run";
}
try {
  getExchange(state.exchangeId);
} catch {
  state.exchangeId = "binance-usdm";
}
if (state.mode === "live" && !state.liveUnlocked) {
  state.mode = "dry-run";
}

function log(level, message, meta = {}) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    meta
  };
  state.logs.unshift(entry);
  state.logs = state.logs.slice(0, 160);
  console.log(`[${entry.time}] ${level.toUpperCase()} ${message}`);
}

function logEnvFileDetection() {
  for (const report of ENV_LOAD_REPORT) {
    const status = report.exists ? "detected" : "missing";
    const details = report.exists
      ? `${report.keyCount} keys, applied ${report.appliedCount}, skipped ${report.skippedCount}`
      : "0 keys";
    log("info", `Env file ${status}: ${report.file} (${details})`, {
      file: report.file,
      exists: report.exists,
      keyCount: report.keyCount,
      appliedCount: report.appliedCount,
      skippedCount: report.skippedCount,
      override: report.override
    });
  }
}

function context() {
  return {
    mode: state.mode,
    exchangeId: state.exchangeId,
    accountMode: activeAccountMode(),
    positionMode: activePositionMode(),
    credentials: activeCredentials(),
    liveUnlocked: state.liveUnlocked
  };
}

function publicSession() {
  const credentials = activeCredentials();
  const adapter = getExchange(state.exchangeId);
  const chaseConfig = activeChaseConfig(adapter);
  return {
    exchangeId: state.exchangeId,
    mode: state.mode,
    exchanges: listExchanges(),
    hasApiKey: hasActiveApiKey(credentials),
    hasApiSecret: hasActiveApiSecret(credentials),
    apiKeyPreview: activeCredentialPreview(credentials),
    liveUnlocked: state.liveUnlocked,
    sessionEnvFile: ".env.session",
    sessionPersisted: fs.existsSync(SESSION_ENV_PATH),
    accountConfig: {
      accountMode: activeAccountMode(),
      positionMode: activePositionMode()
    },
    accountStream: {
      enabled: ACCOUNT_STREAM_ENABLED,
      status: state.accountStream.status,
      lastEventTime: state.accountStream.lastEventTime,
      lastError: state.accountStream.lastError,
      sequence: state.accountStream.sequence,
      refreshMs: ACCOUNT_REFRESH_MS,
      reconnectMs: ACCOUNT_STREAM_RECONNECT_MS
    },
    marketStream: adapter.marketDataStreamStatus?.() || null,
    chartConfig: {
      vwapEnabled: CHART_VWAP_ENABLED,
      vwapPeriod: CHART_VWAP_PERIOD
    },
    orderConfig: {
      postOnly: ORDER_POST_ONLY,
      timeInForce: ORDER_POST_ONLY ? "GTX" : "GTC"
    },
    chaseConfig: {
      tickOffset: chaseConfig.tickOffset,
      updateMs: chaseConfig.updateMs,
      maxReplaces: chaseConfig.maxReplaces,
      postOnly: chaseConfig.postOnly,
      timeInForce: chaseConfig.timeInForce,
      minUpdateMs: chaseConfig.minUpdateMs,
      rateLimit10sOrders: chaseConfig.rateLimit10sOrders,
      rateLimitSafety: chaseConfig.rateLimitSafety,
      rateLimitWindowMs: chaseConfig.rateLimitWindowMs,
      orderOpsPerReplace: chaseConfig.orderOpsPerReplace,
      restFallbackUpdateMs: chaseConfig.restFallbackUpdateMs,
      statusCheckMs: chaseConfig.statusCheckMs,
      statusPollWithPrivateStream: chaseConfig.statusPollWithPrivateStream,
      replaceStrategy: chaseConfig.replaceStrategy
    }
  };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function notFound(res) {
  json(res, 404, { error: "Not found" });
}

function parseQuery(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return { pathname: url.pathname, searchParams: url.searchParams };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large"));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png"
  }[ext] || "application/octet-stream";
}

function serveStatic(req, res, pathname) {
  if (pathname === "/favicon.ico") {
    res.writeHead(204, { "Cache-Control": "no-store" });
    res.end();
    return;
  }

  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    notFound(res);
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    notFound(res);
    return;
  }
  res.writeHead(200, {
    "Content-Type": mimeType(filePath),
    "Cache-Control": "no-store"
  });
  fs.createReadStream(filePath).pipe(res);
}

function requireLiveGuard(actionName) {
  if (state.mode === "live" && !state.liveUnlocked) {
    throw new ExchangeError(`${actionName} requires live unlock phrase`);
  }
}

function requireConfirm(payload, expected, actionName) {
  if (payload.confirm !== expected) {
    throw new ExchangeError(`${actionName} requires confirm="${expected}"`);
  }
}

function buildOrderIntent(payload) {
  const action = String(payload.action || "OPEN").toUpperCase();
  const positionSide = String(payload.positionSide || "LONG").toUpperCase();
  if (!["OPEN", "CLOSE"].includes(action)) {
    throw new ExchangeError(`Unsupported order action "${action}"`);
  }
  if (!["LONG", "SHORT"].includes(positionSide)) {
    throw new ExchangeError(`Unsupported position side "${positionSide}"`);
  }

  const side = positionSide === "LONG"
    ? (action === "OPEN" ? "BUY" : "SELL")
    : (action === "OPEN" ? "SELL" : "BUY");
  const hedgeMode = activePositionMode() === "hedge";

  return {
    action,
    positionSide,
    apiPositionSide: hedgeMode ? positionSide : undefined,
    side,
    reduceOnly: action === "CLOSE" && !hedgeMode
  };
}

function buildBracketConfig(payload, intent) {
  if (intent.action !== "OPEN") return null;
  const stopLossAmount = Number(payload.stopLossAmount || 0);
  const takeProfitAmount = Number(payload.takeProfitAmount || 0);
  const stopLossEnabled = Boolean(payload.stopLossEnabled) && stopLossAmount > 0;
  const takeProfitEnabled = Boolean(payload.takeProfitEnabled) && takeProfitAmount > 0;
  if (!stopLossEnabled && !takeProfitEnabled) return null;

  return {
    symbol: payload.symbol,
    positionSide: intent.positionSide,
    apiPositionSide: intent.apiPositionSide,
    closeSide: intent.positionSide === "LONG" ? "SELL" : "BUY",
    reduceOnly: activePositionMode() !== "hedge",
    quantity: String(payload.quantity),
    referencePrice: Number(payload.price),
    stopLossAmount: stopLossEnabled ? stopLossAmount : 0,
    takeProfitAmount: takeProfitEnabled ? takeProfitAmount : 0
  };
}

function oppositePositionSide(positionSide) {
  return positionSide === "LONG" ? "SHORT" : "LONG";
}

function absPositionQty(position) {
  const amount = Math.abs(Number(position?.positionAmt || 0));
  return Number.isFinite(amount) ? amount : 0;
}

function findPositionForReverse(positions, positionSide) {
  if (activePositionMode() === "hedge") {
    return positions.find((position) => position.positionSide === positionSide && absPositionQty(position) > 0);
  }

  return positions.find((position) => {
    const amount = Number(position.positionAmt || 0);
    if (positionSide === "LONG") return amount > 0;
    return amount < 0;
  });
}

function buildChaseJob(payload, intent, options = {}) {
  const nowIso = new Date().toISOString();
  const chaseConfig = activeChaseConfig(options.adapter);
  return {
    id: `chase_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    symbol: payload.symbol,
    action: intent.action,
    side: intent.side,
    positionSide: intent.positionSide,
    apiPositionSide: intent.apiPositionSide,
    reduceOnly: intent.reduceOnly,
    bracket: options.bracket || null,
    quantity: String(payload.quantity),
    tickOffset: chaseConfig.tickOffset,
    postOnly: chaseConfig.postOnly,
    updateMs: clampChaseInterval(chaseConfig.updateMs, chaseConfig.minUpdateMs),
    maxChases: chaseConfig.maxReplaces,
    rateLimit10sOrders: chaseConfig.rateLimit10sOrders,
    rateLimitSafety: chaseConfig.rateLimitSafety,
    rateLimitWindowMs: chaseConfig.rateLimitWindowMs,
    orderOpsPerReplace: chaseConfig.orderOpsPerReplace,
    restFallbackUpdateMs: chaseConfig.restFallbackUpdateMs,
    statusCheckMs: chaseConfig.statusCheckMs,
    statusPollWithPrivateStream: chaseConfig.statusPollWithPrivateStream,
    replaceStrategy: chaseConfig.replaceStrategy,
    purpose: options.purpose || "chase",
    parentJobId: options.parentJobId || "",
    reverseOpen: options.reverseOpen || null,
    status: "running",
    iterations: 0,
    lastPrice: "",
    marketSource: "",
    pendingPrice: "",
    nextReplaceAt: 0,
    lastStatusCheckAt: 0,
    statusSource: "",
    lastWakeSource: "",
    rateGateWaitMs: 0,
    replaceCount: 0,
    lastReplaceSentAt: "",
    lastReplaceAckAt: "",
    lastReplaceLatencyMs: 0,
    lastReplaceTotalMs: 0,
    fillSource: "",
    filledAt: "",
    orderId: "",
    error: "",
    backoffMs: 0,
    mode: state.mode,
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

function startChaseJob(adapter, job) {
  state.chaseJobs.set(job.id, job);
  log("info", "Pegged limit job started", {
    jobId: job.id,
    symbol: job.symbol,
    action: job.action,
    positionSide: job.positionSide,
    side: job.side,
    purpose: job.purpose,
    parentJobId: job.parentJobId,
    timeInForce: job.postOnly ? "GTX" : "GTC",
    pegSide: job.side === "BUY" ? "best bid" : "best ask",
    intervalMs: job.updateMs,
    replaceStrategy: job.replaceStrategy,
    orderOpsPerReplace: job.orderOpsPerReplace,
    mode: state.mode
  });
  runChaseJob(adapter, job);
  return job;
}

function activeChaseSymbols() {
  return Array.from(new Set(
    Array.from(state.chaseJobs.values())
      .filter((job) => job.status === "running" && job.symbol)
      .map((job) => job.symbol)
  ));
}

function bracketTriggerPrice(bracket, kind, entryPrice) {
  const quantity = Number(bracket.quantity);
  const amount = kind === "SL" ? bracket.stopLossAmount : bracket.takeProfitAmount;
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0) return 0;
  const delta = amount / quantity;
  if (bracket.positionSide === "LONG") {
    return kind === "SL" ? entryPrice - delta : entryPrice + delta;
  }
  return kind === "SL" ? entryPrice + delta : entryPrice - delta;
}

async function placeBracketOrders(adapter, bracket, entryPrice) {
  if (!bracket) return [];
  const placed = [];
  const common = {
    symbol: bracket.symbol,
    side: bracket.closeSide,
    positionSide: bracket.apiPositionSide,
    reduceOnly: bracket.reduceOnly,
    quantity: bracket.quantity,
    workingType: "MARK_PRICE"
  };
  const stopLossPrice = bracket.stopLossAmount > 0 ? bracketTriggerPrice(bracket, "SL", entryPrice) : 0;
  const takeProfitPrice = bracket.takeProfitAmount > 0 ? bracketTriggerPrice(bracket, "TP", entryPrice) : 0;

  if (adapter.placePositionBracketOrder && (stopLossPrice > 0 || takeProfitPrice > 0)) {
    const result = await adapter.placePositionBracketOrder(context(), {
      ...common,
      stopLossPrice: stopLossPrice > 0 ? stopLossPrice : undefined,
      takeProfitPrice: takeProfitPrice > 0 ? takeProfitPrice : undefined
    });
    return Array.isArray(result) ? result : [result].filter(Boolean);
  }

  if (stopLossPrice > 0) {
    placed.push(await adapter.placeConditionalMarketOrder(context(), {
      ...common,
      strategyType: "STOP_MARKET",
      stopPrice: stopLossPrice
    }));
  }

  if (takeProfitPrice > 0) {
    placed.push(await adapter.placeConditionalMarketOrder(context(), {
      ...common,
      strategyType: "TAKE_PROFIT_MARKET",
      stopPrice: takeProfitPrice
    }));
  }

  return placed;
}

async function filledEntryPrice(adapter, symbol, order, fallback = 0) {
  const direct = Number(order?.avgPrice || order?.price || fallback);
  if (Number.isFinite(direct) && direct > 0) return direct;
  try {
    const ticker = await adapter.getTicker(context(), symbol);
    const price = Number(ticker.price);
    if (Number.isFinite(price) && price > 0) return price;
  } catch {
    // Keep fallback below; bracket placement will no-op if it is unusable.
  }
  return Number(fallback) || 0;
}

async function watchFillThenPlaceBracket(adapter, order, bracket) {
  if (!bracket || !order?.orderId) return;
  for (let attempt = 0; attempt < BRACKET_WATCH_MAX_POLLS; attempt += 1) {
    await wait(BRACKET_WATCH_INTERVAL_MS);
    const status = await adapter.queryOrder(context(), { symbol: order.symbol, orderId: order.orderId });
    if (status.status === "FILLED") {
      const entryPrice = Number(status.avgPrice || status.price || bracket.referencePrice);
      const placed = await placeBracketOrders(adapter, bracket, entryPrice);
      log("info", "Bracket orders placed after fill", {
        symbol: bracket.symbol,
        orderId: order.orderId,
        placed: placed.length,
        entryPrice
      });
      return;
    }
    if (["CANCELED", "EXPIRED", "REJECTED"].includes(status.status)) {
      log("warn", "Bracket watcher stopped before fill", {
        symbol: bracket.symbol,
        orderId: order.orderId,
        status: status.status
      });
      return;
    }
  }
  log("warn", "Bracket watcher timed out", { symbol: bracket.symbol, orderId: order.orderId });
}

async function completeChaseFill(adapter, job, orderStatus, source = "poll") {
  if (!job || job.status !== "running") return false;
  job.status = "filled";
  job.updatedAt = new Date().toISOString();
  job.filledAt = job.updatedAt;
  job.fillSource = source;

  const entryPrice = Number(orderStatus.avgPrice || orderStatus.price || job.lastPrice);
  const placed = await placeBracketOrders(adapter, job.bracket, entryPrice);
  log("info", "Pegged limit job filled", {
    jobId: job.id,
    symbol: job.symbol,
    source,
    orderId: job.orderId
  });

  if (placed.length) {
    log("info", "Bracket orders placed after chase fill", {
      jobId: job.id,
      symbol: job.symbol,
      placed: placed.length,
      entryPrice
    });
  }

  if (job.reverseOpen) {
    const openJob = buildChaseJob(job.reverseOpen.payload, job.reverseOpen.intent, {
      adapter,
      bracket: job.reverseOpen.bracket,
      purpose: "reverse-open",
      parentJobId: job.id
    });
    startChaseJob(adapter, openJob);
    log("warn", "Reverse open chase started after close fill", {
      closeJobId: job.id,
      openJobId: openJob.id,
      symbol: openJob.symbol,
      positionSide: openJob.positionSide,
      quantity: openJob.quantity
    });
  }

  return true;
}

function orderIntentKey(symbol, orderId) {
  return `${symbol}:${orderId}`;
}

function rememberOrderIntent(order, intent) {
  if (!order?.orderId) return;
  state.orderIntents.set(orderIntentKey(order.symbol, order.orderId), {
    action: intent.action,
    positionSide: intent.positionSide
  });
}

function decorateOrders(orders) {
  return orders.map((order) => {
    const known = state.orderIntents.get(orderIntentKey(order.symbol, order.orderId));
    if (known) return { ...order, ...known };

    const positionSide = order.positionSide && order.positionSide !== "BOTH"
      ? order.positionSide
      : "";
    const action = order.reduceOnly ? "CLOSE" : "OPEN";
    return { ...order, action, positionSide };
  });
}

function numberValue(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function quoteAssetForSymbol(symbol) {
  const text = String(symbol || "").toUpperCase();
  if (text.endsWith("USDC")) return "USDC";
  if (text.endsWith("USDT")) return "USDT";
  return "USDT";
}

function pickBalance(balances, asset) {
  const target = String(asset || "").toUpperCase();
  return balances.find((balance) => String(balance.asset || "").toUpperCase() === target) || balances[0] || null;
}

function accountSummaryFromBalances(symbol, balances, positions) {
  const asset = quoteAssetForSymbol(symbol);
  const balance = pickBalance(balances, asset);
  const walletBalance = numberValue(balance?.walletBalance ?? balance?.balance);
  const crossWalletBalance = numberValue(balance?.crossWalletBalance, walletBalance);
  const availableBalance = numberValue(
    balance?.availableBalance ?? balance?.maxWithdrawAmount,
    walletBalance
  );
  const balanceUnrealizedPnl = numberValue(balance?.crossUnPnl);
  const positionUnrealizedPnl = positions.reduce((total, position) => (
    total + numberValue(position.unRealizedProfit)
  ), 0);
  const unrealizedPnl = balanceUnrealizedPnl || positionUnrealizedPnl;
  const equity = walletBalance + unrealizedPnl;
  const baselineKey = String(balance?.asset || asset).toUpperCase();

  if (!state.accountBaselines.has(baselineKey)) {
    state.accountBaselines.set(baselineKey, {
      equity,
      walletBalance,
      unrealizedPnl,
      time: new Date().toISOString()
    });
  }

  const baseline = state.accountBaselines.get(baselineKey);
  return {
    asset: balance?.asset || asset,
    walletBalance,
    crossWalletBalance,
    availableBalance,
    unrealizedPnl,
    equity,
    sessionPnl: equity - baseline.equity,
    baselineEquity: baseline.equity,
    baselineAt: baseline.time,
    sessionStartedAt: state.sessionStartTime
  };
}

async function buildAccountSummary(adapter, symbol) {
  const [balances, positions] = await Promise.all([
    adapter.getBalances(context()),
    adapter.getPositions(context(), symbol || undefined)
  ]);
  return accountSummaryFromBalances(symbol, balances, positions);
}

function jobSnapshot(job) {
  return {
    id: job.id,
    symbol: job.symbol,
    action: job.action,
    side: job.side,
    quantity: job.quantity,
    positionSide: job.positionSide,
    orderType: "LIMIT",
    timeInForce: job.postOnly ? "GTX" : "GTC",
    pegSide: job.side === "BUY" ? "best bid" : "best ask",
    tickOffset: job.tickOffset,
    postOnly: job.postOnly,
    updateMs: job.updateMs,
    effectiveUpdateMs: job.effectiveUpdateMs || job.updateMs,
    maxReplaces: job.maxChases,
    purpose: job.purpose || "chase",
    parentJobId: job.parentJobId || "",
    bracket: job.bracket ? {
      stopLossAmount: job.bracket.stopLossAmount,
      takeProfitAmount: job.bracket.takeProfitAmount
    } : null,
    reverseOpen: job.reverseOpen ? {
      symbol: job.reverseOpen.payload.symbol,
      action: job.reverseOpen.intent.action,
      positionSide: job.reverseOpen.intent.positionSide,
      quantity: job.reverseOpen.payload.quantity
    } : null,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    iterations: job.iterations,
    lastPrice: job.lastPrice,
    marketSource: job.marketSource || "",
    pendingPrice: job.pendingPrice || "",
    nextReplaceAt: job.nextReplaceAt ? new Date(job.nextReplaceAt).toISOString() : "",
    lastWakeSource: job.lastWakeSource || "",
    replaceStrategy: job.replaceStrategy || "cancel-replace",
    replaceCount: job.replaceCount || 0,
    lastReplaceSentAt: job.lastReplaceSentAt || "",
    lastReplaceAckAt: job.lastReplaceAckAt || "",
    lastReplaceLatencyMs: job.lastReplaceLatencyMs || 0,
    lastReplaceTotalMs: job.lastReplaceTotalMs || 0,
    orderOpsPerReplace: job.orderOpsPerReplace || CHASE_ORDER_OPS_PER_REPLACE,
    rateLimitWindowMs: job.rateLimitWindowMs || 10_000,
    rateGateWaitMs: job.rateGateWaitMs || 0,
    restFallbackUpdateMs: job.restFallbackUpdateMs || job.updateMs,
    statusCheckMs: job.statusCheckMs || 1000,
    statusPollWithPrivateStream: job.statusPollWithPrivateStream !== false,
    statusSource: job.statusSource || "",
    fillSource: job.fillSource || "",
    filledAt: job.filledAt || "",
    orderId: job.orderId,
    error: job.error || "",
    backoffMs: job.backoffMs || 0,
    mode: job.mode
  };
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function clampChaseInterval(value, minUpdateMs = CHASE_MIN_UPDATE_MS) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return CHASE_UPDATE_MS;
  return Math.max(minUpdateMs, numeric);
}

function runningChaseJobCount() {
  return Math.max(1, Array.from(state.chaseJobs.values()).filter((job) => job.status === "running").length);
}

function chaseRateLimitWindowCapacity(job) {
  const windowMs = Math.max(100, Number(job.rateLimitWindowMs || 10_000));
  const limitPer10s = Math.max(1, Number(job.rateLimit10sOrders || CHASE_RATE_LIMIT_10S_ORDERS));
  const safety = Math.min(1, Math.max(0.1, Number(job.rateLimitSafety || CHASE_RATE_LIMIT_SAFETY)));
  return Math.max(1, Math.floor((limitPer10s * windowMs * safety) / 10_000));
}

function rateLimitAdjustedChaseInterval(job) {
  const windowMs = Math.max(100, Number(job.rateLimitWindowMs || 10_000));
  const allowedOrders = chaseRateLimitWindowCapacity(job);
  const activeJobs = runningChaseJobCount();
  const orderOpsPerReplace = Math.max(1, Number(job.orderOpsPerReplace || CHASE_ORDER_OPS_PER_REPLACE));
  const minByOrderLimit = Math.ceil((windowMs * orderOpsPerReplace * activeJobs) / allowedOrders);
  return Math.max(job.updateMs, minByOrderLimit);
}

function isTransientExchangeError(error) {
  if (!(error instanceof ExchangeError)) {
    return /fetch|network|timeout|terminated|reset/i.test(error.message || "");
  }
  const status = Number(error.details?.status);
  const code = Number(error.details?.code);
  return (
    status === 418 ||
    status === 429 ||
    status >= 500 ||
    code === -1003 ||
    code === -1007 ||
    code === -1021
  );
}

function retryDelayFor(error, transientErrors, baseDelayMs) {
  const retryAfterMs = Number(error.details?.retryAfterMs || 0);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(CHASE_MAX_BACKOFF_MS, retryAfterMs + CHASE_RETRY_PAD_MS);
  }
  const exponent = Math.min(5, Math.max(0, transientErrors - 1));
  return Math.min(CHASE_MAX_BACKOFF_MS, baseDelayMs * 2 ** exponent);
}

function chaseRateLimitKey(job) {
  return `${state.exchangeId}:${state.mode}:order-mutation`;
}

async function waitForChaseOrderSlot(job, ops = 1) {
  const key = chaseRateLimitKey(job);
  const windowMs = Math.max(100, Number(job.rateLimitWindowMs || 10_000));
  const capacity = chaseRateLimitWindowCapacity(job);
  const requestedOps = Math.max(1, Number(ops) || 1);
  if (requestedOps > capacity) {
    throw new ExchangeError(`Order-rate capacity ${capacity} is below requested operation count ${requestedOps}`, {
      transient: true
    });
  }

  while (job.status === "running") {
    const nowMs = Date.now();
    const timestamps = state.orderRateLimit.get(key) || [];
    while (timestamps.length && nowMs - timestamps[0] >= windowMs) {
      timestamps.shift();
    }

    if (timestamps.length + requestedOps <= capacity) {
      for (let index = 0; index < requestedOps; index += 1) {
        timestamps.push(nowMs);
      }
      state.orderRateLimit.set(key, timestamps);
      job.rateGateWaitMs = 0;
      return 0;
    }

    const delayMs = Math.max(1, windowMs - (nowMs - timestamps[0]));
    job.rateGateWaitMs = delayMs;
    state.orderRateLimit.set(key, timestamps);
    await wait(delayMs);
  }

  throw new ExchangeError("Pegged limit job stopped before an order-rate slot opened", {
    stopped: true
  });
}

async function sendTimedOrderMutation(job, ops, action) {
  const requestedAt = Date.now();
  await waitForChaseOrderSlot(job, ops);
  const sentAt = Date.now();
  const result = await action();
  const ackAt = Date.now();
  return {
    result,
    sentAt,
    ackAt,
    latencyMs: ackAt - sentAt,
    totalMs: ackAt - requestedAt
  };
}

async function submitChaseLimitOrder(adapter, job, targetPrice) {
  const orderPayload = {
    symbol: job.symbol,
    side: job.side,
    positionSide: job.apiPositionSide,
    reduceOnly: job.reduceOnly,
    quantity: job.quantity,
    price: targetPrice,
    timeInForce: job.postOnly ? "GTX" : "GTC"
  };

  if (job.orderId && adapter.replaceLimitOrder) {
    const timed = await sendTimedOrderMutation(job, 1, () => (
      adapter.replaceLimitOrder(context(), {
        ...orderPayload,
        orderId: job.orderId
      })
    ));
    return { order: timed.result, strategy: "edit-order", telemetry: timed };
  }

  if (job.orderId) {
    const requestedAt = Date.now();
    const cancelTimed = await sendTimedOrderMutation(job, 1, () => (
      adapter.cancelOrder(context(), { symbol: job.symbol, orderId: job.orderId })
    ));
    const placeTimed = await sendTimedOrderMutation(job, 1, () => adapter.placeLimitOrder(context(), orderPayload));
    return {
      order: placeTimed.result,
      strategy: "cancel-replace",
      telemetry: {
        sentAt: cancelTimed.sentAt,
        ackAt: placeTimed.ackAt,
        latencyMs: placeTimed.ackAt - cancelTimed.sentAt,
        totalMs: placeTimed.ackAt - requestedAt
      }
    };
  } else {
    const timed = await sendTimedOrderMutation(job, 1, () => adapter.placeLimitOrder(context(), orderPayload));
    return { order: timed.result, strategy: "place", telemetry: timed };
  }
}

async function waitForChaseWake(adapter, job, wsDriven, timeoutMs) {
  const waitMs = Math.max(1, Number(timeoutMs) || job.updateMs || 1000);
  if (wsDriven && adapter.waitForMarketTick) {
    const wake = await adapter.waitForMarketTick(context(), job.symbol, waitMs);
    job.lastWakeSource = wake.source || "";
    return wake;
  }
  await wait(waitMs);
  job.lastWakeSource = "timer";
  return { symbol: job.symbol, source: "timer", time: Date.now() };
}

async function applyChaseReplace(adapter, job, targetPrice, marketSource, effectiveIntervalMs) {
  const { order, strategy, telemetry } = await submitChaseLimitOrder(adapter, job, targetPrice);
  job.orderId = order.orderId || job.orderId;
  job.replaceStrategy = strategy;
  rememberOrderIntent(order, job);
  job.lastPrice = targetPrice;
  job.pendingPrice = "";
  job.nextReplaceAt = Date.now() + effectiveIntervalMs;
  job.replaceCount += 1;
  job.lastReplaceSentAt = new Date(telemetry.sentAt).toISOString();
  job.lastReplaceAckAt = new Date(telemetry.ackAt).toISOString();
  job.lastReplaceLatencyMs = telemetry.latencyMs;
  job.lastReplaceTotalMs = telemetry.totalMs;
  log("info", "Pegged limit order replaced", {
    jobId: job.id,
    symbol: job.symbol,
    side: job.side,
    timeInForce: job.postOnly ? "GTX" : "GTC",
    targetPrice,
    strategy,
    marketSource,
    ackMs: telemetry.latencyMs,
    totalMs: telemetry.totalMs,
    gateMs: job.rateGateWaitMs,
    intervalMs: effectiveIntervalMs
  });
  return order;
}

function accountStreamStatusPayload(extra = {}) {
  return {
    enabled: ACCOUNT_STREAM_ENABLED,
    status: state.accountStream.status,
    lastEventTime: state.accountStream.lastEventTime,
    lastError: state.accountStream.lastError,
    sequence: state.accountStream.sequence,
    refreshMs: ACCOUNT_REFRESH_MS,
    ...extra
  };
}

function writeSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastAccountEvent(event, payload = {}) {
  state.accountStream.sequence += 1;
  const body = {
    ...accountStreamStatusPayload(),
    ...payload,
    sequence: state.accountStream.sequence
  };
  for (const client of state.accountStream.clients) {
    writeSse(client.res, event, body);
  }
}

function scheduleAccountStreamReconnect(reason = "reconnect") {
  if (!ACCOUNT_STREAM_ENABLED || state.mode === "dry-run") return;
  if (state.accountStream.reconnectTimer) return;
  state.accountStream.status = "reconnecting";
  state.accountStream.lastError = reason;
  broadcastAccountEvent("stream-status", accountStreamStatusPayload());
  state.accountStream.reconnectTimer = setTimeout(() => {
    state.accountStream.reconnectTimer = null;
    startAccountUserStream().catch((error) => {
      log("warn", "Account stream reconnect failed", { error: error.message });
      scheduleAccountStreamReconnect(error.message);
    });
  }, ACCOUNT_STREAM_RECONNECT_MS);
}

function closeAccountUserStreamSocket() {
  if (state.accountStream.keepAliveTimer) {
    clearInterval(state.accountStream.keepAliveTimer);
    state.accountStream.keepAliveTimer = null;
  }
  const ws = state.accountStream.ws;
  state.accountStream.ws = null;
  if (ws && ws.readyState < 2) {
    ws.close();
  }
}

function parseWsPayload(raw) {
  try {
    return typeof raw === "object" && raw !== null && !Buffer.isBuffer(raw)
      ? raw
      : JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function sendWsJson(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

function privateAccountStreamActive() {
  return (
    ACCOUNT_STREAM_ENABLED &&
    state.accountStream.status === "connected" &&
    state.accountStream.ws?.readyState === WebSocket.OPEN
  );
}

function privateStreamEventTime(payload, data) {
  const timestamp = data.E || data.timestamp || payload.ts || Date.now();
  return new Date(Number(timestamp)).toISOString();
}

function findRunningChaseJobForOrderUpdate(update) {
  if (!update?.orderId) return null;
  return Array.from(state.chaseJobs.values()).find((job) => (
    job.status === "running" &&
    String(job.orderId) === String(update.orderId) &&
    (!update.symbol || job.symbol === update.symbol)
  )) || null;
}

async function handlePrivateOrderUpdate(payload, source) {
  const update = extractPrivateOrderUpdate(payload);
  if (!update) return;
  const job = findRunningChaseJobForOrderUpdate(update);
  if (!job) return;
  job.statusSource = source;

  if (update.status === "FILLED") {
    const adapter = getExchange(state.exchangeId);
    await completeChaseFill(adapter, job, update, source);
  }
}

function sendAccountSubscriptions(ws, subscriptions = []) {
  for (const topic of subscriptions) {
    sendWsJson(ws, {
      id: `acct_${Date.now()}_${String(topic).replace(/[^a-z0-9]/gi, "")}`,
      topic,
      event: "subscribe"
    });
  }
}

async function handleAccountStreamMessage(raw) {
  const payload = parseWsPayload(raw);
  if (!payload) return;

  const topic = String(payload.topic || "");
  const orderlyPrivateTopic = ["executionreport", "position", "balance", "account", "wallet"]
    .some((name) => topic === name || topic.startsWith(`${name}@`));
  if (orderlyPrivateTopic) {
    const data = payload.data || {};
    const eventTime = privateStreamEventTime(payload, data);
    state.accountStream.lastEventTime = eventTime;
    state.accountStream.lastError = "";
    await handlePrivateOrderUpdate(payload, "private-ws");
    broadcastAccountEvent("account-dirty", {
      eventType: topic,
      eventTime,
      symbol: uiSymbolFromExchangeSymbol(data.symbol || ""),
      status: data.status || ""
    });
    return;
  }

  const data = payload.data || payload;
  const eventType = data.e || data.eventType || "";
  if (!eventType) return;

  if (eventType === "listenKeyExpired") {
    closeAccountUserStreamSocket();
    scheduleAccountStreamReconnect("listenKey expired");
    return;
  }

  if (eventType === "ACCOUNT_UPDATE" || eventType === "ORDER_TRADE_UPDATE" || eventType === "MARGIN_CALL") {
    const eventTime = data.E ? new Date(Number(data.E)).toISOString() : new Date().toISOString();
    state.accountStream.lastEventTime = eventTime;
    state.accountStream.lastError = "";
    await handlePrivateOrderUpdate(payload, "private-ws");
    broadcastAccountEvent("account-dirty", {
      eventType,
      eventTime,
      reason: data.a?.m || ""
    });
  }
}

async function startAccountUserStream() {
  if (!ACCOUNT_STREAM_ENABLED) {
    state.accountStream.status = "disabled";
    return;
  }
  if (state.mode === "dry-run") {
    state.accountStream.status = "rest-fallback";
    return;
  }
  if (state.accountStream.ws) return;

  const adapter = getExchange(state.exchangeId);
  if (!adapter.createUserDataStream) {
    state.accountStream.status = "unavailable";
    state.accountStream.lastError = "Exchange adapter does not support account stream";
    return;
  }
  if (!hasActiveApiKey()) {
    state.accountStream.status = "missing-api-key";
    return;
  }
  if (typeof WebSocket === "undefined") {
    state.accountStream.status = "rest-fallback";
    state.accountStream.lastError = "Node WebSocket runtime is unavailable";
    return;
  }

  state.accountStream.status = "connecting";
  broadcastAccountEvent("stream-status", accountStreamStatusPayload());
  const stream = await adapter.createUserDataStream(context());
  state.accountStream.listenKey = stream.listenKey;
  const ws = new WebSocket(stream.streamUrl);
  state.accountStream.ws = ws;

  ws.addEventListener("open", () => {
    state.accountStream.status = "connected";
    state.accountStream.lastError = "";
    log("info", "Account stream connected", { accountMode: activeAccountMode() });
    broadcastAccountEvent("stream-status", accountStreamStatusPayload());
    sendAccountSubscriptions(ws, stream.subscriptions || []);
    if (stream.pingIntervalMs) {
      state.accountStream.keepAliveTimer = setInterval(() => {
        sendWsJson(ws, { event: "ping" });
      }, stream.pingIntervalMs);
    } else if (adapter.keepAliveUserDataStream) {
      state.accountStream.keepAliveTimer = setInterval(() => {
        adapter.keepAliveUserDataStream(context()).catch((error) => {
          state.accountStream.lastError = error.message;
          log("warn", "Account stream keepalive failed", { error: error.message });
          broadcastAccountEvent("stream-status", accountStreamStatusPayload());
        });
      }, ACCOUNT_STREAM_KEEPALIVE_MS);
    }
  });

  ws.addEventListener("message", (event) => {
    const payload = parseWsPayload(event.data);
    if (!payload) return;
    if (payload.event === "ping") {
      sendWsJson(ws, { event: "pong" });
      return;
    }
    if (payload.event === "pong") return;
    handleAccountStreamMessage(payload).catch((error) => {
      state.accountStream.lastError = error.message;
      log("warn", "Account stream message handling failed", { error: error.message });
      broadcastAccountEvent("stream-status", accountStreamStatusPayload());
    });
  });

  ws.addEventListener("error", () => {
    state.accountStream.lastError = "Account stream websocket error";
    broadcastAccountEvent("stream-status", accountStreamStatusPayload());
  });

  ws.addEventListener("close", () => {
    if (state.accountStream.ws === ws) {
      closeAccountUserStreamSocket();
      log("warn", "Account stream disconnected", { accountMode: activeAccountMode() });
      scheduleAccountStreamReconnect("websocket closed");
    }
  });
}

async function runChaseJob(adapter, job) {
  try {
    const symbolInfo = await adapter.getSymbol(context(), job.symbol);
    let transientErrors = 0;
    while (job.status === "running" && job.iterations < job.maxChases) {
      try {
        const book = await adapter.getOrderBook(context(), { symbol: job.symbol, limit: 5 });
        const marketSource = book.source || "rest";
        job.marketSource = marketSource;
        const bestBid = Number(book.bids?.[0]?.[0]);
        const bestAsk = Number(book.asks?.[0]?.[0]);
        if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) {
          throw new ExchangeError("Order book does not have usable bid/ask data", {
            transient: true
          });
        }

        const rawTarget = job.side === "BUY" ? bestBid : bestAsk;
        const targetPrice = adapter.roundPriceForSide(symbolInfo, job.side, rawTarget, job.tickOffset, job.postOnly);
        const wsDriven = String(marketSource).startsWith("ws");
        const effectiveIntervalMs = wsDriven
          ? rateLimitAdjustedChaseInterval(job)
          : Math.max(rateLimitAdjustedChaseInterval(job), job.restFallbackUpdateMs || job.updateMs);
        job.effectiveUpdateMs = effectiveIntervalMs;
        const nowMs = Date.now();
        const replaceCooldownMs = Math.max(0, Number(job.nextReplaceAt || 0) - nowMs);
        const targetChanged = targetPrice !== job.lastPrice;
        const shouldReplace = targetChanged && replaceCooldownMs === 0;
        if (targetChanged && !shouldReplace) {
          job.pendingPrice = targetPrice;
        }

        if (shouldReplace) {
          await applyChaseReplace(adapter, job, targetPrice, marketSource, effectiveIntervalMs);
        }

        const shouldUseRestStatus = job.statusPollWithPrivateStream || !privateAccountStreamActive();
        const shouldCheckStatus = (
          job.orderId &&
          shouldUseRestStatus &&
          Date.now() - Number(job.lastStatusCheckAt || 0) >= job.statusCheckMs
        );
        if (shouldCheckStatus) {
          job.lastStatusCheckAt = Date.now();
          job.statusSource = "rest-poll";
          const orderStatus = await adapter.queryOrder(context(), { symbol: job.symbol, orderId: job.orderId });
          if (orderStatus.status === "FILLED") {
            await completeChaseFill(adapter, job, orderStatus, "rest-poll");
            break;
          }
        }

        transientErrors = 0;
        job.error = "";
        job.backoffMs = 0;
        job.iterations += 1;
        job.updatedAt = new Date().toISOString();
        const cooldownMs = Math.max(0, Number(job.nextReplaceAt || 0) - Date.now());
        if (cooldownMs > 0) {
          await wait(cooldownMs);
        }
        if (job.pendingPrice && job.pendingPrice !== job.lastPrice) {
          job.lastWakeSource = "pending";
          continue;
        }
        await waitForChaseWake(
          adapter,
          job,
          wsDriven,
          wsDriven ? job.restFallbackUpdateMs || effectiveIntervalMs : effectiveIntervalMs
        );
      } catch (error) {
        const transient = error.details?.transient || isTransientExchangeError(error);
        if (!transient) throw error;

        transientErrors += 1;
        const delayMs = retryDelayFor(error, transientErrors, job.updateMs);
        job.error = `Transient exchange response: ${error.message}`;
        job.backoffMs = delayMs;
        job.updatedAt = new Date().toISOString();
        log("warn", "Pegged limit job backing off", {
          jobId: job.id,
          symbol: job.symbol,
          status: error.details?.status,
          code: error.details?.code,
          delayMs,
          transientErrors
        });

        if (transientErrors >= CHASE_MAX_TRANSIENT_ERRORS) {
          throw new ExchangeError("Pegged limit job stopped after repeated transient exchange responses", {
            lastError: error.message,
            status: error.details?.status,
            code: error.details?.code
          });
        }

        await wait(delayMs);
      }
    }

    if (job.status === "running") {
      job.status = "done";
      job.updatedAt = new Date().toISOString();
      log("info", "Pegged limit job finished", { jobId: job.id, symbol: job.symbol, iterations: job.iterations });
    }
  } catch (error) {
    if (error.details?.stopped && job.status !== "running") {
      if (job.status === "stopping") job.status = "stopped";
      job.updatedAt = new Date().toISOString();
      return;
    }
    job.status = "error";
    job.error = error.message;
    job.updatedAt = new Date().toISOString();
    log("error", "Pegged limit job failed", { jobId: job.id, error: error.message });
  }
}

async function handleApi(req, res, pathname, searchParams) {
  if (req.method === "GET" && pathname === "/api/session") {
    json(res, 200, publicSession());
    return;
  }

  if (req.method === "POST" && pathname === "/api/session") {
    throw new ExchangeError("Session is managed by .env.session. Edit the file and restart the server.");
    return;
  }

  const adapter = getExchange(state.exchangeId);

  if (req.method === "GET" && pathname === "/api/symbols") {
    json(res, 200, { symbols: await adapter.getSymbols(context()) });
    return;
  }

  if (req.method === "GET" && pathname === "/api/market/price") {
    json(res, 200, await adapter.getTicker(context(), searchParams.get("symbol") || "BTCUSDT"));
    return;
  }

  if (req.method === "POST" && pathname === "/api/market/focus") {
    const body = await readBody(req);
    const symbol = String(body.symbol || searchParams.get("symbol") || "BTCUSDT").toUpperCase();
    const interval = String(body.interval || searchParams.get("interval") || "15s");
    const retainedJobSymbols = activeChaseSymbols().filter((jobSymbol) => jobSymbol !== symbol);
    const focused = adapter.focusMarketDataStream
      ? adapter.focusMarketDataStream(context(), {
        symbol,
        interval,
        retainSymbols: retainedJobSymbols
      })
      : false;
    json(res, 200, {
      focused,
      marketStream: adapter.marketDataStreamStatus?.() || null
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/market/klines") {
    json(res, 200, {
      klines: await adapter.getKlines(context(), {
        symbol: searchParams.get("symbol") || "BTCUSDT",
        interval: searchParams.get("interval") || "15s",
        limit: Number(searchParams.get("limit") || 180)
      })
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/market/orderbook") {
    json(res, 200, {
      orderBook: await adapter.getOrderBook(context(), {
        symbol: searchParams.get("symbol") || "BTCUSDT",
        limit: Number(searchParams.get("limit") || 20)
      })
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/account/leverage-bracket") {
    const symbol = searchParams.get("symbol") || "BTCUSDC";
    try {
      json(res, 200, await adapter.getLeverageBracket(context(), symbol));
    } catch (error) {
      log("warn", "Leverage bracket fallback used", {
        symbol,
        error: error.message
      });
      json(res, 200, {
        symbol,
        maxLeverage: 125,
        brackets: [],
        fallback: true
      });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/account/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive"
    });
    const client = {
      res,
      heartbeat: setInterval(() => {
        writeSse(res, "ping", accountStreamStatusPayload({ time: new Date().toISOString() }));
      }, 25_000)
    };
    state.accountStream.clients.add(client);
    writeSse(res, "stream-status", accountStreamStatusPayload());
    req.on("close", () => {
      clearInterval(client.heartbeat);
      state.accountStream.clients.delete(client);
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/account/snapshot") {
    const symbol = searchParams.get("symbol") || "BTCUSDC";
    const [positions, openOrders, balances] = await Promise.all([
      adapter.getPositions(context(), symbol),
      adapter.getOpenOrders(context(), symbol),
      adapter.getBalances(context())
    ]);
    json(res, 200, {
      positions,
      orders: decorateOrders(openOrders),
      summary: accountSummaryFromBalances(symbol, balances, positions),
      jobs: Array.from(state.chaseJobs.values()).map(jobSnapshot)
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/account/positions") {
    json(res, 200, { positions: await adapter.getPositions(context(), searchParams.get("symbol") || undefined) });
    return;
  }

  if (req.method === "GET" && pathname === "/api/account/summary") {
    json(res, 200, await buildAccountSummary(adapter, searchParams.get("symbol") || "BTCUSDC"));
    return;
  }

  if (req.method === "GET" && pathname === "/api/account/open-orders") {
    const orders = await adapter.getOpenOrders(context(), searchParams.get("symbol") || undefined);
    json(res, 200, { orders: decorateOrders(orders) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/trade/leverage") {
    requireLiveGuard("Set leverage");
    const body = await readBody(req);
    const result = await adapter.setLeverage(context(), {
      symbol: body.symbol,
      leverage: Number(body.leverage)
    });
    log("info", "Leverage updated", { symbol: body.symbol, leverage: Number(body.leverage), mode: state.mode });
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && pathname === "/api/trade/limit-order") {
    requireLiveGuard("Limit order");
    const body = await readBody(req);
    const intent = buildOrderIntent(body);
    const bracket = buildBracketConfig(body, intent);
    if (body.leverage) {
      await adapter.setLeverage(context(), { symbol: body.symbol, leverage: Number(body.leverage) });
    }
    const result = await adapter.placeLimitOrder(context(), {
      ...body,
      side: intent.side,
      positionSide: intent.apiPositionSide,
      reduceOnly: intent.reduceOnly,
      timeInForce: ORDER_POST_ONLY ? "GTX" : "GTC"
    });
    rememberOrderIntent(result, intent);
    if (bracket) {
      watchFillThenPlaceBracket(adapter, result, bracket).catch((error) => {
        log("error", "Bracket watcher failed", {
          symbol: bracket.symbol,
          orderId: result.orderId,
          error: error.message
        });
      });
    }
    log("info", "Limit order submitted", {
      symbol: body.symbol,
      action: intent.action,
      positionSide: intent.positionSide,
      side: intent.side,
      mode: state.mode,
      orderId: result.orderId
    });
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && pathname === "/api/trade/market-order") {
    requireLiveGuard("Market order");
    const body = await readBody(req);
    const intent = buildOrderIntent(body);
    const bracket = buildBracketConfig(body, intent);
    if (body.leverage) {
      await adapter.setLeverage(context(), { symbol: body.symbol, leverage: Number(body.leverage) });
    }
    const result = await adapter.placeMarketOrder(context(), {
      ...body,
      action: intent.action,
      side: intent.side,
      positionSide: intent.apiPositionSide,
      reduceOnly: intent.reduceOnly
    });
    rememberOrderIntent(result, intent);
    const entryPrice = await filledEntryPrice(adapter, body.symbol, result, body.price);
    const placed = await placeBracketOrders(adapter, bracket, entryPrice);
    log("warn", "FAST market order submitted", {
      symbol: body.symbol,
      action: intent.action,
      positionSide: intent.positionSide,
      side: intent.side,
      mode: state.mode,
      orderId: result.orderId,
      bracketOrders: placed.length
    });
    json(res, 200, { ...result, bracketOrders: placed.length });
    return;
  }

  if (req.method === "POST" && pathname === "/api/trade/cancel-all") {
    requireLiveGuard("Cancel all orders");
    const body = await readBody(req);
    const result = await adapter.cancelAllOpenOrders(context(), body.symbol);
    log("warn", "All open orders canceled", { symbol: body.symbol, mode: state.mode });
    json(res, 200, result);
    return;
  }

  if (req.method === "POST" && pathname === "/api/trade/emergency-close") {
    requireLiveGuard("Emergency close");
    const body = await readBody(req);
    requireConfirm(body, "CLOSE_NOW", "Emergency close");
    const symbol = body.all ? undefined : body.symbol;
    if (symbol) {
      await adapter.cancelAllOpenOrders(context(), symbol);
    } else {
      const [positions, openOrders] = await Promise.all([
        adapter.getPositions(context()),
        adapter.getOpenOrders(context())
      ]);
      const symbolsToCancel = new Set([
        ...positions.map((position) => position.symbol),
        ...openOrders.map((order) => order.symbol)
      ]);
      for (const item of symbolsToCancel) {
        await adapter.cancelAllOpenOrders(context(), item);
      }
    }
    const results = await adapter.closePositions(context(), { symbol });
    log("warn", "Emergency close executed", { symbol: symbol || "ALL", closed: results.length, mode: state.mode });
    json(res, 200, { closed: results });
    return;
  }

  if (req.method === "POST" && pathname === "/api/trade/reverse") {
    requireLiveGuard("Reverse position");
    const body = await readBody(req);
    const symbol = String(body.symbol || "").toUpperCase();
    if (!symbol) throw new ExchangeError("Reverse requires a symbol");

    const selectedSide = String(body.positionSide || "LONG").toUpperCase();
    if (!["LONG", "SHORT"].includes(selectedSide)) {
      throw new ExchangeError(`Unsupported reverse position side "${selectedSide}"`);
    }

    const positions = await adapter.getPositions(context(), symbol);
    const position = findPositionForReverse(positions, selectedSide);
    if (!position) {
      throw new ExchangeError(`No active ${selectedSide} position to reverse for ${symbol}`);
    }

    const quantity = absPositionQty(position);
    if (!quantity) {
      throw new ExchangeError(`No usable ${selectedSide} position quantity to reverse for ${symbol}`);
    }

    if (body.leverage) {
      await adapter.setLeverage(context(), { symbol, leverage: Number(body.leverage) });
    }
    await adapter.cancelAllOpenOrders(context(), symbol);

    const closePayload = {
      ...body,
      symbol,
      action: "CLOSE",
      positionSide: selectedSide,
      quantity: String(quantity)
    };
    const closeIntent = buildOrderIntent(closePayload);
    const openSide = oppositePositionSide(selectedSide);
    const openPayload = {
      ...body,
      symbol,
      action: "OPEN",
      positionSide: openSide,
      quantity: String(quantity)
    };
    const openIntent = buildOrderIntent(openPayload);
    const openBracket = buildBracketConfig(openPayload, openIntent);

    if (String(body.executionMode || "").toUpperCase() === "MARKET") {
      const closeOrder = await adapter.placeMarketOrder(context(), {
        ...closePayload,
        action: closeIntent.action,
        side: closeIntent.side,
        positionSide: closeIntent.apiPositionSide,
        reduceOnly: closeIntent.reduceOnly
      });
      rememberOrderIntent(closeOrder, closeIntent);

      const openOrder = await adapter.placeMarketOrder(context(), {
        ...openPayload,
        action: openIntent.action,
        side: openIntent.side,
        positionSide: openIntent.apiPositionSide,
        reduceOnly: openIntent.reduceOnly
      });
      rememberOrderIntent(openOrder, openIntent);

      const entryPrice = await filledEntryPrice(adapter, symbol, openOrder, body.price);
      const placed = await placeBracketOrders(adapter, openBracket, entryPrice);
      log("warn", "FAST reverse executed", {
        symbol,
        from: selectedSide,
        to: openSide,
        quantity: String(quantity),
        closeOrderId: closeOrder.orderId,
        openOrderId: openOrder.orderId,
        bracketOrders: placed.length,
        mode: state.mode
      });
      json(res, 200, {
        mode: "MARKET",
        closed: closeOrder,
        opened: openOrder,
        bracketOrders: placed.length
      });
      return;
    }

    const closeJob = startChaseJob(adapter, buildChaseJob(closePayload, closeIntent, {
      adapter,
      purpose: "reverse-close",
      reverseOpen: {
        payload: openPayload,
        intent: openIntent,
        bracket: openBracket
      }
    }));

    log("warn", "Reverse chase queued", {
      closeJobId: closeJob.id,
      symbol,
      from: selectedSide,
      to: openSide,
      quantity: String(quantity),
      bracket: Boolean(openBracket),
      mode: state.mode
    });
    json(res, 200, jobSnapshot(closeJob));
    return;
  }

  if (req.method === "GET" && pathname === "/api/trade/chase/jobs") {
    json(res, 200, { jobs: Array.from(state.chaseJobs.values()).map(jobSnapshot) });
    return;
  }

  if (req.method === "POST" && pathname === "/api/trade/chase/start") {
    requireLiveGuard("Pegged limit order");
    const body = await readBody(req);
    const intent = buildOrderIntent(body);
    const bracket = buildBracketConfig(body, intent);
    if (body.leverage) {
      await adapter.setLeverage(context(), { symbol: body.symbol, leverage: Number(body.leverage) });
    }
    const job = startChaseJob(adapter, buildChaseJob(body, intent, { adapter, bracket }));
    json(res, 200, jobSnapshot(job));
    return;
  }

  if (req.method === "POST" && pathname === "/api/trade/chase/stop") {
    const body = await readBody(req);
    const job = state.chaseJobs.get(body.jobId);
    if (!job) throw new ExchangeError("Pegged limit job not found");
    job.status = "stopping";
    job.updatedAt = new Date().toISOString();
    if (body.cancelOrder !== false && job.orderId) {
      await adapter.cancelOrder(context(), { symbol: job.symbol, orderId: job.orderId });
    }
    job.status = "stopped";
    log("warn", "Pegged limit job stopped", { jobId: job.id, symbol: job.symbol });
    json(res, 200, jobSnapshot(job));
    return;
  }

  if (req.method === "GET" && pathname === "/api/logs") {
    json(res, 200, { logs: state.logs });
    return;
  }

  notFound(res);
}

async function handle(req, res) {
  const { pathname, searchParams } = parseQuery(req);
  try {
    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname, searchParams);
      return;
    }
    serveStatic(req, res, pathname);
  } catch (error) {
    const status = error instanceof ExchangeError ? 400 : 500;
    log("error", error.message, error.details || {});
    json(res, status, {
      error: error.message,
      details: error.details || {}
    });
  }
}

const server = http.createServer(handle);

logEnvFileDetection();

server.listen(PORT, "127.0.0.1", () => {
  log("info", `Semi-auto CEX terminal listening on http://127.0.0.1:${PORT}`, {
    mode: state.mode,
    exchangeId: state.exchangeId,
    hasApiKey: hasActiveApiKey()
  });
  startAccountUserStream().catch((error) => {
    state.accountStream.status = "rest-fallback";
    state.accountStream.lastError = error.message;
    log("warn", "Account stream unavailable; using REST fallback", { error: error.message });
  });
});
