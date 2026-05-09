import assert from "node:assert/strict";
import test from "node:test";
import { MememaxOrderlyAdapter } from "../src/exchanges/mememax-orderly.js";

test("MemeMax request preserves array JSON bodies", async () => {
  const adapter = new MememaxOrderlyAdapter();
  const originalFetch = global.fetch;
  let capturedBody = "";

  adapter.baseUrl = () => "https://example.invalid";
  global.fetch = async (url, options) => {
    capturedBody = options.body;
    return new Response('{"success":true,"data":{}}', {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    await adapter.request({ mode: "live", credentials: {} }, "POST", "/v1/algo/order", [
      {
        symbol: "PERP_BTC_USDC",
        empty: "",
        child_orders: [{ trigger_price: 65000, drop: null }]
      }
    ]);
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(capturedBody, '[{"symbol":"PERP_BTC_USDC","child_orders":[{"trigger_price":65000}]}]');
});

test("MemeMax signed requests apply configured Orderly credentials", async () => {
  const adapter = new MememaxOrderlyAdapter();
  const originalFetch = global.fetch;
  let capturedUrl = "";
  let capturedHeaders = {};

  global.fetch = async (url, options) => {
    capturedUrl = String(url);
    capturedHeaders = options.headers;
    return new Response('{"success":true,"data":{}}', {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    await adapter.request(
      {
        mode: "live",
        credentials: {
          accountId: "0x0000000000000000000000000000000000000000000000000000000000000001",
          orderlyKey: "ed25519:test-public-key",
          orderlySecret: "1111111111111111111111111111111",
          baseUrl: "https://api.example.mememax"
        }
      },
      "GET",
      "/v1/client/info",
      {},
      { signed: true }
    );
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(capturedUrl, "https://api.example.mememax/v1/client/info");
  assert.equal(capturedHeaders["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(capturedHeaders["orderly-account-id"], "0x0000000000000000000000000000000000000000000000000000000000000001");
  assert.equal(capturedHeaders["orderly-key"], "ed25519:test-public-key");
  assert.match(capturedHeaders["orderly-timestamp"], /^\d+$/);
  assert.ok(capturedHeaders["orderly-signature"]);
});

test("MemeMax signed requests derive Orderly key when it is omitted", async () => {
  const adapter = new MememaxOrderlyAdapter();
  const originalFetch = global.fetch;
  let capturedHeaders = {};

  global.fetch = async (url, options) => {
    capturedHeaders = options.headers;
    return new Response('{"success":true,"data":{}}', {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    await adapter.request(
      {
        mode: "live",
        credentials: {
          accountId: "0x0000000000000000000000000000000000000000000000000000000000000002",
          orderlySecret: "1111111111111111111111111111111",
          baseUrl: "https://api.example.mememax"
        }
      },
      "GET",
      "/v1/client/info",
      {},
      { signed: true }
    );
  } finally {
    global.fetch = originalFetch;
  }

  assert.match(capturedHeaders["orderly-key"], /^ed25519:[1-9A-HJ-NP-Za-km-z]+$/);
  assert.notEqual(capturedHeaders["orderly-key"], "1111111111111111111111111111111");
  assert.ok(capturedHeaders["orderly-signature"]);
});

test("MemeMax positional bracket packs SL and TP in one adapter call", async () => {
  const adapter = new MememaxOrderlyAdapter();
  const result = await adapter.placePositionBracketOrder(
    { mode: "dry-run", marketDataMode: "mock", credentials: {} },
    {
      symbol: "BTCUSDC",
      side: "SELL",
      positionSide: "LONG",
      stopLossPrice: 64000,
      takeProfitPrice: 67000,
      workingType: "MARK_PRICE"
    }
  );

  assert.equal(result.length, 2);
  assert.deepEqual(result.map((order) => order.strategyType), ["STOP_LOSS", "TAKE_PROFIT"]);
  assert.deepEqual(result.map((order) => order.stopPrice), ["64000", "67000"]);
});

test("MemeMax dry-run market data stays internally coherent", async () => {
  const adapter = new MememaxOrderlyAdapter();
  const context = { mode: "dry-run", marketDataMode: "mock", credentials: {} };

  const symbols = await adapter.getSymbols(context);
  const ticker = await adapter.getTicker(context, "BTCUSDC");
  const book = await adapter.getOrderBook(context, { symbol: "BTCUSDC", limit: 1 });
  const klines = await adapter.getKlines(context, { symbol: "BTCUSDC", interval: "15s", limit: 4 });

  assert.equal(symbols[0].symbol, "BTCUSDC");
  assert.equal(ticker.price, "65000.0");
  assert.equal(book.source, "mock");
  assert.equal(book.bids[0][0], "64999");
  assert.equal(book.asks[0][0], "65001");
  assert.equal(klines.length, 4);
  assert.ok(klines.every((row) => Number(row.close) > 64000 && Number(row.close) < 66000));
});

test("MemeMax dry-run uses live public market data when enabled", async () => {
  const adapter = new MememaxOrderlyAdapter();
  const originalFetch = global.fetch;
  const requested = [];

  adapter.baseUrl = () => "https://api.example.orderly";
  global.fetch = async (url, options) => {
    requested.push({ url: String(url), headers: options.headers });
    return new Response('{"success":true,"data":{"symbol":"PERP_BTC_USDC","last_price":"70123.4"}}', {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const ticker = await adapter.getTicker(
      { mode: "dry-run", marketDataMode: "live", credentials: {} },
      "BTCUSDC"
    );
    assert.equal(ticker.price, "70123.4");
    assert.equal(ticker.source, "rest");
    assert.ok(requested[0].url.includes("/v1/public/futures/PERP_BTC_USDC"));
    assert.equal(requested[0].headers["orderly-signature"], undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test("MemeMax live market data mode does not fall back to mock prices", async () => {
  const adapter = new MememaxOrderlyAdapter();
  const originalFetch = global.fetch;

  adapter.baseUrl = () => "https://api.example.orderly";
  global.fetch = async () => new Response('{"success":false,"message":"public market unavailable"}', {
    status: 503,
    headers: { "content-type": "application/json" }
  });

  try {
    await assert.rejects(
      adapter.getTicker(
        { mode: "dry-run", marketDataMode: "live", credentials: {} },
        "BTCUSDC"
      ),
      /public market unavailable/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("MemeMax dry-run signs read-only market data endpoints when credentials are configured", async () => {
  const adapter = new MememaxOrderlyAdapter();
  const originalFetch = global.fetch;
  const capturedHeaders = {};

  adapter.baseUrl = () => "https://api.example.orderly";
  adapter.ensureMarketDataStream = () => false;
  global.fetch = async (url, options) => {
    Object.assign(capturedHeaders, options.headers);
    assert.ok(String(url).includes("/v1/orderbook/PERP_BTC_USDC"));
    return new Response(JSON.stringify({
      success: true,
      data: {
        timestamp: 1778364700000,
        bids: [{ price: 80700, quantity: 0.1 }],
        asks: [{ price: 80701, quantity: 0.2 }]
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const orderBook = await adapter.getOrderBook(
      {
        mode: "dry-run",
        marketDataMode: "live",
        credentials: {
          accountId: "0x0000000000000000000000000000000000000000000000000000000000000002",
          orderlySecret: "1111111111111111111111111111111"
        }
      },
      { symbol: "BTCUSDC", limit: 1 }
    );
    assert.equal(capturedHeaders["orderly-account-id"], "0x0000000000000000000000000000000000000000000000000000000000000002");
    assert.ok(capturedHeaders["orderly-key"]);
    assert.ok(capturedHeaders["orderly-signature"]);
    assert.deepEqual(orderBook.bids[0], ["80700", "0.1"]);
    assert.deepEqual(orderBook.asks[0], ["80701", "0.2"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("MemeMax subscribes to Orderly trade and kline websocket topics", () => {
  const adapter = new MememaxOrderlyAdapter();
  const topics = [];

  adapter.sendJson = (ws, payload) => {
    topics.push(payload.topic);
    return true;
  };
  adapter.marketStream.klineSubscriptions.add("PERP_BTC_USDC@kline_1m");
  adapter.sendMarketSubscriptions("PERP_BTC_USDC");

  assert.ok(topics.includes("PERP_BTC_USDC@bbo"));
  assert.ok(topics.includes("PERP_BTC_USDC@orderbook"));
  assert.ok(topics.includes("PERP_BTC_USDC@ticker"));
  assert.ok(topics.includes("PERP_BTC_USDC@trade"));
  assert.ok(topics.includes("PERP_BTC_USDC@kline_1m"));
});

test("MemeMax focus unsubscribes stale Orderly websocket topics", () => {
  const adapter = new MememaxOrderlyAdapter();
  const originalWebSocket = global.WebSocket;
  const messages = [];

  function FakeWebSocket() {}
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;
  global.WebSocket = FakeWebSocket;

  adapter.marketStream.ws = { readyState: FakeWebSocket.OPEN, close() {} };
  adapter.marketStream.subscriptions.add("PERP_BTC_USDC");
  adapter.marketStream.subscriptions.add("PERP_ETH_USDC");
  adapter.marketStream.klineSubscriptions.add("PERP_BTC_USDC@kline_1m");
  adapter.marketStream.klineSubscriptions.add("PERP_BTC_USDC@kline_5m");
  adapter.marketStream.klineSubscriptions.add("PERP_ETH_USDC@kline_1m");
  adapter.sendJson = (ws, payload) => {
    messages.push(payload);
    return true;
  };

  try {
    const focused = adapter.focusMarketDataStream(
      { mode: "live", credentials: { accountId: "account-id" } },
      { symbol: "BTCUSDC", interval: "15s" }
    );

    assert.equal(focused, true);
    assert.deepEqual(Array.from(adapter.marketStream.subscriptions), ["PERP_BTC_USDC"]);
    assert.deepEqual(Array.from(adapter.marketStream.klineSubscriptions), ["PERP_BTC_USDC@kline_1m"]);
    assert.ok(messages.some((payload) => payload.event === "unsubscribe" && payload.topic === "PERP_ETH_USDC@bbo"));
    assert.ok(messages.some((payload) => payload.event === "unsubscribe" && payload.topic === "PERP_ETH_USDC@orderbook"));
    assert.ok(messages.some((payload) => payload.event === "unsubscribe" && payload.topic === "PERP_ETH_USDC@ticker"));
    assert.ok(messages.some((payload) => payload.event === "unsubscribe" && payload.topic === "PERP_ETH_USDC@trade"));
    assert.ok(messages.some((payload) => payload.event === "unsubscribe" && payload.topic === "PERP_ETH_USDC@kline_1m"));
    assert.ok(messages.some((payload) => payload.event === "unsubscribe" && payload.topic === "PERP_BTC_USDC@kline_5m"));
  } finally {
    global.WebSocket = originalWebSocket;
  }
});

test("MemeMax caches Orderly websocket kline updates", () => {
  const adapter = new MememaxOrderlyAdapter();

  adapter.handleMarketMessage(null, JSON.stringify({
    topic: "PERP_BTC_USDC@kline_1m",
    data: {
      startTime: 1700000000000,
      endTime: 1700000059999,
      open: "65000",
      high: "65100",
      low: "64950",
      close: "65050",
      volume: "12.5"
    }
  }));

  const rows = adapter.cachedKlines("BTCUSDC", "1m", 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].openTime, 1700000000000);
  assert.equal(rows[0].close, "65050");
  assert.equal(rows[0].volume, "12.5");
});

test("MemeMax builds 15s candles from Orderly websocket trades", () => {
  const adapter = new MememaxOrderlyAdapter();

  adapter.handleMarketMessage(null, JSON.stringify({
    topic: "PERP_BTC_USDC@trade",
    ts: 1700000000123,
    data: { price: "65000", size: "0.1", timestamp: 1700000000123 }
  }));
  adapter.handleMarketMessage(null, JSON.stringify({
    topic: "PERP_BTC_USDC@trade",
    ts: 1700000005123,
    data: { price: "65020", size: "0.2", timestamp: 1700000005123 }
  }));

  const rows = adapter.cachedKlines("BTCUSDC", "15s", 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].open, "65000");
  assert.equal(rows[0].high, "65020");
  assert.equal(rows[0].low, "65000");
  assert.equal(rows[0].close, "65020");
  assert.equal(rows[0].volume, "0.3");
});
