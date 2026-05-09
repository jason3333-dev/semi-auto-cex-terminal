import { ExchangeError } from "./exchanges/types.js";

export const LIVE_UNLOCK_PHRASE = "I_ACCEPT_LIVE_RISK";
export const DEFAULT_LIVE_MAX_NOTIONAL = 100;
export const DEFAULT_LIVE_MAX_LEVERAGE = 10;

function envValue(env, name, exchangePrefix = "") {
  const scopedName = exchangePrefix ? `${exchangePrefix}${name}` : "";
  if (scopedName && env[scopedName] !== undefined && env[scopedName] !== "") {
    return env[scopedName];
  }
  return env[name];
}

function positiveNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function formatAmount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return numeric.toLocaleString("en-US", {
    maximumFractionDigits: 8
  });
}

export function normalizeRiskSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

export function parseAllowedSymbols(value) {
  return Array.from(new Set(
    String(value || "")
      .split(/[,\s]+/)
      .map(normalizeRiskSymbol)
      .filter(Boolean)
  ));
}

export function quoteAssetForRiskSymbol(symbol) {
  const text = normalizeRiskSymbol(symbol);
  if (text.endsWith("USDC")) return "USDC";
  if (text.endsWith("USDT")) return "USDT";
  return "quote";
}

export function liveRiskConfigFromEnv(env = process.env, { exchangePrefix = "" } = {}) {
  return {
    maxNotional: positiveNumber(
      envValue(env, "LIVE_MAX_NOTIONAL", exchangePrefix),
      DEFAULT_LIVE_MAX_NOTIONAL
    ),
    maxLeverage: Math.max(1, Math.floor(positiveNumber(
      envValue(env, "LIVE_MAX_LEVERAGE", exchangePrefix),
      DEFAULT_LIVE_MAX_LEVERAGE
    ))),
    allowedSymbols: parseAllowedSymbols(envValue(env, "LIVE_ALLOWED_SYMBOLS", exchangePrefix))
  };
}

export function publicLiveRiskConfig(config, { mode = "dry-run" } = {}) {
  return {
    enabled: mode === "live",
    maxNotional: config.maxNotional,
    maxLeverage: config.maxLeverage,
    allowedSymbols: config.allowedSymbols,
    allowedSymbolsConfigured: config.allowedSymbols.length > 0
  };
}

export function assertLiveRiskUnlocked({ mode, liveUnlocked }, actionName) {
  if (mode === "live" && !liveUnlocked) {
    throw new ExchangeError(`${actionName} requires LIVE_UNLOCK_PHRASE=${LIVE_UNLOCK_PHRASE}`, {
      guardrail: "live-unlock"
    });
  }
}

export function assertLiveRiskSymbol({ mode, riskConfig }, actionName, symbol) {
  if (mode !== "live") return normalizeRiskSymbol(symbol);

  const normalized = normalizeRiskSymbol(symbol);
  if (!normalized) {
    throw new ExchangeError(`Live risk guard blocked ${actionName}: symbol is required`, {
      guardrail: "symbol-required"
    });
  }

  const allowed = riskConfig.allowedSymbols || [];
  if (allowed.length && !allowed.includes(normalized)) {
    throw new ExchangeError(
      `Live risk guard blocked ${actionName}: ${normalized} is not in LIVE_ALLOWED_SYMBOLS`,
      {
        guardrail: "allowed-symbols",
        symbol: normalized,
        allowedSymbols: allowed
      }
    );
  }

  return normalized;
}

export function assertLiveRiskLeverage({ mode, riskConfig }, actionName, leverage, { required = false } = {}) {
  if (mode !== "live") return;
  if (leverage === undefined || leverage === null || leverage === "") {
    if (required) {
      throw new ExchangeError(`Live risk guard blocked ${actionName}: leverage is required`, {
        guardrail: "leverage-required"
      });
    }
    return;
  }

  const numeric = Number(leverage);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new ExchangeError(`Live risk guard blocked ${actionName}: leverage must be greater than 0`, {
      guardrail: "leverage-invalid"
    });
  }

  if (numeric > riskConfig.maxLeverage) {
    throw new ExchangeError(
      `Live risk guard blocked ${actionName}: leverage ${formatAmount(numeric)}x exceeds max ${formatAmount(riskConfig.maxLeverage)}x`,
      {
        guardrail: "max-leverage",
        leverage: numeric,
        maxLeverage: riskConfig.maxLeverage
      }
    );
  }
}

export function assertLiveRiskNotional({ mode, riskConfig }, actionName, { symbol, quantity, price }) {
  if (mode !== "live") return null;

  const normalized = normalizeRiskSymbol(symbol);
  const numericQuantity = Math.abs(Number(quantity));
  const numericPrice = Math.abs(Number(price));
  if (!Number.isFinite(numericQuantity) || numericQuantity <= 0) {
    throw new ExchangeError(`Live risk guard blocked ${actionName}: quantity must be greater than 0`, {
      guardrail: "quantity-invalid",
      symbol: normalized
    });
  }
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
    throw new ExchangeError(`Live risk guard blocked ${actionName}: reference price is unavailable`, {
      guardrail: "price-invalid",
      symbol: normalized
    });
  }

  const notional = numericQuantity * numericPrice;
  if (notional > riskConfig.maxNotional) {
    const quote = quoteAssetForRiskSymbol(normalized);
    throw new ExchangeError(
      `Live risk guard blocked ${actionName}: ${normalized} notional ${formatAmount(notional)} ${quote} exceeds max ${formatAmount(riskConfig.maxNotional)} ${quote}`,
      {
        guardrail: "max-notional",
        symbol: normalized,
        notional,
        maxNotional: riskConfig.maxNotional,
        quoteAsset: quote
      }
    );
  }

  return {
    symbol: normalized,
    notional,
    maxNotional: riskConfig.maxNotional
  };
}

export function assertLiveRiskOrder(riskContext, actionName, order) {
  const symbol = assertLiveRiskSymbol(riskContext, actionName, order.symbol);

  const action = String(order.action || "OPEN").toUpperCase();
  assertLiveRiskLeverage(riskContext, actionName, order.leverage, { required: action === "OPEN" });
  if (action === "OPEN") {
    return assertLiveRiskNotional(riskContext, actionName, {
      symbol,
      quantity: order.quantity,
      price: order.price
    });
  }

  return null;
}
