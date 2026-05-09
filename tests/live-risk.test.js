import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLiveRiskOrder,
  assertLiveRiskUnlocked,
  liveRiskConfigFromEnv,
  publicLiveRiskConfig
} from "../src/live-risk.js";

test("live risk config supports exchange-scoped overrides", () => {
  const config = liveRiskConfigFromEnv({
    LIVE_MAX_NOTIONAL: "250",
    LIVE_MAX_LEVERAGE: "8",
    LIVE_ALLOWED_SYMBOLS: "BTCUSDC, ethusdc",
    MEMEMAX_LIVE_MAX_NOTIONAL: "125"
  }, { exchangePrefix: "MEMEMAX_" });

  assert.equal(config.maxNotional, 125);
  assert.equal(config.maxLeverage, 8);
  assert.deepEqual(config.allowedSymbols, ["BTCUSDC", "ETHUSDC"]);
});

test("live risk public config exposes limits without secrets", () => {
  const payload = publicLiveRiskConfig({
    maxNotional: 100,
    maxLeverage: 5,
    allowedSymbols: ["BTCUSDC"]
  }, { mode: "live" });

  assert.deepEqual(payload, {
    enabled: true,
    maxNotional: 100,
    maxLeverage: 5,
    allowedSymbols: ["BTCUSDC"],
    allowedSymbolsConfigured: true
  });
});

test("live mode still requires the explicit unlock phrase", () => {
  assert.throws(
    () => assertLiveRiskUnlocked({ mode: "live", liveUnlocked: false }, "Market order"),
    /LIVE_UNLOCK_PHRASE=I_ACCEPT_LIVE_RISK/
  );
});

test("live risk order guard blocks disallowed symbols", () => {
  assert.throws(
    () => assertLiveRiskOrder({
      mode: "live",
      riskConfig: {
        maxNotional: 100,
        maxLeverage: 10,
        allowedSymbols: ["BTCUSDC"]
      }
    }, "Limit order", {
      symbol: "ETHUSDC",
      action: "OPEN",
      quantity: "0.01",
      price: "3000",
      leverage: 5
    }),
    /not in LIVE_ALLOWED_SYMBOLS/
  );
});

test("live risk order guard blocks max leverage and max opening notional", () => {
  const riskContext = {
    mode: "live",
    riskConfig: {
      maxNotional: 100,
      maxLeverage: 5,
      allowedSymbols: ["BTCUSDC"]
    }
  };

  assert.throws(
    () => assertLiveRiskOrder(riskContext, "Limit order", {
      symbol: "BTCUSDC",
      action: "OPEN",
      quantity: "0.001",
      price: "65000"
    }),
    /leverage is required/
  );

  assert.throws(
    () => assertLiveRiskOrder(riskContext, "Limit order", {
      symbol: "BTCUSDC",
      action: "OPEN",
      quantity: "0.001",
      price: "65000",
      leverage: 6
    }),
    /leverage 6x exceeds max 5x/
  );

  assert.throws(
    () => assertLiveRiskOrder(riskContext, "Limit order", {
      symbol: "BTCUSDC",
      action: "OPEN",
      quantity: "0.01",
      price: "65000",
      leverage: 5
    }),
    /notional 650 USDC exceeds max 100 USDC/
  );
});

test("close-side live orders skip opening notional but still check symbol and leverage", () => {
  const result = assertLiveRiskOrder({
    mode: "live",
    riskConfig: {
      maxNotional: 10,
      maxLeverage: 5,
      allowedSymbols: ["BTCUSDC"]
    }
  }, "Close order", {
    symbol: "BTCUSDC",
    action: "CLOSE",
    quantity: "2",
    price: "65000",
    leverage: 5
  });

  assert.equal(result, null);
});

test("dry-run order guard does not block oversized inputs", () => {
  assert.doesNotThrow(() => assertLiveRiskOrder({
    mode: "dry-run",
    riskConfig: {
      maxNotional: 1,
      maxLeverage: 1,
      allowedSymbols: ["BTCUSDC"]
    }
  }, "Dry-run order", {
    symbol: "ETHUSDC",
    action: "OPEN",
    quantity: "100",
    price: "65000",
    leverage: 50
  }));
});
