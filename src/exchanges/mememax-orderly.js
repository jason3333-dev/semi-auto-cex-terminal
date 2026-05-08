import crypto from "node:crypto";
import { ExchangeError, ORDER_SIDES, POSITION_SIDES } from "./types.js";

const MAINNET_BASE_URL = "https://api.orderly.org";
const TESTNET_BASE_URL = "https://testnet-api.orderly.org";
const MAINNET_PUBLIC_WS_BASE_URL = "wss://ws-evm.orderly.org/ws/stream";
const TESTNET_PUBLIC_WS_BASE_URL = "wss://testnet-ws-evm.orderly.org/ws/stream";
const MAINNET_PRIVATE_WS_BASE_URL = "wss://ws-private-evm.orderly.org/v2/ws/private/stream";
const TESTNET_PRIVATE_WS_BASE_URL = "wss://testnet-ws-private-evm.orderly.org/v2/ws/private/stream";
const FIFTEEN_SECONDS_MS = 15_000;
const ORDERLY_KEY_PREFIX = "ed25519:";
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEXES = new Map([...BASE58_ALPHABET].map((char, index) => [char, index]));
const ORDERLY_WS_KLINE_INTERVALS = new Set(["1m", "5m", "15m", "30m", "1h", "1d", "1w", "1M"]);

function now() {
  return Date.now();
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nonZero(value) {
  return Math.abs(toNumber(value)) > 0;
}

function trimDecimal(value) {
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString("en-US", {
    useGrouping: false,
    maximumFractionDigits: 12
  });
}

function envNumber(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envRatio(name, fallback) {
  return Math.min(1, Math.max(0.1, envNumber(name, fallback)));
}

function decimalPlaces(value) {
  const text = String(value);
  if (text.includes("e-")) {
    return Number(text.split("e-")[1]) || 0;
  }
  const decimals = text.split(".")[1] || "";
  return decimals.replace(/0+$/, "").length;
}

function roundToStep(value, step, mode = "nearest") {
  const numericStep = toNumber(step, 0);
  if (!numericStep) return trimDecimal(value);
  const scale = 10 ** Math.min(12, decimalPlaces(step));
  const scaledStep = Math.max(1, Math.round(numericStep * scale));
  const units = (value * scale) / scaledStep;
  let rounded = units;
  if (mode === "up") rounded = Math.ceil(units - 1e-9);
  else if (mode === "down") rounded = Math.floor(units + 1e-9);
  else rounded = Math.round(units);
  return trimDecimal((rounded * scaledStep) / scale);
}

function sanitizeBodyValue(value) {
  if (Array.isArray(value)) {
    return value
      .map(sanitizeBodyValue)
      .filter((item) => item !== undefined);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [key, sanitizeBodyValue(item)])
        .filter(([, item]) => item !== undefined)
    );
  }

  if (value === undefined || value === null || value === "") return undefined;
  return value;
}

function bodyParams(params) {
  return sanitizeBodyValue(params);
}

function intervalMs(interval) {
  return {
    "15s": FIFTEEN_SECONDS_MS,
    "1m": 60_000,
    "5m": 5 * 60_000,
    "15m": 15 * 60_000,
    "30m": 30 * 60_000,
    "1h": 60 * 60_000,
    "4h": 4 * 60 * 60_000,
    "1d": 24 * 60 * 60_000
  }[interval] || 60_000;
}

function wsKlineInterval(interval) {
  return ORDERLY_WS_KLINE_INTERVALS.has(interval) ? interval : "";
}

function klineCacheKey(symbol, interval) {
  return `${toUiSymbol(symbol)}:${interval}`;
}

function base58Decode(text) {
  const source = String(text || "").trim();
  if (!source) return Buffer.alloc(0);
  const bytes = [0];
  for (const char of source) {
    const value = BASE58_INDEXES.get(char);
    if (value === undefined) {
      throw new ExchangeError("Orderly secret/key is not valid base58");
    }
    let carry = value;
    for (let index = 0; index < bytes.length; index += 1) {
      const next = bytes[index] * 58 + carry;
      bytes[index] = next & 0xff;
      carry = next >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of source) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return Buffer.from(bytes.reverse());
}

function base58Encode(buffer) {
  const source = Buffer.from(buffer);
  if (!source.length) return "";
  const digits = [0];
  for (const byte of source) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const next = digits[index] * 256 + carry;
      digits[index] = next % 58;
      carry = Math.floor(next / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leadingZeroes = "";
  for (const byte of source) {
    if (byte !== 0) break;
    leadingZeroes += "1";
  }
  return leadingZeroes + digits.reverse().map((digit) => BASE58_ALPHABET[digit]).join("");
}

function stripOrderlyKeyPrefix(value) {
  const text = String(value || "").trim();
  return text.startsWith(ORDERLY_KEY_PREFIX) ? text.slice(ORDERLY_KEY_PREFIX.length) : text;
}

function privateKeyFromSecret(secret) {
  const decoded = base58Decode(stripOrderlyKeyPrefix(secret));
  const seed = decoded.length === 64 ? decoded.subarray(0, 32) : decoded;
  if (seed.length !== 32) {
    throw new ExchangeError("Orderly secret must decode to a 32-byte ed25519 seed");
  }
  return crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8"
  });
}

function publicKeyFromPrivateKey(privateKey) {
  const der = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" });
  if (!Buffer.from(der).subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    throw new ExchangeError("Unexpected ed25519 public key encoding");
  }
  return Buffer.from(der).subarray(ED25519_SPKI_PREFIX.length);
}

function formatOrderlyKey(configuredKey, privateKey) {
  const text = String(configuredKey || "").trim();
  if (text) {
    return text.startsWith(ORDERLY_KEY_PREFIX) ? text : `${ORDERLY_KEY_PREFIX}${text}`;
  }
  return `${ORDERLY_KEY_PREFIX}${base58Encode(publicKeyFromPrivateKey(privateKey))}`;
}

function credentialsFromContext(context) {
  return {
    accountId: context.credentials?.accountId || "",
    orderlyKey: context.credentials?.orderlyKey || "",
    orderlySecret: context.credentials?.orderlySecret || "",
    orderTag: context.credentials?.orderTag || "",
    baseUrl: context.credentials?.baseUrl || "",
    testnetBaseUrl: context.credentials?.testnetBaseUrl || "",
    publicWsBaseUrl: context.credentials?.publicWsBaseUrl || "",
    testnetPublicWsBaseUrl: context.credentials?.testnetPublicWsBaseUrl || "",
    privateWsBaseUrl: context.credentials?.privateWsBaseUrl || "",
    testnetPrivateWsBaseUrl: context.credentials?.testnetPrivateWsBaseUrl || ""
  };
}

function parseRetryAfter(headerValue) {
  if (!headerValue) return 0;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(headerValue);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - now()) : 0;
}

function splitUiSymbol(symbol) {
  const text = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (text.endsWith("USDC")) return { baseAsset: text.slice(0, -4), quoteAsset: "USDC" };
  if (text.endsWith("USDT")) return { baseAsset: text.slice(0, -4), quoteAsset: "USDT" };
  return { baseAsset: text || "BTC", quoteAsset: "USDC" };
}

function toApiSymbol(symbol) {
  const text = String(symbol || "").toUpperCase();
  if (text.startsWith("PERP_")) return text;
  const { baseAsset } = splitUiSymbol(text);
  return `PERP_${baseAsset}_USDC`;
}

function toUiSymbol(symbol) {
  const text = String(symbol || "").toUpperCase();
  const match = text.match(/^PERP_(.+)_USDC(?:\.E)?$/);
  if (match) return `${match[1].replace(/_/g, "")}USDC`;
  return text.replace(/[^A-Z0-9]/g, "");
}

function buildMockKlines(limit = 180, intervalMs = 60_000, basePrice = 65000) {
  const rows = [];
  let price = toNumber(basePrice, 65000);
  const start = Math.floor((now() - limit * intervalMs) / intervalMs) * intervalMs;
  for (let index = 0; index < limit; index += 1) {
    const openTime = start + index * intervalMs;
    const intervalScale = Math.max(0.25, intervalMs / 60_000);
    const drift = (Math.sin(index / 9) * 55 + Math.cos(index / 17) * 35) * intervalScale;
    const open = price;
    const close = Math.max(1, open + drift + (Math.random() - 0.5) * 90 * intervalScale);
    const high = Math.max(open, close) + Math.random() * 120 * intervalScale;
    const low = Math.min(open, close) - Math.random() * 120 * intervalScale;
    price = close;
    rows.push({
      openTime,
      open: trimDecimal(open),
      high: trimDecimal(high),
      low: trimDecimal(low),
      close: trimDecimal(close),
      volume: trimDecimal(500 + Math.random() * 1200),
      closeTime: openTime + intervalMs - 1
    });
  }
  return rows;
}

function mapKline(row) {
  const openTime = toNumber(row.start_timestamp ?? row.startTime ?? row.openTime ?? row.t);
  const closeTime = toNumber(row.end_timestamp ?? row.endTime ?? row.closeTime ?? row.T, openTime + 60_000 - 1);
  return {
    openTime,
    open: String(row.open),
    high: String(row.high),
    low: String(row.low),
    close: String(row.close),
    volume: String(row.volume ?? "0"),
    closeTime
  };
}

function mergeKlineRows(baseRows, overlayRows, limit) {
  const rowsByTime = new Map();
  for (const row of [...(baseRows || []), ...(overlayRows || [])]) {
    const openTime = toNumber(row.openTime);
    if (!openTime) continue;
    rowsByTime.set(openTime, {
      ...row,
      openTime,
      closeTime: toNumber(row.closeTime, openTime + 60_000 - 1)
    });
  }
  return Array.from(rowsByTime.values())
    .sort((a, b) => toNumber(a.openTime) - toNumber(b.openTime))
    .slice(-Math.max(1, Number(limit) || 180));
}

function seedFifteenSecondRows(minuteKlines, { limit, endTime, fallbackPrice = 0 }) {
  const endBucket = Math.floor(endTime / FIFTEEN_SECONDS_MS) * FIFTEEN_SECONDS_MS;
  const startTime = endBucket - (limit - 1) * FIFTEEN_SECONDS_MS;
  const minuteMap = new Map(minuteKlines.map((row) => [
    Math.floor(toNumber(row.openTime) / 60_000) * 60_000,
    row
  ]));
  const rows = [];
  let lastClose = toNumber(fallbackPrice, 0);

  for (let index = 0; index < limit; index += 1) {
    const openTime = startTime + index * FIFTEEN_SECONDS_MS;
    const minuteOpenTime = Math.floor(openTime / 60_000) * 60_000;
    const minute = minuteMap.get(minuteOpenTime);
    if (!minute) {
      const price = lastClose || toNumber(fallbackPrice, 0);
      rows.push({
        openTime,
        open: trimDecimal(price),
        high: trimDecimal(price),
        low: trimDecimal(price),
        close: trimDecimal(price),
        volume: "0",
        closeTime: openTime + FIFTEEN_SECONDS_MS - 1
      });
      continue;
    }

    const segment = Math.floor((openTime - minuteOpenTime) / FIFTEEN_SECONDS_MS);
    const open = toNumber(minute.open, lastClose);
    const close = toNumber(minute.close, open);
    const high = toNumber(minute.high, Math.max(open, close));
    const low = toNumber(minute.low, Math.min(open, close));
    const t0 = segment / 4;
    const t1 = (segment + 1) / 4;
    const segmentOpen = open + (close - open) * t0;
    const segmentClose = open + (close - open) * t1;
    const syntheticWick = (high - low) * 0.08;
    rows.push({
      openTime,
      open: trimDecimal(segmentOpen),
      high: trimDecimal(Math.min(high, Math.max(segmentOpen, segmentClose) + syntheticWick)),
      low: trimDecimal(Math.max(low, Math.min(segmentOpen, segmentClose) - syntheticWick)),
      close: trimDecimal(segmentClose),
      volume: trimDecimal(toNumber(minute.volume, 0) / 4),
      closeTime: openTime + FIFTEEN_SECONDS_MS - 1
    });
    lastClose = segmentClose;
  }

  return rows;
}

function normalizeBalance(row) {
  const total = toNumber(row.holding, 0);
  const frozen = toNumber(row.frozen, 0) + toNumber(row.isolated_order_frozen, 0);
  const available = total - frozen;
  return {
    asset: row.token || row.asset || "USDC",
    walletBalance: trimDecimal(total),
    balance: trimDecimal(total),
    crossWalletBalance: trimDecimal(total),
    crossUnPnl: "0",
    availableBalance: trimDecimal(available),
    maxWithdrawAmount: trimDecimal(available),
    marginAvailable: true,
    negativeBalance: "0",
    updateTime: row.updated_time || now()
  };
}

function normalizePosition(row) {
  const amount = toNumber(row.position_qty);
  const symbol = toUiSymbol(row.symbol);
  const markPrice = toNumber(row.mark_price ?? row.markPrice);
  return {
    symbol,
    positionSide: amount > 0 ? POSITION_SIDES.LONG : amount < 0 ? POSITION_SIDES.SHORT : POSITION_SIDES.BOTH,
    positionAmt: trimDecimal(amount),
    entryPrice: String(row.average_open_price ?? row.entryPrice ?? "0"),
    breakEvenPrice: String(row.average_open_price ?? row.entryPrice ?? "0"),
    markPrice: String(markPrice || row.mark_price || "0"),
    unRealizedProfit: String(row.unsettled_pnl ?? row.unRealizedProfit ?? "0"),
    liquidationPrice: String(row.est_liq_price ?? row.liquidationPrice ?? "0"),
    notional: trimDecimal(amount * markPrice),
    marginAsset: "USDC",
    leverage: String(row.leverage || ""),
    side: amount > 0 ? "LONG" : amount < 0 ? "SHORT" : "FLAT",
    updateTime: row.updated_time || row.timestamp || now()
  };
}

function normalizeStatus(status) {
  const text = String(status || "").toUpperCase();
  return text === "CANCELLED" ? "CANCELED" : text;
}

function inferPositionSide(row) {
  const side = String(row.side || "").toUpperCase();
  const reduceOnly = Boolean(row.reduce_only ?? row.reduceOnly);
  if (reduceOnly) return side === ORDER_SIDES.BUY ? POSITION_SIDES.SHORT : POSITION_SIDES.LONG;
  return side === ORDER_SIDES.BUY ? POSITION_SIDES.LONG : POSITION_SIDES.SHORT;
}

function normalizeOrder(row) {
  return {
    symbol: toUiSymbol(row.symbol),
    orderId: row.order_id ?? row.orderId,
    clientOrderId: row.client_order_id ?? row.clientOrderId,
    side: row.side,
    positionSide: inferPositionSide(row),
    type: row.type || row.order_type,
    status: normalizeStatus(row.status),
    price: String(row.price ?? row.order_price ?? "0"),
    avgPrice: String(row.average_executed_price ?? row.avgPrice ?? "0"),
    origQty: String(row.quantity ?? row.order_quantity ?? "0"),
    executedQty: String(row.executed_quantity ?? row.total_executed_quantity ?? row.executedQty ?? "0"),
    reduceOnly: Boolean(row.reduce_only ?? row.reduceOnly),
    timeInForce: (row.type || row.order_type) === "POST_ONLY" ? "GTX" : "GTC",
    updateTime: row.updated_time || row.created_time || row.updateTime || now()
  };
}

function normalizeOrderBookSide(rows) {
  return (rows || []).map((row) => {
    if (Array.isArray(row)) return [String(row[0]), String(row[1])];
    return [String(row.price), String(row.quantity)];
  });
}

function websocketState(ws) {
  return {
    connecting: globalThis.WebSocket?.CONNECTING ?? 0,
    open: globalThis.WebSocket?.OPEN ?? 1,
    closing: globalThis.WebSocket?.CLOSING ?? 2,
    closed: globalThis.WebSocket?.CLOSED ?? 3,
    current: ws?.readyState
  };
}

function appendAccountId(baseUrl, accountId) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/${encodeURIComponent(accountId)}`;
}

function topicSymbol(topic) {
  return String(topic || "").split("@")[0].split("$").pop();
}

function hasSignCredentials(context) {
  const credentials = credentialsFromContext(context);
  return Boolean(credentials.accountId && credentials.orderlySecret);
}

export class MememaxOrderlyAdapter {
  constructor() {
    this.id = "mememax-orderly";
    this.label = "MemeMax Orderly Perps";
    this.modes = ["dry-run", "testnet", "live"];
    this.symbolCache = new Map();
    this.dryRun = {
      orderId: 7000000,
      openOrders: [],
      leverage: 20,
      balances: [
        {
          token: "USDC",
          holding: 100000,
          frozen: 0,
          pending_short: 0,
          updated_time: now()
        }
      ],
      positions: []
    };
    this.marketCache = {
      bbo: new Map(),
      orderBooks: new Map(),
      tickers: new Map(),
      klines: new Map()
    };
    this.marketStream = {
      ws: null,
      status: "idle",
      lastError: "",
      lastMessageTime: 0,
      reconnectTimer: null,
      pingTimer: null,
      subscriptions: new Set(),
      klineSubscriptions: new Set(),
      context: null
    };
    this.marketTickWaiters = new Map();
    this.requestRateBuckets = new Map();
  }

  baseUrl(context) {
    const credentials = credentialsFromContext(context);
    if (context.mode === "testnet") return credentials.testnetBaseUrl || TESTNET_BASE_URL;
    return credentials.baseUrl || MAINNET_BASE_URL;
  }

  publicWsBaseUrl(context) {
    const credentials = credentialsFromContext(context);
    if (context.mode === "testnet") return credentials.testnetPublicWsBaseUrl || TESTNET_PUBLIC_WS_BASE_URL;
    return credentials.publicWsBaseUrl || MAINNET_PUBLIC_WS_BASE_URL;
  }

  privateWsBaseUrl(context) {
    const credentials = credentialsFromContext(context);
    if (context.mode === "testnet") return credentials.testnetPrivateWsBaseUrl || TESTNET_PRIVATE_WS_BASE_URL;
    return credentials.privateWsBaseUrl || MAINNET_PRIVATE_WS_BASE_URL;
  }

  marketDataStreamStatus() {
    return {
      status: this.marketStream.status,
      lastError: this.marketStream.lastError,
      lastMessageTime: this.marketStream.lastMessageTime
        ? new Date(this.marketStream.lastMessageTime).toISOString()
        : "",
      symbols: Array.from(this.marketStream.subscriptions).map(toUiSymbol)
    };
  }

  chaseConfig() {
    return {
      minUpdateMs: 100,
      updateMs: 100,
      rateLimit10sOrders: 100,
      rateLimitSafety: 1,
      rateLimitWindowMs: 1000,
      orderOpsPerReplace: 1,
      restFallbackUpdateMs: 1000,
      statusCheckMs: 1000,
      statusPollWithPrivateStream: false,
      replaceStrategy: "edit-order"
    };
  }

  notifyMarketTick(symbol, source) {
    const uiSymbol = toUiSymbol(symbol);
    const waiters = this.marketTickWaiters.get(uiSymbol);
    if (!waiters?.size) return;
    this.marketTickWaiters.delete(uiSymbol);
    const payload = { symbol: uiSymbol, source, time: now() };
    for (const waiter of waiters) {
      waiter.resolve(payload);
    }
  }

  waitForMarketTick(context, symbol, timeoutMs = 1000) {
    const uiSymbol = toUiSymbol(symbol);
    const hasStream = this.ensureMarketDataStream(context, uiSymbol);
    if (!hasStream) {
      return new Promise((resolve) => {
        setTimeout(() => resolve({ symbol: uiSymbol, source: "timer", time: now() }), Math.max(1, timeoutMs));
      });
    }

    return new Promise((resolve) => {
      let waiter;
      const cleanup = () => {
        const waiters = this.marketTickWaiters.get(uiSymbol);
        if (!waiters) return;
        waiters.delete(waiter);
        if (!waiters.size) this.marketTickWaiters.delete(uiSymbol);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve({ symbol: uiSymbol, source: "timeout", time: now() });
      }, Math.max(1, timeoutMs));
      waiter = {
        resolve: (payload) => {
          clearTimeout(timer);
          cleanup();
          resolve(payload);
        }
      };
      if (!this.marketTickWaiters.has(uiSymbol)) {
        this.marketTickWaiters.set(uiSymbol, new Set());
      }
      this.marketTickWaiters.get(uiSymbol).add(waiter);
    });
  }

  signTimestamp(credentials) {
    const privateKey = privateKeyFromSecret(credentials.orderlySecret);
    const timestamp = String(now());
    return {
      orderlyKey: formatOrderlyKey(credentials.orderlyKey, privateKey),
      timestamp,
      signature: crypto.sign(null, Buffer.from(timestamp), privateKey).toString("base64url")
    };
  }

  sendJson(ws, payload) {
    const state = websocketState(ws);
    if (!ws || state.current !== state.open) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }

  sendMarketTopic(topic, idBase = `mm_${Date.now()}_${Math.random().toString(16).slice(2, 7)}`, event = "subscribe") {
    return this.sendJson(this.marketStream.ws, {
      id: `${idBase}_${topic.split("@")[1]}`,
      topic,
      event
    });
  }

  marketBaseTopics(apiSymbol) {
    return [`${apiSymbol}@bbo`, `${apiSymbol}@orderbook`, `${apiSymbol}@ticker`, `${apiSymbol}@trade`];
  }

  sendMarketSubscriptions(apiSymbol) {
    const idBase = `mm_${Date.now()}_${Math.random().toString(16).slice(2, 7)}`;
    for (const topic of this.marketBaseTopics(apiSymbol)) {
      this.sendMarketTopic(topic, idBase);
    }
    for (const topic of this.marketStream.klineSubscriptions) {
      if (topic.startsWith(`${apiSymbol}@`)) this.sendMarketTopic(topic, idBase);
    }
  }

  sendMarketUnsubscriptions(topics) {
    if (!topics.length) return;
    const idBase = `mm_${Date.now()}_${Math.random().toString(16).slice(2, 7)}`;
    for (const topic of topics) {
      this.sendMarketTopic(topic, idBase, "unsubscribe");
    }
  }

  closeIdleMarketStream() {
    if (this.marketStream.subscriptions.size || this.marketStream.klineSubscriptions.size) return;
    this.clearMarketTimers();
    const ws = this.marketStream.ws;
    this.marketStream.ws = null;
    if (ws && websocketState(ws).current < websocketState(ws).closing) {
      ws.close();
    }
    this.marketStream.status = "idle";
  }

  releaseMarketDataStream(context, symbol, { includeKlines = true } = {}) {
    const credentials = credentialsFromContext(context);
    if (context.mode === "dry-run" || !credentials.accountId || typeof WebSocket === "undefined") {
      return false;
    }
    const apiSymbol = toApiSymbol(symbol);
    const topics = [];
    if (this.marketStream.subscriptions.delete(apiSymbol)) {
      topics.push(...this.marketBaseTopics(apiSymbol));
    }
    if (includeKlines) {
      for (const topic of Array.from(this.marketStream.klineSubscriptions)) {
        if (!topic.startsWith(`${apiSymbol}@`)) continue;
        this.marketStream.klineSubscriptions.delete(topic);
        topics.push(topic);
      }
    }
    this.sendMarketUnsubscriptions(topics);
    const uiSymbol = toUiSymbol(apiSymbol);
    this.marketTickWaiters.delete(uiSymbol);
    this.closeIdleMarketStream();
    return topics.length > 0;
  }

  focusMarketDataStream(context, { symbol, interval = "15s", retainSymbols = [] }) {
    const credentials = credentialsFromContext(context);
    if (context.mode === "dry-run" || !credentials.accountId || typeof WebSocket === "undefined") {
      return false;
    }
    const apiSymbol = toApiSymbol(symbol);
    const retained = new Set([apiSymbol, ...retainSymbols.map(toApiSymbol)]);
    const wantedKlineInterval = interval === "15s" ? "1m" : wsKlineInterval(interval);
    const wantedKlineTopic = wantedKlineInterval ? `${apiSymbol}@kline_${wantedKlineInterval}` : "";
    const topicsToUnsubscribe = [];

    for (const subscribedSymbol of Array.from(this.marketStream.subscriptions)) {
      if (retained.has(subscribedSymbol)) continue;
      this.marketStream.subscriptions.delete(subscribedSymbol);
      topicsToUnsubscribe.push(...this.marketBaseTopics(subscribedSymbol));
      this.marketTickWaiters.delete(toUiSymbol(subscribedSymbol));
    }

    for (const topic of Array.from(this.marketStream.klineSubscriptions)) {
      if (topic === wantedKlineTopic) continue;
      this.marketStream.klineSubscriptions.delete(topic);
      topicsToUnsubscribe.push(topic);
    }

    this.sendMarketUnsubscriptions(topicsToUnsubscribe);
    const opened = this.ensureMarketDataStream(context, apiSymbol);
    if (wantedKlineTopic) {
      const isNewTopic = !this.marketStream.klineSubscriptions.has(wantedKlineTopic);
      this.marketStream.klineSubscriptions.add(wantedKlineTopic);
      if (opened && isNewTopic) this.sendMarketTopic(wantedKlineTopic);
    }
    return opened;
  }

  clearMarketTimers() {
    if (this.marketStream.pingTimer) {
      clearInterval(this.marketStream.pingTimer);
      this.marketStream.pingTimer = null;
    }
    if (this.marketStream.reconnectTimer) {
      clearTimeout(this.marketStream.reconnectTimer);
      this.marketStream.reconnectTimer = null;
    }
  }

  scheduleMarketReconnect(reason) {
    if (!this.marketStream.context || this.marketStream.reconnectTimer) return;
    this.marketStream.status = "reconnecting";
    this.marketStream.lastError = reason || "";
    this.marketStream.reconnectTimer = setTimeout(() => {
      this.marketStream.reconnectTimer = null;
      this.openMarketDataStream(this.marketStream.context);
    }, 3000);
  }

  openMarketDataStream(context) {
    const credentials = credentialsFromContext(context);
    if (context.mode === "dry-run" || !credentials.accountId || typeof WebSocket === "undefined") {
      return false;
    }
    const currentState = websocketState(this.marketStream.ws);
    if (
      this.marketStream.ws &&
      (currentState.current === currentState.open || currentState.current === currentState.connecting)
    ) {
      return true;
    }

    this.clearMarketTimers();
    this.marketStream.context = {
      ...context,
      credentials: { ...credentials }
    };
    this.marketStream.status = "connecting";
    this.marketStream.lastError = "";

    const ws = new WebSocket(appendAccountId(this.publicWsBaseUrl(context), credentials.accountId));
    this.marketStream.ws = ws;

    ws.addEventListener("open", () => {
      this.marketStream.status = "connected";
      this.marketStream.lastError = "";
      this.marketStream.pingTimer = setInterval(() => {
        this.sendJson(ws, { event: "ping" });
      }, 10_000);
      for (const apiSymbol of this.marketStream.subscriptions) {
        this.sendMarketSubscriptions(apiSymbol);
      }
    });

    ws.addEventListener("message", (event) => {
      this.handleMarketMessage(ws, event.data);
    });

    ws.addEventListener("error", () => {
      this.marketStream.status = "error";
      this.marketStream.lastError = "MemeMax public WebSocket error";
    });

    ws.addEventListener("close", () => {
      if (this.marketStream.ws === ws) {
        this.marketStream.ws = null;
        this.marketStream.status = "disconnected";
        this.clearMarketTimers();
        if (this.marketStream.subscriptions.size > 0) {
          this.scheduleMarketReconnect("MemeMax public WebSocket closed");
        }
      }
    });

    return true;
  }

  ensureMarketDataStream(context, symbol) {
    const credentials = credentialsFromContext(context);
    if (context.mode === "dry-run" || !credentials.accountId || typeof WebSocket === "undefined") {
      return false;
    }
    const apiSymbol = toApiSymbol(symbol);
    const isNewSymbol = !this.marketStream.subscriptions.has(apiSymbol);
    this.marketStream.subscriptions.add(apiSymbol);
    const opened = this.openMarketDataStream(context);
    if (opened && isNewSymbol) this.sendMarketSubscriptions(apiSymbol);
    return opened;
  }

  ensureKlineStream(context, symbol, interval) {
    const wsInterval = wsKlineInterval(interval);
    if (!wsInterval) return false;
    const apiSymbol = toApiSymbol(symbol);
    const opened = this.ensureMarketDataStream(context, symbol);
    const topic = `${apiSymbol}@kline_${wsInterval}`;
    const isNewTopic = !this.marketStream.klineSubscriptions.has(topic);
    this.marketStream.klineSubscriptions.add(topic);
    if (opened && isNewTopic) this.sendMarketTopic(topic);
    return opened;
  }

  updateKlineCache(symbol, interval, row, limit = 1000) {
    const normalized = mapKline(row);
    if (!normalized.openTime) return null;
    const key = klineCacheKey(symbol, interval);
    const rows = mergeKlineRows(this.marketCache.klines.get(key) || [], [normalized], limit);
    this.marketCache.klines.set(key, rows);
    return normalized;
  }

  cachedKlines(symbol, interval, limit = 180) {
    return (this.marketCache.klines.get(klineCacheKey(symbol, interval)) || [])
      .slice(-Math.max(1, Number(limit) || 180));
  }

  updateSyntheticFifteenSecondKline(symbol, price, volume = 0, eventTime = now()) {
    const numericPrice = toNumber(price);
    if (numericPrice <= 0) return null;

    const openTime = Math.floor(toNumber(eventTime, now()) / FIFTEEN_SECONDS_MS) * FIFTEEN_SECONDS_MS;
    const key = klineCacheKey(symbol, "15s");
    const rows = this.marketCache.klines.get(key) || [];
    const last = rows[rows.length - 1];
    if (last && toNumber(last.openTime) === openTime) {
      last.high = trimDecimal(Math.max(toNumber(last.high, numericPrice), numericPrice));
      last.low = trimDecimal(Math.min(toNumber(last.low, numericPrice), numericPrice));
      last.close = trimDecimal(numericPrice);
      last.volume = trimDecimal(toNumber(last.volume) + Math.max(0, toNumber(volume)));
      last.closeTime = openTime + FIFTEEN_SECONDS_MS - 1;
    } else {
      rows.push({
        openTime,
        open: trimDecimal(numericPrice),
        high: trimDecimal(numericPrice),
        low: trimDecimal(numericPrice),
        close: trimDecimal(numericPrice),
        volume: trimDecimal(Math.max(0, toNumber(volume))),
        closeTime: openTime + FIFTEEN_SECONDS_MS - 1
      });
      while (rows.length > 1000) rows.shift();
    }
    this.marketCache.klines.set(key, rows);
    return rows[rows.length - 1];
  }

  handleMarketMessage(ws, raw) {
    let payload;
    try {
      payload = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (payload.event === "ping") {
      this.sendJson(ws, { event: "pong" });
      return;
    }
    if (payload.event === "pong") {
      return;
    }

    const topic = String(payload.topic || "");
    if (!topic) return;
    const apiSymbol = topicSymbol(topic);
    const uiSymbol = toUiSymbol(apiSymbol);
    const data = payload.data || {};
    const receivedAt = now();
    this.marketStream.lastMessageTime = receivedAt;

    if (topic.endsWith("@bbo")) {
      const bid = toNumber(data.bid);
      const ask = toNumber(data.ask);
      this.marketCache.bbo.set(uiSymbol, {
        time: receivedAt,
        lastUpdateId: payload.ts || data.ts || receivedAt,
        bid: String(data.bid ?? ""),
        bidSize: String(data.bidSize ?? ""),
        ask: String(data.ask ?? ""),
        askSize: String(data.askSize ?? "")
      });
      if (bid > 0 && ask > 0) this.updateSyntheticFifteenSecondKline(uiSymbol, (bid + ask) / 2, 0, payload.ts || data.ts || receivedAt);
      this.notifyMarketTick(uiSymbol, "ws-bbo");
      return;
    }

    if (topic.endsWith("@orderbook")) {
      this.marketCache.orderBooks.set(uiSymbol, {
        time: receivedAt,
        lastUpdateId: payload.ts || data.ts || receivedAt,
        bids: normalizeOrderBookSide(data.bids),
        asks: normalizeOrderBookSide(data.asks)
      });
      this.notifyMarketTick(uiSymbol, "ws-orderbook");
      return;
    }

    if (topic.endsWith("@ticker")) {
      const price = data.close ?? data.last_price ?? data.mark_price;
      this.marketCache.tickers.set(uiSymbol, {
        time: receivedAt,
        price: String(price ?? ""),
        payload: data
      });
      this.updateSyntheticFifteenSecondKline(uiSymbol, price, 0, payload.ts || data.ts || receivedAt);
      this.notifyMarketTick(uiSymbol, "ws-ticker");
      return;
    }

    if (topic.endsWith("@trade")) {
      const trades = Array.isArray(data) ? data : Array.isArray(payload.data?.rows) ? payload.data.rows : [data];
      for (const trade of trades) {
        const price = trade.price ?? trade.executed_price ?? trade.p;
        const volume = trade.size ?? trade.quantity ?? trade.q ?? 0;
        const eventTime = trade.timestamp ?? trade.ts ?? payload.ts ?? receivedAt;
        this.updateSyntheticFifteenSecondKline(uiSymbol, price, volume, eventTime);
      }
      this.notifyMarketTick(uiSymbol, "ws-trade");
      return;
    }

    const klineMatch = topic.match(/@kline_(.+)$/);
    if (klineMatch) {
      const row = this.updateKlineCache(uiSymbol, klineMatch[1], data);
      if (row) this.notifyMarketTick(uiSymbol, `ws-kline-${klineMatch[1]}`);
    }
  }

  cachedTicker(symbol) {
    const uiSymbol = toUiSymbol(symbol);
    const ticker = this.marketCache.tickers.get(uiSymbol);
    if (ticker && now() - ticker.time < 3000 && toNumber(ticker.price) > 0) {
      return { symbol: uiSymbol, price: ticker.price, time: ticker.time, source: "ws-ticker" };
    }

    const bbo = this.marketCache.bbo.get(uiSymbol);
    const bid = toNumber(bbo?.bid);
    const ask = toNumber(bbo?.ask);
    if (bbo && now() - bbo.time < 1500 && bid > 0 && ask > 0) {
      return { symbol: uiSymbol, price: trimDecimal((bid + ask) / 2), time: bbo.time, source: "ws-bbo" };
    }
    return null;
  }

  cachedOrderBook(symbol, limit = 20) {
    const uiSymbol = toUiSymbol(symbol);
    const orderBook = this.marketCache.orderBooks.get(uiSymbol);
    if (orderBook && now() - orderBook.time < 3000 && orderBook.bids.length && orderBook.asks.length) {
      return {
        lastUpdateId: orderBook.lastUpdateId,
        bids: orderBook.bids.slice(0, limit),
        asks: orderBook.asks.slice(0, limit),
        source: "ws-orderbook"
      };
    }

    const bbo = this.marketCache.bbo.get(uiSymbol);
    if (bbo && now() - bbo.time < 1500 && toNumber(bbo.bid) > 0 && toNumber(bbo.ask) > 0) {
      return {
        lastUpdateId: bbo.lastUpdateId,
        bids: [[bbo.bid, bbo.bidSize || "0"]],
        asks: [[bbo.ask, bbo.askSize || "0"]],
        source: "ws-bbo"
      };
    }
    return null;
  }

  async request(context, method, path, params = {}, options = {}) {
    if (context.mode === "dry-run" && options.signed) {
      throw new ExchangeError("Signed endpoint is not available in dry-run");
    }

    const url = new URL(path, this.baseUrl(context));
    const queryParams = method === "GET" || method === "DELETE" ? params : {};
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const bodyObject = method === "GET" || method === "DELETE" ? null : bodyParams(params);
    const body = bodyObject !== null && bodyObject !== undefined ? JSON.stringify(bodyObject) : undefined;
    const headers = {
      "Content-Type": method === "GET" || method === "DELETE"
        ? "application/x-www-form-urlencoded"
        : "application/json"
    };

    await this.waitForRequestRateSlot(context, method, url.pathname, options);

    if (options.signed) {
      const credentials = credentialsFromContext(context);
      if (!credentials.accountId || !credentials.orderlySecret) {
        throw new ExchangeError("MemeMax Orderly account id and secret are required for this action");
      }
      const privateKey = privateKeyFromSecret(credentials.orderlySecret);
      const timestamp = String(now());
      const message = `${timestamp}${method}${url.pathname}${url.search}${body || ""}`;
      const signature = crypto.sign(null, Buffer.from(message), privateKey).toString("base64url");
      headers["orderly-account-id"] = credentials.accountId;
      headers["orderly-key"] = formatOrderlyKey(credentials.orderlyKey, privateKey);
      headers["orderly-timestamp"] = timestamp;
      headers["orderly-signature"] = signature;
      if (options.recvWindow) headers["x-recv-window"] = String(options.recvWindow);
    }

    const response = await fetch(url, { method, headers, body });
    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text.slice(0, 300), nonJson: true };
      }
    }

    if (!response.ok || payload.success === false || payload.nonJson) {
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      throw new ExchangeError(payload.message || `MemeMax Orderly request failed with ${response.status}`, {
        code: payload.code,
        status: response.status,
        path: url.pathname,
        retryAfterMs,
        transient: response.status === 429 || response.status >= 500 || Boolean(payload.nonJson),
        nonJson: Boolean(payload.nonJson)
      });
    }

    return payload;
  }

  requestRateProfile(context, method, path, options = {}) {
    if (context.mode === "dry-run" || !options.signed || !["POST", "PUT", "DELETE"].includes(method)) {
      return null;
    }

    if (path === "/v1/algo/order" && method === "POST") {
      return {
        key: `${context.mode}:algo-order`,
        windowMs: Math.max(100, envNumber("MEMEMAX_ALGO_RATE_LIMIT_WINDOW_MS", 1000)),
        limitPer10s: Math.max(1, envNumber("MEMEMAX_ALGO_RATE_LIMIT_10S_ORDERS", 10)),
        safety: envRatio("MEMEMAX_ALGO_RATE_LIMIT_SAFETY", 1)
      };
    }

    if (["/v1/order", "/v1/orders", "/v1/batch-order", "/v1/client/order", "/v1/client/batch-order"].includes(path)) {
      return {
        key: `${context.mode}:order-mutation`,
        windowMs: Math.max(100, envNumber("MEMEMAX_CHASE_RATE_LIMIT_WINDOW_MS", 1000)),
        limitPer10s: Math.max(1, envNumber("MEMEMAX_CHASE_RATE_LIMIT_10S_ORDERS", 100)),
        safety: envRatio("MEMEMAX_CHASE_RATE_LIMIT_SAFETY", 1)
      };
    }

    return null;
  }

  async waitForRequestRateSlot(context, method, path, options = {}) {
    const profile = this.requestRateProfile(context, method, path, options);
    if (!profile) return;

    const capacity = Math.max(1, Math.floor((profile.limitPer10s * profile.windowMs * profile.safety) / 10_000));
    while (true) {
      const nowMs = now();
      const bucket = this.requestRateBuckets.get(profile.key) || [];
      while (bucket.length && nowMs - bucket[0] >= profile.windowMs) bucket.shift();
      if (bucket.length < capacity) {
        bucket.push(nowMs);
        this.requestRateBuckets.set(profile.key, bucket);
        return;
      }
      this.requestRateBuckets.set(profile.key, bucket);
      await new Promise((resolve) => {
        setTimeout(resolve, Math.max(1, profile.windowMs - (nowMs - bucket[0])));
      });
    }
  }

  async getMarketInfo(context) {
    if (context.mode === "dry-run") {
      return [
        {
          symbol: "PERP_BTC_USDC",
          quote_tick: 0.1,
          base_tick: 0.00001,
          base_min: 0.00001,
          base_max: 20,
          min_notional: 1
        },
        {
          symbol: "PERP_ETH_USDC",
          quote_tick: 0.01,
          base_tick: 0.0001,
          base_min: 0.0001,
          base_max: 1000,
          min_notional: 1
        },
        {
          symbol: "PERP_DOGE_USDC",
          quote_tick: 0.00001,
          base_tick: 1,
          base_min: 1,
          base_max: 10000000,
          min_notional: 1
        }
      ];
    }

    const cacheKey = context.mode;
    const cached = this.symbolCache.get(cacheKey);
    if (cached && now() - cached.time < 10 * 60_000) return cached.payload;

    const payload = await this.request(context, "GET", "/v1/public/info");
    const rows = payload.data?.rows || [];
    this.symbolCache.set(cacheKey, { time: now(), payload: rows });
    return rows;
  }

  async getSymbols(context) {
    const rows = await this.getMarketInfo(context);
    return rows
      .filter((row) => String(row.symbol || "").startsWith("PERP_"))
      .map((row) => {
        const symbol = toUiSymbol(row.symbol);
        const { baseAsset, quoteAsset } = splitUiSymbol(symbol);
        return {
          symbol,
          baseAsset,
          quoteAsset,
          marginAsset: "USDC",
          tickSize: String(row.quote_tick ?? "0.0001"),
          stepSize: String(row.base_tick ?? "0.0001"),
          minQty: String(row.base_min ?? "0"),
          minNotional: String(row.min_notional ?? "1")
        };
      })
      .sort((a, b) => {
        if (a.symbol === "BTCUSDC") return -1;
        if (b.symbol === "BTCUSDC") return 1;
        return a.symbol.localeCompare(b.symbol);
      });
  }

  async getSymbol(context, symbol) {
    const symbols = await this.getSymbols(context);
    return symbols.find((item) => item.symbol === toUiSymbol(symbol)) || symbols[0];
  }

  async getTicker(context, symbol) {
    const uiSymbol = toUiSymbol(symbol);
    if (context.mode === "dry-run") {
      const price = uiSymbol.startsWith("ETH") ? "3200.0" : uiSymbol.startsWith("DOGE") ? "0.18" : "65000.0";
      return { symbol: uiSymbol, price, time: now(), fallback: true };
    }

    const apiSymbol = toApiSymbol(symbol);
    this.ensureMarketDataStream(context, uiSymbol);
    const cached = this.cachedTicker(uiSymbol);
    if (cached) return cached;

    const payload = await this.request(context, "GET", `/v1/public/futures/${encodeURIComponent(apiSymbol)}`);
    const row = Array.isArray(payload.data?.rows) ? payload.data.rows[0] : payload.data;
    const price = row?.last_price ?? row?.mark_price ?? row?.index_price;
    return { symbol: uiSymbol, price: String(price), time: payload.timestamp || now() };
  }

  async getKlines(context, { symbol, interval = "15s", limit = 180 }) {
    const uiSymbol = toUiSymbol(symbol);
    const numericLimit = Math.max(1, Math.min(1000, Number(limit) || 180));
    if (context.mode === "dry-run") {
      const ticker = await this.getTicker(context, uiSymbol).catch(() => ({ price: "65000" }));
      return buildMockKlines(Math.min(interval === "15s" ? 240 : 1000, numericLimit), intervalMs(interval), ticker.price);
    }

    if (interval === "15s") {
      this.ensureMarketDataStream(context, uiSymbol);
      this.ensureKlineStream(context, uiSymbol, "1m");
      try {
        const minuteLimit = Math.ceil(numericLimit / 4) + 2;
        const [ticker, minuteRows] = await Promise.all([
          this.getTicker(context, uiSymbol).catch(() => ({ price: "0" })),
          this.getKlines(context, { symbol: uiSymbol, interval: "1m", limit: minuteLimit }).catch(() => [])
        ]);
        const mergedMinuteRows = mergeKlineRows(
          minuteRows,
          this.cachedKlines(uiSymbol, "1m", minuteLimit),
          minuteLimit
        );
        const seededRows = seedFifteenSecondRows(mergedMinuteRows, {
          limit: Math.min(240, numericLimit),
          endTime: now(),
          fallbackPrice: ticker.price
        });
        return mergeKlineRows(seededRows, this.cachedKlines(uiSymbol, "15s", numericLimit), Math.min(240, numericLimit));
      } catch (error) {
        const cachedRows = this.cachedKlines(uiSymbol, "15s", numericLimit);
        if (cachedRows.length) return cachedRows;
        if (context.mode !== "dry-run") throw error;
        const ticker = await this.getTicker(context, uiSymbol).catch(() => ({ price: "65000" }));
        return buildMockKlines(Math.min(240, numericLimit), FIFTEEN_SECONDS_MS, ticker.price);
      }
    }

    this.ensureKlineStream(context, uiSymbol, interval);
    try {
      const signed = context.mode !== "dry-run" && hasSignCredentials(context);
      const payload = await this.request(context, "GET", "/v1/kline", {
        symbol: toApiSymbol(uiSymbol),
        type: interval,
        limit: numericLimit
      }, { signed });
      return mergeKlineRows(
        (payload.data?.rows || []).map(mapKline),
        this.cachedKlines(uiSymbol, interval, numericLimit),
        numericLimit
      );
    } catch (error) {
      const cachedRows = this.cachedKlines(uiSymbol, interval, numericLimit);
      if (cachedRows.length) return cachedRows;
      if (context.mode !== "dry-run") throw error;
      return buildMockKlines(numericLimit);
    }
  }

  async getOrderBook(context, { symbol, limit = 20 }) {
    const uiSymbol = toUiSymbol(symbol);
    if (context.mode === "dry-run") {
      const mid = uiSymbol.startsWith("ETH") ? 3200 : uiSymbol.startsWith("DOGE") ? 0.18 : 65000;
      const tick = uiSymbol.startsWith("DOGE") ? 0.0001 : uiSymbol.startsWith("ETH") ? 0.1 : 1;
      return {
        lastUpdateId: now(),
        bids: Array.from({ length: limit }, (_, index) => [
          trimDecimal(mid - tick * (index + 1)),
          trimDecimal(0.4 + index * 0.11)
        ]),
        asks: Array.from({ length: limit }, (_, index) => [
          trimDecimal(mid + tick * (index + 1)),
          trimDecimal(0.35 + index * 0.09)
        ]),
        source: "dry-run"
      };
    }

    this.ensureMarketDataStream(context, uiSymbol);
    const cached = this.cachedOrderBook(uiSymbol, limit);
    if (cached) return cached;

    try {
      const signed = context.mode !== "dry-run" && hasSignCredentials(context);
      const payload = await this.request(context, "GET", `/v1/orderbook/${encodeURIComponent(toApiSymbol(uiSymbol))}`, {
        max_level: limit
      }, { signed });
      return {
        lastUpdateId: payload.data?.timestamp || payload.timestamp || now(),
        bids: normalizeOrderBookSide(payload.data?.bids),
        asks: normalizeOrderBookSide(payload.data?.asks)
      };
    } catch (error) {
      if (context.mode !== "dry-run") throw error;
      const mid = uiSymbol.startsWith("ETH") ? 3200 : 65000;
      const tick = uiSymbol.startsWith("ETH") ? 0.1 : 1;
      return {
        lastUpdateId: now(),
        bids: Array.from({ length: limit }, (_, index) => [
          trimDecimal(mid - tick * (index + 1)),
          trimDecimal(0.4 + index * 0.11)
        ]),
        asks: Array.from({ length: limit }, (_, index) => [
          trimDecimal(mid + tick * (index + 1)),
          trimDecimal(0.35 + index * 0.09)
        ])
      };
    }
  }

  privateStreamUrl(context) {
    const credentials = credentialsFromContext(context);
    if (!credentials.accountId || !credentials.orderlySecret) {
      throw new ExchangeError("MemeMax private WebSocket requires account id and orderly secret");
    }
    const auth = this.signTimestamp(credentials);
    const url = new URL(appendAccountId(this.privateWsBaseUrl(context), credentials.accountId));
    url.searchParams.set("orderly_key", auth.orderlyKey);
    url.searchParams.set("timestamp", auth.timestamp);
    url.searchParams.set("sign", auth.signature);
    return url.toString();
  }

  async createUserDataStream(context) {
    if (context.mode === "dry-run") {
      throw new ExchangeError("User data stream is not available in dry-run");
    }
    const credentials = credentialsFromContext(context);
    if (!credentials.accountId || !credentials.orderlySecret) {
      throw new ExchangeError("MemeMax private WebSocket requires account id and orderly secret");
    }
    return {
      listenKey: credentials.accountId,
      streamUrl: this.privateStreamUrl(context),
      subscriptions: ["executionreport", "position", "balance", "account"],
      pingIntervalMs: 10_000
    };
  }

  async keepAliveUserDataStream() {
    return {};
  }

  async closeUserDataStream() {
    return {};
  }

  async getLeverageBracket(context, symbol) {
    if (context.mode === "dry-run") {
      return {
        symbol: toUiSymbol(symbol),
        maxLeverage: 50,
        brackets: [{ bracket: 1, initialLeverage: 50, notionalCap: "100000", notionalFloor: "0" }],
        fallback: true
      };
    }

    const payload = await this.request(context, "GET", "/v1/public/leverage");
    return {
      symbol: toUiSymbol(symbol),
      maxLeverage: Math.max(1, toNumber(payload.data?.max_futures_leverage, 50)),
      brackets: []
    };
  }

  async getBalances(context) {
    if (context.mode === "dry-run") return this.dryRun.balances.map(normalizeBalance);
    const payload = await this.request(context, "GET", "/v1/client/holding", { all: true }, { signed: true });
    return (payload.data?.holding || []).map(normalizeBalance);
  }

  async getPositions(context, symbol) {
    if (context.mode === "dry-run") {
      return this.dryRun.positions
        .filter((position) => !symbol || position.symbol === toUiSymbol(symbol))
        .filter((position) => nonZero(position.positionAmt ?? position.position_qty))
        .map(normalizePosition);
    }
    const payload = await this.request(context, "GET", "/v1/positions", {}, { signed: true });
    return (payload.data?.rows || [])
      .map(normalizePosition)
      .filter((position) => (!symbol || position.symbol === toUiSymbol(symbol)) && nonZero(position.positionAmt));
  }

  async getOpenOrders(context, symbol) {
    if (context.mode === "dry-run") {
      return this.dryRun.openOrders
        .filter((order) => !symbol || order.symbol === toUiSymbol(symbol))
        .map(normalizeOrder);
    }
    const payload = await this.request(context, "GET", "/v1/orders", {
      symbol: symbol ? toApiSymbol(symbol) : undefined,
      status: "INCOMPLETE",
      size: 500
    }, { signed: true });
    return (payload.data?.rows || []).map(normalizeOrder);
  }

  async setLeverage(context, { symbol, leverage }) {
    const nextLeverage = Number(leverage);
    if (context.mode === "dry-run") {
      this.dryRun.leverage = nextLeverage;
      return { symbol: toUiSymbol(symbol), leverage: nextLeverage };
    }
    await this.request(context, "POST", "/v1/client/leverage", { leverage: nextLeverage }, { signed: true });
    return { symbol: toUiSymbol(symbol), leverage: nextLeverage };
  }

  applyDryRunMarketFill(order, quantity) {
    const uiSymbol = toUiSymbol(order.symbol);
    const existing = this.dryRun.positions.find((position) => position.symbol === uiSymbol);
    const current = toNumber(existing?.position_qty ?? existing?.positionAmt, 0);
    const fillQty = toNumber(quantity, 0);
    const signedFill = order.side === ORDER_SIDES.BUY ? fillQty : -fillQty;
    let nextAmount = current + signedFill;

    if (order.reduceOnly || order.action === "CLOSE") {
      if (current > 0) nextAmount = Math.max(0, current + signedFill);
      else if (current < 0) nextAmount = Math.min(0, current + signedFill);
      else nextAmount = 0;
    }
    if (Math.abs(nextAmount) < 1e-12) nextAmount = 0;

    const row = existing || {
      symbol: uiSymbol,
      position_qty: 0,
      average_open_price: 65000,
      mark_price: 65000,
      unsettled_pnl: 0,
      est_liq_price: 0,
      leverage: this.dryRun.leverage,
      updated_time: now()
    };
    row.position_qty = nextAmount;
    row.updated_time = now();
    if (!existing) this.dryRun.positions.push(row);
  }

  async placeLimitOrder(context, order) {
    const uiSymbol = toUiSymbol(order.symbol);
    const symbolInfo = await this.getSymbol(context, uiSymbol);
    const price = roundToStep(toNumber(order.price), symbolInfo.tickSize, "nearest");
    const quantity = roundToStep(toNumber(order.quantity), symbolInfo.stepSize, "down");

    if (context.mode === "dry-run") {
      const mockOrder = {
        order_id: this.dryRun.orderId += 1,
        client_order_id: `dry_${this.dryRun.orderId}`,
        symbol: uiSymbol,
        side: order.side,
        type: order.timeInForce === "GTX" ? "POST_ONLY" : "LIMIT",
        status: "NEW",
        price,
        average_executed_price: "0",
        quantity,
        executed_quantity: "0",
        reduce_only: Boolean(order.reduceOnly),
        updated_time: now()
      };
      this.dryRun.openOrders.push(mockOrder);
      return normalizeOrder(mockOrder);
    }

    const credentials = credentialsFromContext(context);
    const payload = {
      symbol: toApiSymbol(uiSymbol),
      side: order.side,
      order_type: order.timeInForce === "GTX" || order.postOnly ? "POST_ONLY" : "LIMIT",
      order_price: Number(price),
      order_quantity: Number(quantity),
      reduce_only: Boolean(order.reduceOnly),
      margin_mode: "CROSS",
      order_tag: credentials.orderTag || undefined
    };
    const response = await this.request(context, "POST", "/v1/order", payload, { signed: true });
    return normalizeOrder({
      ...payload,
      ...(response.data || {}),
      status: response.data?.status || "NEW",
      price: response.data?.order_price ?? payload.order_price,
      quantity: response.data?.order_quantity ?? payload.order_quantity,
      reduce_only: payload.reduce_only,
      type: response.data?.order_type || payload.order_type
    });
  }

  async replaceLimitOrder(context, order) {
    const uiSymbol = toUiSymbol(order.symbol);
    const symbolInfo = await this.getSymbol(context, uiSymbol);
    const price = roundToStep(toNumber(order.price), symbolInfo.tickSize, "nearest");
    const quantity = roundToStep(toNumber(order.quantity), symbolInfo.stepSize, "down");

    if (context.mode === "dry-run") {
      const existing = this.dryRun.openOrders.find((item) => (
        item.symbol === uiSymbol && String(item.order_id) === String(order.orderId)
      ));
      if (!existing) {
        throw new ExchangeError("Dry-run order to edit was not found", {
          status: 404,
          transient: false
        });
      }
      existing.price = price;
      existing.quantity = quantity;
      existing.updated_time = now();
      return normalizeOrder(existing);
    }

    const credentials = credentialsFromContext(context);
    const payload = {
      order_id: order.orderId,
      symbol: toApiSymbol(uiSymbol),
      side: order.side,
      order_type: order.timeInForce === "GTX" || order.postOnly ? "POST_ONLY" : "LIMIT",
      order_price: Number(price),
      order_quantity: Number(quantity),
      reduce_only: Boolean(order.reduceOnly),
      order_tag: credentials.orderTag || undefined
    };
    const response = await this.request(context, "PUT", "/v1/order", payload, { signed: true });
    return normalizeOrder({
      ...payload,
      ...(response.data || {}),
      order_id: order.orderId,
      status: response.data?.status || "EDIT_SENT",
      price: response.data?.order_price ?? payload.order_price,
      quantity: response.data?.order_quantity ?? payload.order_quantity,
      reduce_only: payload.reduce_only,
      type: response.data?.order_type || payload.order_type
    });
  }

  async placeMarketOrder(context, order) {
    const uiSymbol = toUiSymbol(order.symbol);
    const symbolInfo = await this.getSymbol(context, uiSymbol);
    const quantity = roundToStep(toNumber(order.quantity), symbolInfo.stepSize, "down");

    if (context.mode === "dry-run") {
      this.applyDryRunMarketFill({ ...order, symbol: uiSymbol }, quantity);
      return {
        orderId: this.dryRun.orderId += 1,
        symbol: uiSymbol,
        side: order.side,
        positionSide: inferPositionSide({ side: order.side, reduce_only: Boolean(order.reduceOnly) }),
        type: "MARKET",
        status: "FILLED",
        origQty: quantity,
        executedQty: quantity,
        reduceOnly: Boolean(order.reduceOnly),
        updateTime: now()
      };
    }

    const credentials = credentialsFromContext(context);
    const payload = {
      symbol: toApiSymbol(uiSymbol),
      side: order.side,
      order_type: "MARKET",
      order_quantity: Number(quantity),
      reduce_only: Boolean(order.reduceOnly),
      margin_mode: "CROSS",
      order_tag: credentials.orderTag || undefined
    };
    const response = await this.request(context, "POST", "/v1/order", payload, { signed: true });
    return normalizeOrder({
      ...payload,
      ...(response.data || {}),
      status: response.data?.status || "NEW",
      quantity: response.data?.order_quantity ?? payload.order_quantity,
      reduce_only: payload.reduce_only,
      type: response.data?.order_type || payload.order_type
    });
  }

  async placeConditionalMarketOrder(context, order) {
    const algoType = String(order.strategyType || "").includes("TAKE_PROFIT") ? "TAKE_PROFIT" : "STOP_LOSS";
    const result = await this.placePositionBracketOrder(context, {
      ...order,
      stopLossPrice: algoType === "STOP_LOSS" ? order.stopPrice : undefined,
      takeProfitPrice: algoType === "TAKE_PROFIT" ? order.stopPrice : undefined
    });
    return Array.isArray(result) && result.length === 1 ? result[0] : result;
  }

  async placePositionBracketOrder(context, order) {
    const uiSymbol = toUiSymbol(order.symbol);
    const symbolInfo = await this.getSymbol(context, uiSymbol);
    const stopLossPrice = toNumber(order.stopLossPrice);
    const takeProfitPrice = toNumber(order.takeProfitPrice);
    const closeSide = order.side;
    const workingType = order.workingType || "MARK_PRICE";
    const childOrders = [];

    if (stopLossPrice > 0) {
      childOrders.push({
        symbol: toApiSymbol(uiSymbol),
        algo_type: "STOP_LOSS",
        side: closeSide,
        type: "CLOSE_POSITION",
        trigger_price_type: workingType,
        trigger_price: Number(roundToStep(stopLossPrice, symbolInfo.tickSize, "nearest")),
        reduce_only: true
      });
    }

    if (takeProfitPrice > 0) {
      childOrders.push({
        symbol: toApiSymbol(uiSymbol),
        algo_type: "TAKE_PROFIT",
        side: closeSide,
        type: "CLOSE_POSITION",
        trigger_price_type: workingType,
        trigger_price: Number(roundToStep(takeProfitPrice, symbolInfo.tickSize, "nearest")),
        reduce_only: true
      });
    }

    if (!childOrders.length) return [];

    if (context.mode === "dry-run") {
      return childOrders.map((child) => ({
        orderId: this.dryRun.orderId += 1,
        symbol: uiSymbol,
        side: closeSide,
        positionSide: order.positionSide || (order.side === ORDER_SIDES.BUY ? POSITION_SIDES.SHORT : POSITION_SIDES.LONG),
        strategyType: child.algo_type,
        type: child.type,
        status: "NEW",
        stopPrice: String(child.trigger_price),
        reduceOnly: true,
        updateTime: now()
      }));
    }

    const credentials = credentialsFromContext(context);
    const payload = [
      {
        symbol: toApiSymbol(uiSymbol),
        algo_type: "POSITIONAL_TP_SL",
        trigger_price_type: workingType,
        margin_mode: "CROSS",
        order_tag: credentials.orderTag || undefined,
        child_orders: childOrders
      }
    ];
    return (await this.request(context, "POST", "/v1/algo/order", payload, { signed: true })).data;
  }

  async cancelOrder(context, { symbol, orderId }) {
    const uiSymbol = toUiSymbol(symbol);
    if (context.mode === "dry-run") {
      const before = this.dryRun.openOrders.length;
      this.dryRun.openOrders = this.dryRun.openOrders.filter((order) => {
        if (order.symbol !== uiSymbol) return true;
        return String(order.order_id) !== String(orderId);
      });
      return { symbol: uiSymbol, orderId, canceled: before !== this.dryRun.openOrders.length };
    }
    return (await this.request(context, "DELETE", "/v1/order", {
      symbol: toApiSymbol(uiSymbol),
      order_id: orderId
    }, { signed: true })).data;
  }

  async cancelAllOpenOrders(context, symbol) {
    const uiSymbol = symbol ? toUiSymbol(symbol) : undefined;
    if (context.mode === "dry-run") {
      const before = this.dryRun.openOrders.length;
      this.dryRun.openOrders = this.dryRun.openOrders.filter((order) => uiSymbol && order.symbol !== uiSymbol);
      return { code: 200, msg: `Dry-run canceled ${before - this.dryRun.openOrders.length} open order(s).` };
    }
    return (await this.request(context, "DELETE", "/v1/orders", {
      symbol: uiSymbol ? toApiSymbol(uiSymbol) : undefined
    }, { signed: true })).data;
  }

  async queryOrder(context, { symbol, orderId }) {
    const uiSymbol = toUiSymbol(symbol);
    if (context.mode === "dry-run") {
      const order = this.dryRun.openOrders.find((item) => (
        item.symbol === uiSymbol && String(item.order_id) === String(orderId)
      ));
      if (!order) return { symbol: uiSymbol, orderId, status: "CANCELED" };
      return normalizeOrder(order);
    }
    return normalizeOrder((await this.request(
      context,
      "GET",
      `/v1/order/${encodeURIComponent(orderId)}`,
      {},
      { signed: true }
    )).data);
  }

  async closePositions(context, { symbol }) {
    const positions = await this.getPositions(context, symbol);
    const active = positions.filter((position) => nonZero(position.positionAmt));
    const results = [];

    for (const position of active) {
      const amount = toNumber(position.positionAmt);
      const side = amount > 0 ? ORDER_SIDES.SELL : ORDER_SIDES.BUY;
      const result = await this.placeMarketOrder(context, {
        symbol: position.symbol,
        side,
        quantity: Math.abs(amount),
        reduceOnly: true,
        action: "CLOSE"
      });
      results.push({ position, order: result });
    }

    if (context.mode === "dry-run") {
      this.dryRun.positions = this.dryRun.positions.map((position) => (
        !symbol || position.symbol === toUiSymbol(symbol)
          ? { ...position, position_qty: 0, positionAmt: "0" }
          : position
      ));
    }

    return results;
  }

  roundPriceForSide(symbolInfo, side, rawPrice, tickOffset = 0, postOnly = true) {
    const tick = toNumber(symbolInfo.tickSize, 0.0001);
    const offset = tick * Number(tickOffset || 0);
    const adjusted = side === ORDER_SIDES.BUY ? rawPrice + offset : rawPrice - offset;
    const mode = side === ORDER_SIDES.BUY && postOnly ? "down" : side === ORDER_SIDES.SELL && postOnly ? "up" : "nearest";
    return roundToStep(adjusted, tick, mode);
  }
}
