import assert from "node:assert/strict";
import test from "node:test";
import { __test__ } from "../src/server.js";
import { ExchangeError } from "../src/exchanges/types.js";

const {
  CHASE_FILL_STATES,
  CHASE_JOB_STATES,
  CHASE_TERMINAL_REASONS,
  bracketTriggerPrice,
  buildBracketConfig,
  buildChaseJob,
  buildOrderIntent,
  jobSnapshot,
  runChaseJob,
  state,
  stopChaseJob,
  submitChaseLimitOrder,
  updateChaseFillProgress,
  waitForChaseOrderSlot
} = __test__;

function resetChaseState() {
  state.exchangeId = "mememax-orderly";
  state.mode = "dry-run";
  state.chaseJobs.clear();
  state.orderRateLimit.clear();
  state.logs = [];
  state.accountStream.status = "idle";
  state.accountStream.ws = null;
  state.accountStream.lastEventTime = "";
}

function makeAdapter(overrides = {}) {
  let nextOrderId = 1000;
  return {
    chaseConfig() {
      return {
        minUpdateMs: 1,
        updateMs: 1,
        rateLimit10sOrders: 10_000,
        rateLimitSafety: 1,
        rateLimitWindowMs: 100,
        orderOpsPerReplace: 1,
        restFallbackUpdateMs: 1,
        statusCheckMs: 1,
        statusPollWithPrivateStream: true,
        replaceStrategy: "cancel-replace"
      };
    },
    async getSymbol() {
      return { symbol: "BTCUSDC", tickSize: "0.1", stepSize: "0.001" };
    },
    roundPriceForSide(_symbolInfo, _side, rawTarget) {
      return String(rawTarget);
    },
    async getOrderBook() {
      return { source: "rest", bids: [["65000", "1"]], asks: [["65001", "1"]] };
    },
    async placeLimitOrder(_context, order) {
      nextOrderId += 1;
      return {
        orderId: String(nextOrderId),
        symbol: order.symbol,
        status: "NEW",
        price: order.price,
        origQty: order.quantity,
        executedQty: "0"
      };
    },
    async cancelOrder() {
      return { canceled: true };
    },
    async queryOrder(_context, { symbol, orderId }) {
      return { symbol, orderId, status: "NEW", executedQty: "0" };
    },
    ...overrides
  };
}

function makeJob(adapter, overrides = {}) {
  const intent = buildOrderIntent({ action: "OPEN", positionSide: "LONG" });
  const job = buildChaseJob(
    { symbol: "BTCUSDC", quantity: "1", price: "65000" },
    intent,
    { adapter }
  );
  Object.assign(job, {
    maxChases: 3,
    updateMs: 1,
    restFallbackUpdateMs: 1,
    statusCheckMs: 1,
    rateLimit10sOrders: 10_000,
    rateLimitSafety: 1,
    rateLimitWindowMs: 100,
    orderOpsPerReplace: 1,
    ...overrides
  });
  state.chaseJobs.set(job.id, job);
  return job;
}

test("chase replacement uses remaining quantity after partial fill", async () => {
  resetChaseState();
  let placedQuantity = "";
  const adapter = makeAdapter({
    async replaceLimitOrder() {
      throw new Error("replace should not be called after partial fill");
    },
    async placeLimitOrder(_context, order) {
      placedQuantity = order.quantity;
      return { orderId: "next", symbol: order.symbol, status: "NEW", price: order.price, origQty: order.quantity };
    }
  });
  const job = makeJob(adapter, { orderId: "old", lastPrice: "64999" });

  const fillState = updateChaseFillProgress(
    job,
    { orderId: "old", status: "PARTIALLY_FILLED", executedQty: "0.4", origQty: "1" },
    "rest-poll"
  );
  await submitChaseLimitOrder(adapter, job, "65000");

  const snapshot = jobSnapshot(job);
  assert.equal(fillState, CHASE_FILL_STATES.PARTIAL);
  assert.equal(placedQuantity, "0.6");
  assert.equal(snapshot.fillStatus, "partial");
  assert.equal(snapshot.executedQuantity, "0.4");
  assert.equal(snapshot.remainingQuantity, "0.6");
  assert.equal(snapshot.isTerminal, false);
});

test("bracket inputs accept percentages off entry price", () => {
  resetChaseState();
  const longIntent = buildOrderIntent({ action: "OPEN", positionSide: "LONG" });
  const longBracket = buildBracketConfig({
    symbol: "BTCUSDC",
    quantity: "0.5",
    price: "80000",
    stopLossEnabled: true,
    stopLossAmount: "1%",
    takeProfitEnabled: true,
    takeProfitAmount: "2.5%"
  }, longIntent);

  assert.equal(longBracket.stopLossMode, "percent");
  assert.equal(longBracket.takeProfitMode, "percent");
  assert.equal(bracketTriggerPrice(longBracket, "SL", 80000), 79200);
  assert.equal(bracketTriggerPrice(longBracket, "TP", 80000), 82000);

  const shortIntent = buildOrderIntent({ action: "OPEN", positionSide: "SHORT" });
  const shortBracket = buildBracketConfig({
    symbol: "BTCUSDC",
    quantity: "0.5",
    price: "80000",
    stopLossEnabled: true,
    stopLossAmount: "1%",
    takeProfitEnabled: true,
    takeProfitAmount: "2%"
  }, shortIntent);

  assert.equal(bracketTriggerPrice(shortBracket, "SL", 80000), 80800);
  assert.equal(bracketTriggerPrice(shortBracket, "TP", 80000), 78400);
});

test("bracket inputs keep absolute USDC distance support", () => {
  resetChaseState();
  const intent = buildOrderIntent({ action: "OPEN", positionSide: "LONG" });
  const bracket = buildBracketConfig({
    symbol: "BTCUSDC",
    quantity: "0.5",
    price: "80000",
    stopLossEnabled: true,
    stopLossAmount: "100",
    takeProfitEnabled: true,
    takeProfitAmount: "250"
  }, intent);

  assert.equal(bracket.stopLossMode, "amount");
  assert.equal(bracket.takeProfitMode, "amount");
  assert.equal(bracketTriggerPrice(bracket, "SL", 80000), 79800);
  assert.equal(bracketTriggerPrice(bracket, "TP", 80000), 80500);
});

test("cancel failure stops chase with explicit terminal reason", async () => {
  resetChaseState();
  const adapter = makeAdapter({
    async cancelOrder() {
      throw new ExchangeError("cancel rejected", { status: 400 });
    }
  });
  const job = makeJob(adapter, { orderId: "old", lastPrice: "64999" });

  await runChaseJob(adapter, job);

  const snapshot = jobSnapshot(job);
  assert.equal(snapshot.state, CHASE_JOB_STATES.ERROR);
  assert.equal(snapshot.terminalReason, CHASE_TERMINAL_REASONS.CANCEL_FAILED);
  assert.match(snapshot.error, /cancel rejected/);
});

test("replace race completes filled job instead of surfacing stale edit failure", async () => {
  resetChaseState();
  let queryCount = 0;
  const adapter = makeAdapter({
    async replaceLimitOrder() {
      throw new ExchangeError("order is no longer editable", { status: 404 });
    },
    async queryOrder(_context, { symbol, orderId }) {
      queryCount += 1;
      if (queryCount < 3) return { symbol, orderId, status: "NEW", executedQty: "0" };
      return {
        symbol,
        orderId,
        status: "FILLED",
        executedQty: "1",
        avgPrice: "65000"
      };
    }
  });
  const job = makeJob(adapter, { orderId: "old", lastPrice: "64999" });

  await runChaseJob(adapter, job);

  const snapshot = jobSnapshot(job);
  assert.equal(snapshot.state, CHASE_JOB_STATES.FILLED);
  assert.equal(snapshot.terminalReason, CHASE_TERMINAL_REASONS.REPLACE_RACE_FILLED);
  assert.equal(snapshot.fillSource, "replace-race");
  assert.equal(snapshot.remainingQuantity, "0");
});

test("rate-limit gate waits before granting the next chase order slot", async () => {
  resetChaseState();
  const adapter = makeAdapter();
  const job = makeJob(adapter, {
    rateLimit10sOrders: 100,
    rateLimitWindowMs: 100,
    rateLimitSafety: 1
  });
  state.orderRateLimit.set(`${state.exchangeId}:${state.mode}:order-mutation`, [Date.now()]);

  const startedAt = Date.now();
  await waitForChaseOrderSlot(job, 1);
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs >= 80, `expected rate gate to wait, elapsed ${elapsedMs}ms`);
  assert.ok(job.lastRateGateWaitMs > 0);
  assert.ok(job.rateGateStartedAt);
  assert.ok(job.rateGateReleasedAt);
});

test("missing private WebSocket order updates fall back to REST polling", async () => {
  resetChaseState();
  state.accountStream.status = "connected";
  state.accountStream.ws = { readyState: 1 };

  let placedOrderId = "";
  const adapter = makeAdapter({
    async placeLimitOrder(_context, order) {
      placedOrderId = "missed-fill";
      return { orderId: placedOrderId, symbol: order.symbol, status: "NEW", price: order.price, origQty: order.quantity };
    },
    async queryOrder(_context, { symbol, orderId }) {
      return {
        symbol,
        orderId: orderId || placedOrderId,
        status: "FILLED",
        executedQty: "1",
        avgPrice: "65000"
      };
    }
  });
  const job = makeJob(adapter, {
    statusPollWithPrivateStream: false
  });

  await runChaseJob(adapter, job);

  const snapshot = jobSnapshot(job);
  assert.equal(snapshot.state, CHASE_JOB_STATES.FILLED);
  assert.equal(snapshot.terminalReason, CHASE_TERMINAL_REASONS.FILLED);
  assert.equal(snapshot.fillSource, "rest-poll:missing-private-ws");
});

test("manual stop reports cancel failure in the returned job snapshot", async () => {
  resetChaseState();
  const adapter = makeAdapter({
    async cancelOrder() {
      return { canceled: false };
    }
  });
  const job = makeJob(adapter, { orderId: "old" });

  await stopChaseJob(adapter, job, { cancelOrder: true });

  const snapshot = jobSnapshot(job);
  assert.equal(snapshot.state, CHASE_JOB_STATES.ERROR);
  assert.equal(snapshot.terminalReason, CHASE_TERMINAL_REASONS.CANCEL_FAILED);
  assert.match(snapshot.cancelOrderError, /did not confirm/);
});
