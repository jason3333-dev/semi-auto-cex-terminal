export function uiSymbolFromExchangeSymbol(symbol) {
  const text = String(symbol || "").toUpperCase();
  const orderlyMatch = text.match(/^PERP_(.+)_USDC(?:\.E)?$/);
  if (orderlyMatch) return `${orderlyMatch[1].replace(/_/g, "")}USDC`;
  return text.replace(/[^A-Z0-9]/g, "");
}

export function extractPrivateOrderUpdate(payload) {
  const topic = String(payload.topic || "");
  const data = payload.data || payload;
  const order = data.o || data.order || data;
  const eventType = data.e || data.eventType || topic;
  const isOrderEvent = topic === "executionreport" || topic.startsWith("executionreport@") || eventType === "ORDER_TRADE_UPDATE";
  if (!isOrderEvent) return null;

  const orderId = order.order_id ?? order.orderId ?? order.i ?? order.orderID;
  if (orderId === undefined || orderId === null || orderId === "") return null;

  const symbol = uiSymbolFromExchangeSymbol(order.symbol ?? order.s ?? data.symbol ?? data.s);
  const status = String(order.status ?? order.order_status ?? order.X ?? data.status ?? "").toUpperCase();
  const avgPrice = order.average_executed_price ?? order.avgExecutedPrice ?? order.averageExecutedPrice ?? order.avgPrice ?? order.ap ?? order.avg_price;
  const price = order.order_price ?? order.price ?? order.p ?? order.executed_price ?? order.executedPrice;
  const executedQty = order.executed_quantity ?? order.total_executed_quantity ?? order.totalExecutedQuantity ?? order.executedQty ?? order.executedQuantity ?? order.z;

  return {
    symbol,
    orderId: String(orderId),
    status,
    avgPrice: avgPrice !== undefined ? String(avgPrice) : "",
    price: price !== undefined ? String(price) : "",
    executedQty: executedQty !== undefined ? String(executedQty) : "",
    raw: order
  };
}
