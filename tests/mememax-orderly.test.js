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

test("MemeMax positional bracket packs SL and TP in one adapter call", async () => {
  const adapter = new MememaxOrderlyAdapter();
  const result = await adapter.placePositionBracketOrder(
    { mode: "dry-run", credentials: {} },
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
  const context = { mode: "dry-run", credentials: {} };

  const symbols = await adapter.getSymbols(context);
  const ticker = await adapter.getTicker(context, "BTCUSDC");
  const book = await adapter.getOrderBook(context, { symbol: "BTCUSDC", limit: 1 });
  const klines = await adapter.getKlines(context, { symbol: "BTCUSDC", interval: "15s", limit: 4 });

  assert.equal(symbols[0].symbol, "BTCUSDC");
  assert.equal(ticker.price, "65000.0");
  assert.equal(book.source, "dry-run");
  assert.equal(book.bids[0][0], "64999");
  assert.equal(book.asks[0][0], "65001");
  assert.equal(klines.length, 4);
  assert.ok(klines.every((row) => Number(row.close) > 64000 && Number(row.close) < 66000));
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
