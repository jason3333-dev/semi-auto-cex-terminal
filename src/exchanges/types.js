export class ExchangeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ExchangeError";
    this.details = details;
  }
}

export const ORDER_SIDES = Object.freeze({
  BUY: "BUY",
  SELL: "SELL"
});

export const ORDER_TYPES = Object.freeze({
  LIMIT: "LIMIT",
  MARKET: "MARKET"
});

export const POSITION_SIDES = Object.freeze({
  BOTH: "BOTH",
  LONG: "LONG",
  SHORT: "SHORT"
});

export function assertAdapterShape(adapter) {
  const required = [
    "id",
    "label",
    "getSymbols",
    "getTicker",
    "getKlines",
    "getOrderBook",
    "getLeverageBracket",
    "getBalances",
    "getPositions",
    "getOpenOrders",
    "setLeverage",
    "placeLimitOrder",
    "placeMarketOrder",
    "placeConditionalMarketOrder",
    "cancelOrder",
    "cancelAllOpenOrders",
    "queryOrder",
    "closePositions"
  ];

  for (const key of required) {
    if (!(key in adapter)) {
      throw new ExchangeError(`Exchange adapter is missing "${key}"`);
    }
  }
}
