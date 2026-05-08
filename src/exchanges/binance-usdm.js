import crypto from "node:crypto";
import { ExchangeError, ORDER_SIDES, POSITION_SIDES } from "./types.js";

const MAINNET_BASE_URL = "https://fapi.binance.com";
const PORTFOLIO_MARGIN_BASE_URL = "https://papi.binance.com";
const TESTNET_BASE_URL = "https://testnet.binancefuture.com";
const DEFAULT_RECV_WINDOW = 5000;
const FIFTEEN_SECONDS_MS = 15_000;

const PORTFOLIO_UM_PATHS = new Map([
  ["/fapi/v1/listenKey", "/papi/v1/listenKey"],
  ["/fapi/v1/order", "/papi/v1/um/order"],
  ["/fapi/v1/order/test", "/papi/v1/um/order/test"],
  ["/fapi/v1/openOrders", "/papi/v1/um/openOrders"],
  ["/fapi/v1/allOpenOrders", "/papi/v1/um/allOpenOrders"],
  ["/fapi/v1/leverage", "/papi/v1/um/leverage"],
  ["/fapi/v1/leverageBracket", "/papi/v1/um/leverageBracket"],
  ["/fapi/v3/balance", "/papi/v1/balance"],
  ["/fapi/v3/positionRisk", "/papi/v1/um/positionRisk"],
  ["/fapi/v1/conditional/order", "/papi/v1/um/conditional/order"]
]);

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
  return value.toFixed(12).replace(/\.?0+$/, "");
}

function getFilter(symbolInfo, filterType) {
  return symbolInfo?.filters?.find((filter) => filter.filterType === filterType);
}

function roundToStep(value, step, mode = "nearest") {
  const numericStep = toNumber(step, 0);
  if (!numericStep) return trimDecimal(value);
  const factor = 1 / numericStep;
  let rounded = value * factor;
  if (mode === "up") rounded = Math.ceil(rounded);
  else if (mode === "down") rounded = Math.floor(rounded);
  else rounded = Math.round(rounded);
  return trimDecimal(rounded / factor);
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
  return {
    openTime: row[0],
    open: row[1],
    high: row[2],
    low: row[3],
    close: row[4],
    volume: row[5],
    closeTime: row[6]
  };
}

function aggregateTradesToKlines(trades, { limit, intervalMs, endTime, fallbackPrice = 0, seedRows = null }) {
  const endBucket = Math.floor(endTime / intervalMs) * intervalMs;
  const startTime = endBucket - (limit - 1) * intervalMs;
  const rows = seedRows
    ? seedRows.map((row) => ({ ...row }))
    : Array.from({ length: limit }, (_, index) => ({
      openTime: startTime + index * intervalMs,
      open: "",
      high: "",
      low: "",
      close: "",
      volume: "0",
      closeTime: startTime + index * intervalMs + intervalMs - 1
    }));
  const touched = new Set();

  const sortedTrades = [...trades].sort((a, b) => toNumber(a.T) - toNumber(b.T));
  for (const trade of sortedTrades) {
    const tradeTime = toNumber(trade.T);
    const index = Math.floor((tradeTime - startTime) / intervalMs);
    if (index < 0 || index >= rows.length) continue;
    const price = toNumber(trade.p);
    const quantity = toNumber(trade.q);
    if (!price) continue;

    const row = rows[index];
    if (!touched.has(index)) {
      row.open = trimDecimal(price);
      row.high = trimDecimal(price);
      row.low = trimDecimal(price);
      row.volume = "0";
      touched.add(index);
    }
    row.high = trimDecimal(Math.max(toNumber(row.high), price));
    row.low = trimDecimal(Math.min(toNumber(row.low), price));
    row.close = trimDecimal(price);
    row.volume = trimDecimal(toNumber(row.volume) + quantity);
  }

  const firstFilled = rows.find((row) => row.open);
  let lastClose = toNumber(firstFilled?.open, toNumber(fallbackPrice, 0));
  for (const row of rows) {
    if (!row.open) {
      const price = lastClose || toNumber(fallbackPrice, 0);
      row.open = trimDecimal(price);
      row.high = trimDecimal(price);
      row.low = trimDecimal(price);
      row.close = trimDecimal(price);
      row.volume = "0";
    } else {
      if (!row.close) row.close = row.open;
      lastClose = toNumber(row.close, lastClose);
    }
  }

  return rows;
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
    const segmentHigh = Math.min(high, Math.max(segmentOpen, segmentClose) + syntheticWick);
    const segmentLow = Math.max(low, Math.min(segmentOpen, segmentClose) - syntheticWick);
    lastClose = segmentClose;

    rows.push({
      openTime,
      open: trimDecimal(segmentOpen),
      high: trimDecimal(segmentHigh),
      low: trimDecimal(segmentLow),
      close: trimDecimal(segmentClose),
      volume: trimDecimal(toNumber(minute.volume, 0) / 4),
      closeTime: openTime + FIFTEEN_SECONDS_MS - 1
    });
  }

  return rows;
}

function normalizePosition(row) {
  const amount = toNumber(row.positionAmt);
  return {
    symbol: row.symbol,
    positionSide: row.positionSide || POSITION_SIDES.BOTH,
    positionAmt: row.positionAmt,
    entryPrice: row.entryPrice,
    breakEvenPrice: row.breakEvenPrice,
    markPrice: row.markPrice,
    unRealizedProfit: row.unRealizedProfit,
    liquidationPrice: row.liquidationPrice,
    notional: row.notional,
    marginAsset: row.marginAsset,
    leverage: row.leverage || "",
    side: amount > 0 ? "LONG" : amount < 0 ? "SHORT" : "FLAT",
    updateTime: row.updateTime
  };
}

function firstNumericText(row, keys, fallback = "0") {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") {
      return String(row[key]);
    }
  }
  return fallback;
}

function normalizeBalance(row) {
  const walletBalance = firstNumericText(row, ["balance", "walletBalance", "totalWalletBalance", "crossWalletBalance"]);
  const availableBalance = firstNumericText(row, ["availableBalance", "maxWithdrawAmount", "crossWalletBalance"], walletBalance);
  const crossWalletBalance = firstNumericText(row, ["crossWalletBalance", "totalWalletBalance"], walletBalance);
  return {
    asset: row.asset || row.marginAsset || row.collateralAsset,
    walletBalance,
    balance: walletBalance,
    crossWalletBalance,
    crossUnPnl: firstNumericText(row, [
      "crossUnPnl",
      "crossUnPNL",
      "unrealizedProfit",
      "unRealizedProfit",
      "totalUnrealizedProfit",
      "totalUnrealizedPNL",
      "umUnrealizedPNL"
    ]),
    availableBalance,
    maxWithdrawAmount: firstNumericText(row, ["maxWithdrawAmount"], availableBalance),
    marginAvailable: row.marginAvailable,
    negativeBalance: firstNumericText(row, ["negativeBalance"], "0"),
    updateTime: row.updateTime || now()
  };
}

function normalizeOrder(row) {
  return {
    symbol: row.symbol,
    orderId: row.orderId,
    clientOrderId: row.clientOrderId,
    side: row.side,
    positionSide: row.positionSide || POSITION_SIDES.BOTH,
    type: row.type,
    status: row.status,
    price: row.price,
    avgPrice: row.avgPrice,
    origQty: row.origQty,
    executedQty: row.executedQty,
    reduceOnly: Boolean(row.reduceOnly),
    timeInForce: row.timeInForce,
    updateTime: row.updateTime || row.time
  };
}

function credentialsFromContext(context) {
  return {
    apiKey: context.credentials?.apiKey || "",
    apiSecret: context.credentials?.apiSecret || ""
  };
}

function parseRetryAfter(headerValue) {
  if (!headerValue) return 0;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(headerValue);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - now()) : 0;
}

export class BinanceUsdmAdapter {
  constructor() {
    this.id = "binance-usdm";
    this.label = "Binance USD-M Futures";
    this.modes = ["dry-run", "testnet", "live"];
    this.symbolCache = new Map();
    this.dryRun = {
      orderId: 9000000,
      openOrders: [],
      leverageBySymbol: new Map(),
      balances: [
        {
          asset: "USDC",
          balance: "100000",
          crossWalletBalance: "100000",
          crossUnPnl: "0",
          availableBalance: "100000",
          maxWithdrawAmount: "100000",
          marginAvailable: true,
          updateTime: now()
        },
        {
          asset: "USDT",
          balance: "100000",
          crossWalletBalance: "100000",
          crossUnPnl: "0",
          availableBalance: "100000",
          maxWithdrawAmount: "100000",
          marginAvailable: true,
          updateTime: now()
        }
      ],
      positions: []
    };
  }

  baseUrl(context, options = {}) {
    if ((options.signed || options.apiKeyOnly) && context.accountMode === "portfolio") {
      if (context.mode === "testnet") {
        throw new ExchangeError("Portfolio Margin signed endpoints are not configured for testnet in this app");
      }
      return PORTFOLIO_MARGIN_BASE_URL;
    }
    return context.mode === "testnet" ? TESTNET_BASE_URL : MAINNET_BASE_URL;
  }

  routePath(context, path, options = {}) {
    if ((options.signed || options.apiKeyOnly) && context.accountMode === "portfolio") {
      return PORTFOLIO_UM_PATHS.get(path) || path;
    }
    return path;
  }

  async request(context, method, path, params = {}, options = {}) {
    if (context.mode === "dry-run" && options.signed) {
      throw new ExchangeError("Signed endpoint is not available in dry-run");
    }

    const routedPath = this.routePath(context, path, options);
    const url = new URL(routedPath, this.baseUrl(context, options));
    const bodyParams = new URLSearchParams();
    const targetParams = method === "GET" || method === "DELETE" ? url.searchParams : bodyParams;

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        targetParams.set(key, String(value));
      }
    }

    const headers = {
      "Content-Type": "application/x-www-form-urlencoded"
    };

    if (options.signed || options.apiKeyOnly) {
      const { apiKey, apiSecret } = credentialsFromContext(context);
      if (!apiKey || (options.signed && !apiSecret)) {
        throw new ExchangeError("API key and secret are required for this action");
      }
      headers["X-MBX-APIKEY"] = apiKey;
      if (options.signed) {
        targetParams.set("timestamp", String(now()));
        targetParams.set("recvWindow", String(params.recvWindow || DEFAULT_RECV_WINDOW));
        const signature = crypto
          .createHmac("sha256", apiSecret)
          .update(targetParams.toString())
          .digest("hex");
        targetParams.set("signature", signature);
      }
    }

    const response = await fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "DELETE" ? undefined : bodyParams
    });

    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = {
          msg: text.slice(0, 300),
          nonJson: true
        };
      }
    }

    if (payload.nonJson && response.ok) {
      throw new ExchangeError("Binance returned an unexpected non-JSON response", {
        status: response.status,
        path: routedPath,
        requestedPath: path,
        accountMode: context.accountMode,
        nonJson: true,
        transient: true
      });
    }

    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      throw new ExchangeError(payload.msg || `Binance request failed with ${response.status}`, {
        code: payload.code,
        status: response.status,
        path: routedPath,
        requestedPath: path,
        accountMode: context.accountMode,
        retryAfterMs,
        usedWeight1m: response.headers.get("x-mbx-used-weight-1m"),
        orderCount10s: response.headers.get("x-mbx-order-count-10s"),
        orderCount1m: response.headers.get("x-mbx-order-count-1m"),
        nonJson: Boolean(payload.nonJson)
      });
    }

    return payload;
  }

  async getExchangeInfo(context) {
    const cacheKey = context.mode;
    const cached = this.symbolCache.get(cacheKey);
    if (cached && now() - cached.time < 10 * 60_000) {
      return cached.payload;
    }

    try {
      const payload = await this.request(context, "GET", "/fapi/v1/exchangeInfo");
      this.symbolCache.set(cacheKey, { time: now(), payload });
      return payload;
    } catch (error) {
      if (context.mode !== "dry-run") throw error;
      return {
        symbols: [
          {
            symbol: "BTCUSDC",
            pair: "BTCUSDC",
            contractType: "PERPETUAL",
            status: "TRADING",
            baseAsset: "BTC",
            quoteAsset: "USDC",
            marginAsset: "USDC",
            filters: [
              { filterType: "PRICE_FILTER", minPrice: "0.1", maxPrice: "10000000", tickSize: "0.1" },
              { filterType: "LOT_SIZE", minQty: "0.001", maxQty: "1000", stepSize: "0.001" },
              { filterType: "MIN_NOTIONAL", notional: "5" }
            ]
          },
          {
            symbol: "BTCUSDT",
            pair: "BTCUSDT",
            contractType: "PERPETUAL",
            status: "TRADING",
            baseAsset: "BTC",
            quoteAsset: "USDT",
            marginAsset: "USDT",
            filters: [
              { filterType: "PRICE_FILTER", minPrice: "0.1", maxPrice: "10000000", tickSize: "0.1" },
              { filterType: "LOT_SIZE", minQty: "0.001", maxQty: "1000", stepSize: "0.001" },
              { filterType: "MIN_NOTIONAL", notional: "5" }
            ]
          },
          {
            symbol: "ETHUSDT",
            pair: "ETHUSDT",
            contractType: "PERPETUAL",
            status: "TRADING",
            baseAsset: "ETH",
            quoteAsset: "USDT",
            marginAsset: "USDT",
            filters: [
              { filterType: "PRICE_FILTER", minPrice: "0.01", maxPrice: "1000000", tickSize: "0.01" },
              { filterType: "LOT_SIZE", minQty: "0.001", maxQty: "10000", stepSize: "0.001" },
              { filterType: "MIN_NOTIONAL", notional: "5" }
            ]
          }
        ]
      };
    }
  }

  async getSymbols(context) {
    const info = await this.getExchangeInfo(context);
    return info.symbols
      .filter((symbol) => symbol.status === "TRADING" && symbol.contractType === "PERPETUAL")
      .map((symbol) => {
        const priceFilter = getFilter(symbol, "PRICE_FILTER");
        const lotFilter = getFilter(symbol, "LOT_SIZE");
        const minNotional = getFilter(symbol, "MIN_NOTIONAL");
        return {
          symbol: symbol.symbol,
          baseAsset: symbol.baseAsset,
          quoteAsset: symbol.quoteAsset,
          marginAsset: symbol.marginAsset,
          tickSize: priceFilter?.tickSize || "0.01",
          stepSize: lotFilter?.stepSize || "0.001",
          minQty: lotFilter?.minQty || "0",
          minNotional: minNotional?.notional || "0"
        };
      })
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  async getSymbol(context, symbol) {
    const symbols = await this.getSymbols(context);
    return symbols.find((item) => item.symbol === symbol) || symbols[0];
  }

  async getTicker(context, symbol) {
    try {
      return await this.request(context, "GET", "/fapi/v2/ticker/price", { symbol });
    } catch (error) {
      if (context.mode !== "dry-run") throw error;
      return { symbol, price: "65000.0", time: now(), fallback: true };
    }
  }

  async getFifteenSecondKlines(context, { symbol, limit = 180 }) {
    const numericLimit = Math.max(1, Math.min(240, Number(limit) || 180));
    try {
      const endTime = now();
      const minuteLimit = Math.ceil(numericLimit / 4) + 2;
      const [trades, ticker, minuteRows] = await Promise.all([
        this.request(context, "GET", "/fapi/v1/aggTrades", {
          symbol,
          limit: 1000
        }),
        this.getTicker(context, symbol).catch(() => ({ price: "0" })),
        this.request(context, "GET", "/fapi/v1/klines", {
          symbol,
          interval: "1m",
          limit: minuteLimit
        }).then((rows) => rows.map(mapKline)).catch(() => [])
      ]);
      const seedRows = seedFifteenSecondRows(minuteRows, {
        limit: numericLimit,
        endTime,
        fallbackPrice: ticker.price
      });

      return aggregateTradesToKlines(trades, {
        limit: numericLimit,
        intervalMs: FIFTEEN_SECONDS_MS,
        endTime,
        fallbackPrice: ticker.price,
        seedRows
      });
    } catch (error) {
      if (context.mode !== "dry-run") throw error;
      const ticker = await this.getTicker(context, symbol).catch(() => ({ price: "65000" }));
      return buildMockKlines(numericLimit, FIFTEEN_SECONDS_MS, ticker.price);
    }
  }

  async getKlines(context, { symbol, interval = "15s", limit = 180 }) {
    if (interval === "15s") {
      return this.getFifteenSecondKlines(context, { symbol, limit });
    }

    try {
      const rows = await this.request(context, "GET", "/fapi/v1/klines", { symbol, interval, limit });
      return rows.map(mapKline);
    } catch (error) {
      if (context.mode !== "dry-run") throw error;
      return buildMockKlines(Number(limit));
    }
  }

  async getOrderBook(context, { symbol, limit = 20 }) {
    try {
      return await this.request(context, "GET", "/fapi/v1/depth", { symbol, limit });
    } catch (error) {
      if (context.mode !== "dry-run") throw error;
      const mid = symbol.startsWith("ETH") ? 3200 : 65000;
      const tick = symbol.startsWith("ETH") ? 0.1 : 1;
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

  async getLeverageBracket(context, symbol) {
    if (context.mode === "dry-run") {
      const fallbackMax = symbol?.includes("BTC") ? 125 : symbol?.includes("ETH") ? 100 : 75;
      return {
        symbol,
        maxLeverage: fallbackMax,
        brackets: [
          {
            bracket: 1,
            initialLeverage: fallbackMax,
            notionalCap: "100000",
            notionalFloor: "0"
          }
        ],
        fallback: true
      };
    }

    const rows = await this.request(context, "GET", "/fapi/v1/leverageBracket", { symbol }, { signed: true });
    const item = Array.isArray(rows) ? rows.find((row) => row.symbol === symbol) || rows[0] : rows;
    const maxLeverage = Math.max(...(item?.brackets || []).map((bracket) => toNumber(bracket.initialLeverage, 1)), 1);
    return {
      symbol: item?.symbol || symbol,
      maxLeverage,
      brackets: item?.brackets || []
    };
  }

  userDataStreamUrl(context, listenKey) {
    if (context.accountMode === "portfolio") {
      return `wss://fstream.binance.com/pm/ws/${encodeURIComponent(listenKey)}`;
    }
    if (context.mode === "testnet") {
      return `wss://stream.binancefuture.com/ws/${encodeURIComponent(listenKey)}`;
    }
    return `wss://fstream.binance.com/private/ws/${encodeURIComponent(listenKey)}`;
  }

  async createUserDataStream(context) {
    if (context.mode === "dry-run") {
      throw new ExchangeError("User data stream is not available in dry-run");
    }
    const payload = await this.request(context, "POST", "/fapi/v1/listenKey", {}, { apiKeyOnly: true });
    if (!payload.listenKey) {
      throw new ExchangeError("Binance did not return a listenKey");
    }
    return {
      listenKey: payload.listenKey,
      streamUrl: this.userDataStreamUrl(context, payload.listenKey)
    };
  }

  async keepAliveUserDataStream(context) {
    if (context.mode === "dry-run") return {};
    return await this.request(context, "PUT", "/fapi/v1/listenKey", {}, { apiKeyOnly: true });
  }

  async closeUserDataStream(context) {
    if (context.mode === "dry-run") return {};
    return await this.request(context, "DELETE", "/fapi/v1/listenKey", {}, { apiKeyOnly: true });
  }

  async getBalances(context) {
    if (context.mode === "dry-run") {
      return this.dryRun.balances.map(normalizeBalance);
    }
    const payload = await this.request(context, "GET", "/fapi/v3/balance", {}, { signed: true });
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray(payload.assets)
      ? payload.assets
      : Array.isArray(payload.balances)
      ? payload.balances
      : [payload];
    return rows.map(normalizeBalance);
  }

  async getPositions(context, symbol) {
    if (context.mode === "dry-run") {
      return this.dryRun.positions
        .filter((position) => !symbol || position.symbol === symbol)
        .filter((position) => nonZero(position.positionAmt))
        .map(normalizePosition);
    }
    const rows = await this.request(context, "GET", "/fapi/v3/positionRisk", { symbol }, { signed: true });
    return rows.filter((row) => nonZero(row.positionAmt) || nonZero(row.openOrderInitialMargin)).map(normalizePosition);
  }

  async getOpenOrders(context, symbol) {
    if (context.mode === "dry-run") {
      return this.dryRun.openOrders
        .filter((order) => !symbol || order.symbol === symbol)
        .map(normalizeOrder);
    }
    const rows = await this.request(context, "GET", "/fapi/v1/openOrders", { symbol }, { signed: true });
    return rows.map(normalizeOrder);
  }

  async setLeverage(context, { symbol, leverage }) {
    if (context.mode === "dry-run") {
      this.dryRun.leverageBySymbol.set(symbol, Number(leverage));
      return { symbol, leverage: Number(leverage), maxNotionalValue: "dry-run" };
    }
    return await this.request(context, "POST", "/fapi/v1/leverage", { symbol, leverage }, { signed: true });
  }

  async placeLimitOrder(context, order) {
    const symbolInfo = await this.getSymbol(context, order.symbol);
    const price = roundToStep(toNumber(order.price), symbolInfo.tickSize, "nearest");
    const quantity = roundToStep(toNumber(order.quantity), symbolInfo.stepSize, "down");

    if (context.mode === "dry-run") {
      const mockOrder = {
        orderId: this.dryRun.orderId += 1,
        clientOrderId: `dry_${this.dryRun.orderId}`,
        symbol: order.symbol,
        side: order.side,
        positionSide: order.positionSide || POSITION_SIDES.BOTH,
        type: "LIMIT",
        status: "NEW",
        price,
        avgPrice: "0",
        origQty: quantity,
        executedQty: "0",
        reduceOnly: Boolean(order.reduceOnly),
        timeInForce: order.timeInForce || "GTC",
        updateTime: now()
      };
      this.dryRun.openOrders.push(mockOrder);
      return normalizeOrder(mockOrder);
    }

    const payload = {
      symbol: order.symbol,
      side: order.side,
      positionSide: order.positionSide,
      type: "LIMIT",
      timeInForce: order.timeInForce || "GTC",
      quantity,
      price,
      reduceOnly: order.reduceOnly ? "true" : undefined,
      newOrderRespType: "ACK"
    };

    const path = context.mode === "testnet" && order.testOnly ? "/fapi/v1/order/test" : "/fapi/v1/order";
    return await this.request(context, "POST", path, payload, { signed: true });
  }

  applyDryRunMarketFill(order, quantity) {
    const positionSide = order.positionSide || POSITION_SIDES.BOTH;
    const existing = this.dryRun.positions.find((position) => (
      position.symbol === order.symbol && (position.positionSide || POSITION_SIDES.BOTH) === positionSide
    ));
    const current = toNumber(existing?.positionAmt, 0);
    const fillQty = toNumber(quantity, 0);
    let nextAmount = current;

    if (order.action === "CLOSE") {
      if (positionSide === POSITION_SIDES.SHORT) nextAmount = Math.min(0, current + fillQty);
      else nextAmount = Math.max(0, current - fillQty);
    } else {
      nextAmount += order.side === ORDER_SIDES.BUY ? fillQty : -fillQty;
    }

    if (Math.abs(nextAmount) < 1e-12) nextAmount = 0;

    const row = existing || {
      symbol: order.symbol,
      positionSide,
      positionAmt: "0",
      entryPrice: "65000",
      breakEvenPrice: "65000",
      markPrice: "65000",
      unRealizedProfit: "0",
      liquidationPrice: "0",
      notional: "0",
      marginAsset: order.symbol.endsWith("USDC") ? "USDC" : "USDT",
      leverage: String(this.dryRun.leverageBySymbol.get(order.symbol) || 1),
      updateTime: now()
    };

    row.positionAmt = trimDecimal(nextAmount);
    row.notional = trimDecimal(nextAmount * toNumber(row.markPrice, 65000));
    row.updateTime = now();
    if (!existing) this.dryRun.positions.push(row);
  }

  async placeMarketOrder(context, order) {
    const symbolInfo = await this.getSymbol(context, order.symbol);
    const quantity = roundToStep(toNumber(order.quantity), symbolInfo.stepSize, "down");

    if (context.mode === "dry-run") {
      this.applyDryRunMarketFill(order, quantity);
      return {
        orderId: this.dryRun.orderId += 1,
        symbol: order.symbol,
        side: order.side,
        positionSide: order.positionSide || POSITION_SIDES.BOTH,
        type: "MARKET",
        status: "FILLED",
        origQty: quantity,
        executedQty: quantity,
        reduceOnly: Boolean(order.reduceOnly),
        updateTime: now()
      };
    }

    return await this.request(
      context,
      "POST",
      "/fapi/v1/order",
      {
        symbol: order.symbol,
        side: order.side,
        positionSide: order.positionSide,
        type: "MARKET",
        quantity,
        reduceOnly: order.reduceOnly ? "true" : undefined,
        newOrderRespType: "RESULT"
      },
      { signed: true }
    );
  }

  async placeConditionalMarketOrder(context, order) {
    const symbolInfo = await this.getSymbol(context, order.symbol);
    const stopPrice = roundToStep(toNumber(order.stopPrice), symbolInfo.tickSize, "nearest");
    const quantity = roundToStep(toNumber(order.quantity), symbolInfo.stepSize, "down");

    if (context.mode === "dry-run") {
      return {
        strategyId: this.dryRun.orderId += 1,
        symbol: order.symbol,
        side: order.side,
        positionSide: order.positionSide || POSITION_SIDES.BOTH,
        strategyType: order.strategyType,
        status: "NEW",
        stopPrice,
        origQty: quantity,
        reduceOnly: Boolean(order.reduceOnly),
        updateTime: now()
      };
    }

    if (context.accountMode === "portfolio") {
      return await this.request(
        context,
        "POST",
        "/fapi/v1/conditional/order",
        {
          symbol: order.symbol,
          side: order.side,
          positionSide: order.positionSide,
          strategyType: order.strategyType,
          quantity,
          stopPrice,
          workingType: order.workingType || "MARK_PRICE",
          reduceOnly: order.reduceOnly ? "true" : undefined
        },
        { signed: true }
      );
    }

    return await this.request(
      context,
      "POST",
      "/fapi/v1/order",
      {
        symbol: order.symbol,
        side: order.side,
        positionSide: order.positionSide,
        type: order.strategyType,
        quantity,
        stopPrice,
        workingType: order.workingType || "MARK_PRICE",
        reduceOnly: order.reduceOnly ? "true" : undefined
      },
      { signed: true }
    );
  }

  async cancelOrder(context, { symbol, orderId, origClientOrderId }) {
    if (context.mode === "dry-run") {
      const before = this.dryRun.openOrders.length;
      this.dryRun.openOrders = this.dryRun.openOrders.filter((order) => {
        if (order.symbol !== symbol) return true;
        if (orderId && String(order.orderId) === String(orderId)) return false;
        if (origClientOrderId && order.clientOrderId === origClientOrderId) return false;
        return true;
      });
      return { symbol, orderId, canceled: before !== this.dryRun.openOrders.length };
    }

    return await this.request(
      context,
      "DELETE",
      "/fapi/v1/order",
      { symbol, orderId, origClientOrderId },
      { signed: true }
    );
  }

  async cancelAllOpenOrders(context, symbol) {
    if (context.mode === "dry-run") {
      const before = this.dryRun.openOrders.length;
      this.dryRun.openOrders = this.dryRun.openOrders.filter((order) => order.symbol !== symbol);
      return { code: 200, msg: `Dry-run canceled ${before - this.dryRun.openOrders.length} open order(s).` };
    }
    return await this.request(context, "DELETE", "/fapi/v1/allOpenOrders", { symbol }, { signed: true });
  }

  async queryOrder(context, { symbol, orderId, origClientOrderId }) {
    if (context.mode === "dry-run") {
      const order = this.dryRun.openOrders.find((item) => {
        if (item.symbol !== symbol) return false;
        return String(item.orderId) === String(orderId) || item.clientOrderId === origClientOrderId;
      });
      if (!order) {
        return { symbol, orderId, status: "CANCELED" };
      }
      return normalizeOrder(order);
    }
    return await this.request(
      context,
      "GET",
      "/fapi/v1/order",
      { symbol, orderId, origClientOrderId },
      { signed: true }
    );
  }

  async closePositions(context, { symbol }) {
    const positions = await this.getPositions(context, symbol);
    const active = positions.filter((position) => nonZero(position.positionAmt));
    const results = [];

    for (const position of active) {
      const amount = toNumber(position.positionAmt);
      const side = amount > 0 ? ORDER_SIDES.SELL : ORDER_SIDES.BUY;
      const hedgeMode = position.positionSide && position.positionSide !== POSITION_SIDES.BOTH;
      const result = await this.placeMarketOrder(context, {
        symbol: position.symbol,
        side,
        quantity: Math.abs(amount),
        positionSide: hedgeMode ? position.positionSide : undefined,
        reduceOnly: hedgeMode ? undefined : true
      });
      results.push({ position, order: result });
    }

    if (context.mode === "dry-run") {
      this.dryRun.positions = this.dryRun.positions.map((position) => (
        !symbol || position.symbol === symbol ? { ...position, positionAmt: "0", notional: "0" } : position
      ));
    }

    return results;
  }

  roundPriceForSide(symbolInfo, side, rawPrice, tickOffset = 0, postOnly = true) {
    const tick = toNumber(symbolInfo.tickSize, 0.01);
    const offset = tick * Number(tickOffset || 0);
    const adjusted = side === ORDER_SIDES.BUY ? rawPrice + offset : rawPrice - offset;
    const mode = side === ORDER_SIDES.BUY && postOnly ? "down" : side === ORDER_SIDES.SELL && postOnly ? "up" : "nearest";
    return roundToStep(adjusted, tick, mode);
  }
}
