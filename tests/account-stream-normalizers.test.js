import assert from "node:assert/strict";
import test from "node:test";
import { extractPrivateOrderUpdate, uiSymbolFromExchangeSymbol } from "../src/account-stream-normalizers.js";

test("normalizes Orderly symbols into UI symbols", () => {
  assert.equal(uiSymbolFromExchangeSymbol("PERP_BTC_USDC"), "BTCUSDC");
  assert.equal(uiSymbolFromExchangeSymbol("PERP_1000000_MOG_USDC.e"), "1000000MOGUSDC");
  assert.equal(uiSymbolFromExchangeSymbol("BTCUSDT"), "BTCUSDT");
});

test("extracts camelCase Orderly execution report fill fields", () => {
  const update = extractPrivateOrderUpdate({
    topic: "executionreport",
    data: {
      symbol: "PERP_BTC_USDC",
      orderId: 12345,
      status: "FILLED",
      avgExecutedPrice: "65010.5",
      totalExecutedQuantity: "0.002",
      price: "65000"
    }
  });

  assert.deepEqual(update, {
    symbol: "BTCUSDC",
    orderId: "12345",
    status: "FILLED",
    avgPrice: "65010.5",
    price: "65000",
    executedQty: "0.002",
    raw: {
      symbol: "PERP_BTC_USDC",
      orderId: 12345,
      status: "FILLED",
      avgExecutedPrice: "65010.5",
      totalExecutedQuantity: "0.002",
      price: "65000"
    }
  });
});

test("extracts Binance private order updates", () => {
  const update = extractPrivateOrderUpdate({
    e: "ORDER_TRADE_UPDATE",
    o: {
      s: "BTCUSDT",
      i: 777,
      X: "FILLED",
      ap: "68000.12",
      z: "0.01",
      p: "67999.9"
    }
  });

  assert.equal(update.symbol, "BTCUSDT");
  assert.equal(update.orderId, "777");
  assert.equal(update.avgPrice, "68000.12");
  assert.equal(update.executedQty, "0.01");
});
