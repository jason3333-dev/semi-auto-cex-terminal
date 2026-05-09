const $ = (selector) => document.querySelector(selector);
const ACCOUNT_REFRESH_MS = 1000;
const FIFTEEN_SECONDS_MS = 15_000;

const ui = {
  modeBadge: $("#modeBadge"),
  riskBadge: $("#riskBadge"),
  connectionLabel: $("#connectionLabel"),
  refreshButton: $("#refreshButton"),
  symbolInput: $("#symbolInput"),
  symbolOptions: $("#symbolOptions"),
  intervalSelect: $("#intervalSelect"),
  lastPrice: $("#lastPrice"),
  bestBid: $("#bestBid"),
  bestAsk: $("#bestAsk"),
  accountBalance: $("#accountBalance"),
  sessionPnl: $("#sessionPnl"),
  chart: $("#priceChart"),
  crosshairReadout: $("#crosshairReadout"),
  openAction: $("#openAction"),
  closeAction: $("#closeAction"),
  longIntent: $("#longIntent"),
  shortIntent: $("#shortIntent"),
  leverageInput: $("#leverageInput"),
  leverageValue: $("#leverageValue"),
  leverageMaxLabel: $("#leverageMaxLabel"),
  quantityInput: $("#quantityInput"),
  positionSizeLabel: $("#positionSizeLabel"),
  limitPriceInput: $("#limitPriceInput"),
  limitMetaLabel: $("#limitMetaLabel"),
  stopLossEnabledInput: $("#stopLossEnabledInput"),
  stopLossAmountInput: $("#stopLossAmountInput"),
  takeProfitEnabledInput: $("#takeProfitEnabledInput"),
  takeProfitAmountInput: $("#takeProfitAmountInput"),
  limitOrderButton: $("#limitOrderButton"),
  reverseButton: $("#reverseButton"),
  autoChaseInput: $("#autoChaseInput"),
  fastModeInput: $("#fastModeInput"),
  chaseSummary: $("#chaseSummary"),
  operationStatus: $("#operationStatus"),
  stopChaseButton: $("#stopChaseButton"),
  closeAllInput: $("#closeAllInput"),
  cancelAllButton: $("#cancelAllButton"),
  emergencyButton: $("#emergencyButton"),
  positionsRefresh: $("#positionsRefresh"),
  ordersRefresh: $("#ordersRefresh"),
  positionsBody: $("#positionsBody"),
  ordersBody: $("#ordersBody"),
  jobsList: $("#jobsList"),
  logOutput: $("#logOutput"),
  lastUpdated: $("#lastUpdated"),
  toast: $("#toast")
};

const app = {
  session: null,
  symbols: [],
  activeSymbol: "BTCUSDC",
  selectedAction: "OPEN",
  selectedIntent: "LONG",
  positions: [],
  accountSummary: null,
  openQuantityValue: "0.001",
  klines: [],
  orderBook: null,
  lastPriceValue: 0,
  leverageMax: 125,
  leverageApplyTimer: null,
  chaseJobId: "",
  refreshTimer: null,
  accountTimer: null,
  accountEventSource: null,
  accountRefreshDelayTimer: null,
  accountRefreshInFlight: false,
  priceTimer: null,
  chartPointer: null,
  symbolApplyTimer: null,
  marketRequestSeq: 0,
  hasRunningChaseJob: false,
  pendingActions: new Set(),
  operationStatusTimer: null
};

const ACTION_COPY = {
  limitOrder: {
    title: "ORDER",
    idle: "지정가 주문",
    pending: "지정가 전송 중"
  },
  marketOrder: {
    title: "FAST",
    idle: "FAST 주문",
    pending: "FAST 전송 중"
  },
  chaseStart: {
    title: "CHASE START",
    idle: "추격 지정가 시작",
    pending: "추격 시작 중"
  },
  chaseStop: {
    title: "CHASE STOP",
    idle: "추격 주문 중지",
    pending: "추격 중지 중"
  },
  reverse: {
    title: "REVERSE",
    idle: "리버스",
    pending: "리버스 실행 중"
  },
  cancel: {
    title: "CANCEL",
    idle: "오픈오더 취소",
    pending: "취소 중"
  },
  emergency: {
    title: "EMERGENCY",
    idle: "포지션 정리",
    pending: "정리 중"
  }
};

const SUBMIT_ACTION_KEYS = ["limitOrder", "marketOrder", "chaseStart"];
const TERMINAL_JOB_STATUSES = new Set(["done", "filled", "stopped", "error", "canceled", "cancelled", "expired", "rejected"]);

function compactText(value, maxLength = 180) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function serverFailureMessage(payload = {}, fallbackStatus = "") {
  const details = payload && typeof payload.details === "object" && payload.details
    ? payload.details
    : {};
  const detailReason = compactText(
    details.reason ||
    details.message ||
    details.msg ||
    details.error ||
    details.lastError ||
    "",
    120
  );
  const primaryReason = compactText(payload.error || payload.reason || payload.message || detailReason || "Request failed");
  const hasDistinctDetail = detailReason &&
    detailReason.toLowerCase() !== primaryReason.toLowerCase() &&
    !primaryReason.toLowerCase().includes(detailReason.toLowerCase());
  const reason = hasDistinctDetail ? `${primaryReason}: ${detailReason}` : primaryReason;
  const tags = [];
  if (details.code !== undefined && details.code !== null && details.code !== "") {
    tags.push(`code ${details.code}`);
  }
  const status = details.status || fallbackStatus;
  if (status) tags.push(`HTTP ${status}`);
  return tags.length ? `${reason} (${tags.join(", ")})` : reason;
}

function createRequestError(payload, status) {
  const error = new Error(serverFailureMessage(payload, status));
  error.details = payload?.details || {};
  error.serverError = payload?.error || "";
  return error;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    throw createRequestError(payload, response.status);
  }
  return payload;
}

function post(path, body) {
  return request(path, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

function formatNumber(value, digits = 4) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return numeric.toLocaleString("en-US", {
    maximumFractionDigits: digits
  });
}

function formatPrice(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  const digits = numeric >= 1000 ? 2 : numeric >= 1 ? 4 : 8;
  return formatNumber(numeric, digits);
}

function formatSignedAmount(value, digits = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return `${numeric > 0 ? "+" : ""}${formatNumber(numeric, digits)}`;
}

function signedClass(value) {
  const numeric = Number(value);
  if (numeric > 0) return "positive";
  if (numeric < 0) return "negative";
  return "";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

function currentSymbol() {
  return app.activeSymbol || "BTCUSDC";
}

function normalizedSymbolInput() {
  return ui.symbolInput.value.trim().toUpperCase();
}

function isKnownSymbol(symbol) {
  return app.symbols.some((item) => item.symbol === symbol);
}

function apiSideForIntent(action, intent) {
  if (action === "OPEN" && intent === "LONG") return "BUY";
  if (action === "OPEN" && intent === "SHORT") return "SELL";
  if (action === "CLOSE" && intent === "LONG") return "SELL";
  return "BUY";
}

function oppositeIntent(intent) {
  return intent === "LONG" ? "SHORT" : "LONG";
}

function pegSideLabel(action, intent) {
  const side = apiSideForIntent(action, intent);
  return side === "BUY" ? "best bid" : "best ask";
}

function intentClass(action, intent) {
  if (action === "OPEN" && intent === "LONG") return "positive";
  if (action === "OPEN" && intent === "SHORT") return "negative";
  if (action === "CLOSE") return "log-warn";
  return "";
}

function signedTickOffset(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric === 0) return "0 ticks";
  return `${numeric > 0 ? "+" : ""}${numeric} ticks`;
}

function selectedPriceBasis() {
  const limit = Number(ui.limitPriceInput.value);
  if (Number.isFinite(limit) && limit > 0) return limit;
  return app.lastPriceValue;
}

function riskTriggerPrice(kind) {
  const amountInput = kind === "SL" ? ui.stopLossAmountInput : ui.takeProfitAmountInput;
  const enabledInput = kind === "SL" ? ui.stopLossEnabledInput : ui.takeProfitEnabledInput;
  if (!enabledInput.checked) return "";
  const amount = Number(amountInput.value);
  const qty = Number(ui.quantityInput.value);
  const entry = selectedPriceBasis();
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(qty) || qty <= 0 || !entry) return "";
  const delta = amount / qty;
  if (app.selectedIntent === "LONG") {
    return formatPrice(kind === "SL" ? entry - delta : entry + delta);
  }
  return formatPrice(kind === "SL" ? entry + delta : entry - delta);
}

function updatePositionSize() {
  const qty = Number(ui.quantityInput.value);
  const price = app.lastPriceValue || Number(ui.limitPriceInput.value);
  const selectedPosition = positionForSelection({ fallbackAny: true });
  const liquidationPrice = Number(selectedPosition?.liquidationPrice || 0);
  const liquidationText = Number.isFinite(liquidationPrice) && liquidationPrice > 0
    ? formatPrice(liquidationPrice)
    : "-";
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) {
    ui.positionSizeLabel.textContent = `Size - · Liq ${liquidationText}`;
    return;
  }
  const quote = currentSymbol().endsWith("USDC") ? "USDC" : "USDT";
  const notional = qty * price;
  ui.positionSizeLabel.textContent = `Size ${formatNumber(notional, 2)} ${quote} · Liq ${liquidationText}`;
}

function updateLiveFifteenSecondCandle(price) {
  const numeric = Number(price);
  if (ui.intervalSelect.value !== "15s" || !Number.isFinite(numeric) || numeric <= 0) return false;

  const bucket = Math.floor(Date.now() / FIFTEEN_SECONDS_MS) * FIFTEEN_SECONDS_MS;
  let last = app.klines[app.klines.length - 1];
  if (!last || Number(last.openTime) < bucket) {
    const open = Number(last?.close || numeric);
    app.klines.push({
      openTime: bucket,
      open: String(open),
      high: String(Math.max(open, numeric)),
      low: String(Math.min(open, numeric)),
      close: String(numeric),
      volume: "0",
      closeTime: bucket + FIFTEEN_SECONDS_MS - 1
    });
    app.klines = app.klines.slice(-chartLimit());
    return true;
  }

  if (Number(last.openTime) !== bucket) return false;
  const high = Math.max(Number(last.high || numeric), numeric);
  const low = Math.min(Number(last.low || numeric), numeric);
  last.high = String(high);
  last.low = String(low);
  last.close = String(numeric);
  last.closeTime = bucket + FIFTEEN_SECONDS_MS - 1;
  return true;
}

function chartLimit() {
  return ui.intervalSelect.value === "15s" ? 80 : 180;
}

function typicalPrice(row) {
  const high = Number(row.high);
  const low = Number(row.low);
  const close = Number(row.close);
  if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return close;
  return (high + low + close) / 3;
}

function rollingVwap(rows, period) {
  const numericPeriod = Math.max(1, Math.min(rows.length, Number(period) || rows.length));
  const values = [];
  let volumeSum = 0;
  let valueSum = 0;
  const queue = [];

  rows.forEach((row) => {
    const volume = Math.max(0, Number(row.volume || 0));
    const price = typicalPrice(row);
    const effectiveVolume = volume > 0 ? volume : 1;
    const weighted = price * effectiveVolume;

    queue.push({ volume: effectiveVolume, weighted });
    volumeSum += effectiveVolume;
    valueSum += weighted;

    if (queue.length > numericPeriod) {
      const removed = queue.shift();
      volumeSum -= removed.volume;
      valueSum -= removed.weighted;
    }

    values.push(volumeSum > 0 ? valueSum / volumeSum : price);
  });

  return values;
}

function formatQuantityInput(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  return numeric.toFixed(12).replace(/\.?0+$/, "");
}

function activePositionsForSymbol() {
  return app.positions.filter((item) => {
    if (item.symbol !== currentSymbol()) return false;
    const amount = Number(item.positionAmt || 0);
    return Number.isFinite(amount) && amount !== 0;
  });
}

function normalizedPositionSide(position) {
  if (position?.positionSide === "LONG" || position?.positionSide === "SHORT") {
    return position.positionSide;
  }
  const amount = Number(position?.positionAmt || 0);
  if (amount > 0) return "LONG";
  if (amount < 0) return "SHORT";
  return position?.side || "FLAT";
}

function positionForSelection({ fallbackAny = false } = {}) {
  const positions = activePositionsForSymbol();
  const exact = positions.find((item) => normalizedPositionSide(item) === app.selectedIntent);
  return exact || (fallbackAny ? positions[0] : undefined);
}

function closeQuantityForSelection() {
  const position = positionForSelection();
  return Math.abs(Number(position?.positionAmt || 0));
}

function syncCloseQuantityFromPositions() {
  if (app.selectedAction !== "CLOSE") {
    ui.quantityInput.removeAttribute("max");
    return false;
  }

  const quantity = formatQuantityInput(closeQuantityForSelection());
  ui.quantityInput.max = quantity || "";
  if (ui.quantityInput.value === quantity) return false;
  ui.quantityInput.value = quantity;
  return true;
}

function updateLeverageDisplay() {
  const value = Number(ui.leverageInput.value || 1);
  ui.leverageValue.textContent = `${value}x`;
  ui.leverageMaxLabel.textContent = `max ${app.leverageMax}x`;
}

function normalizeOrderMode(preferred = "FAST") {
  if (!ui.autoChaseInput.checked || !ui.fastModeInput.checked) return;
  if (preferred === "CHASE") {
    ui.fastModeInput.checked = false;
    return;
  }
  ui.autoChaseInput.checked = false;
}

function updateChaseSummary() {
  if (!ui.chaseSummary) return;
  normalizeOrderMode();
  const quantity = ui.quantityInput.value || "-";
  const autoChase = ui.autoChaseInput.checked;
  const fastMode = ui.fastModeInput.checked;
  const orderConfig = app.session?.orderConfig || { timeInForce: "GTX" };
  const chaseConfig = app.session?.chaseConfig || {
    timeInForce: "GTX",
    tickOffset: 0,
    updateMs: 4000,
    maxReplaces: 25
  };
  ui.limitPriceInput.disabled = fastMode || hasPendingAction();
  ui.chaseSummary.textContent = fastMode
    ? [
      currentSymbol(),
      app.selectedAction,
      app.selectedIntent,
      "MARKET",
      `qty ${quantity}`,
      "taker"
    ].join(" ")
    : autoChase
    ? [
      currentSymbol(),
      app.selectedAction,
      app.selectedIntent,
      `LIMIT ${chaseConfig.timeInForce}`,
      `qty ${quantity}`,
      `@ ${pegSideLabel(app.selectedAction, app.selectedIntent)}`,
      signedTickOffset(chaseConfig.tickOffset),
      `${chaseConfig.updateMs}ms`,
      `${chaseConfig.maxReplaces}x`,
      `safe ${Math.round((chaseConfig.rateLimitSafety || 0.7) * 100)}%`
    ].join(" ")
    : [
      currentSymbol(),
      app.selectedAction,
      app.selectedIntent,
      `LIMIT ${orderConfig.timeInForce}`,
      `qty ${quantity}`,
      `@ ${formatPrice(ui.limitPriceInput.value)}`
    ].join(" ");

  const sl = riskTriggerPrice("SL");
  const tp = riskTriggerPrice("TP");
  if (sl || tp) {
    ui.chaseSummary.textContent += ` ${sl ? `SL ${ui.stopLossAmountInput.value}->${sl}` : ""}${tp ? ` TP ${ui.takeProfitAmountInput.value}->${tp}` : ""}`;
  }
  const liveRisk = app.session?.mode === "live" ? app.session.liveRisk : null;
  if (liveRisk) {
    ui.chaseSummary.textContent += ` guard <=${formatNumber(liveRisk.maxNotional, 0)} / ${liveRisk.maxLeverage}x`;
  }
  updatePositionSize();
  updateLeverageDisplay();
  updateActionControls();
}

function toast(message, isError = false) {
  ui.toast.textContent = message;
  ui.toast.classList.toggle("negative", isError);
  ui.toast.classList.remove("hidden");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => ui.toast.classList.add("hidden"), isError ? 6500 : 2800);
}

function currentSubmitActionKey() {
  if (ui.fastModeInput.checked) return "marketOrder";
  if (ui.autoChaseInput.checked) return "chaseStart";
  return "limitOrder";
}

function hasPendingAction() {
  return app.pendingActions.size > 0;
}

function pendingSubmitActionKey() {
  return SUBMIT_ACTION_KEYS.find((key) => app.pendingActions.has(key)) || "";
}

function setOperationStatus(message, tone = "info", { autoHide = false } = {}) {
  if (!ui.operationStatus) return;
  window.clearTimeout(app.operationStatusTimer);
  ui.operationStatus.textContent = message;
  ui.operationStatus.className = `operation-status ${tone}`;
  ui.operationStatus.classList.remove("hidden");
  if (autoHide) {
    app.operationStatusTimer = window.setTimeout(() => {
      ui.operationStatus.classList.add("hidden");
    }, 4500);
  }
}

function updateButtonPendingState(button, label, disabled, pending) {
  if (!button) return;
  button.textContent = label;
  button.disabled = disabled;
  button.classList.toggle("pending", pending);
  if (pending) {
    button.setAttribute("aria-busy", "true");
  } else {
    button.removeAttribute("aria-busy");
  }
}

function reverseButtonLabel() {
  return `${ui.fastModeInput.checked ? "FAST " : ""}리버스 ${app.selectedIntent} -> ${oppositeIntent(app.selectedIntent)}`;
}

function updateActionControls() {
  const busy = hasPendingAction();
  const submitKey = currentSubmitActionKey();
  const pendingSubmit = pendingSubmitActionKey();
  updateButtonPendingState(
    ui.limitOrderButton,
    pendingSubmit ? ACTION_COPY[pendingSubmit].pending : ACTION_COPY[submitKey].idle,
    busy,
    Boolean(pendingSubmit)
  );
  updateButtonPendingState(
    ui.stopChaseButton,
    app.pendingActions.has("chaseStop") ? ACTION_COPY.chaseStop.pending : ACTION_COPY.chaseStop.idle,
    busy || !app.hasRunningChaseJob,
    app.pendingActions.has("chaseStop")
  );
  updateButtonPendingState(
    ui.reverseButton,
    app.pendingActions.has("reverse") ? ACTION_COPY.reverse.pending : reverseButtonLabel(),
    busy,
    app.pendingActions.has("reverse")
  );
  updateButtonPendingState(
    ui.cancelAllButton,
    app.pendingActions.has("cancel") ? ACTION_COPY.cancel.pending : ACTION_COPY.cancel.idle,
    busy,
    app.pendingActions.has("cancel")
  );
  updateButtonPendingState(
    ui.emergencyButton,
    app.pendingActions.has("emergency") ? ACTION_COPY.emergency.pending : ACTION_COPY.emergency.idle,
    busy,
    app.pendingActions.has("emergency")
  );
  ui.limitPriceInput.disabled = ui.fastModeInput.checked || busy;
}

function beginAction(actionKey) {
  app.pendingActions.add(actionKey);
  setOperationStatus(`${ACTION_COPY[actionKey].title} pending`, "pending");
  updateActionControls();
  return () => {
    app.pendingActions.delete(actionKey);
    updateActionControls();
  };
}

async function runTradeAction(actionKey, task) {
  if (hasPendingAction()) return null;
  const release = beginAction(actionKey);
  try {
    const result = await task();
    setOperationStatus(`${ACTION_COPY[actionKey].title} ok`, "positive", { autoHide: true });
    return result;
  } catch (error) {
    const message = `${ACTION_COPY[actionKey].title} failed: ${error.message}`;
    setOperationStatus(message, "negative");
    toast(message, true);
    return null;
  } finally {
    release();
  }
}

function setModeBadge(mode) {
  ui.modeBadge.textContent = mode === "dry-run" ? "DRY RUN" : mode.toUpperCase();
  ui.modeBadge.className = "badge";
  if (mode === "live") ui.modeBadge.classList.add("badge-live");
  else if (mode === "testnet") ui.modeBadge.classList.add("badge-testnet");
  else ui.modeBadge.classList.add("badge-muted");
}

function liveAllowedSymbols() {
  const risk = app.session?.liveRisk;
  return app.session?.mode === "live" && risk?.allowedSymbolsConfigured
    ? risk.allowedSymbols || []
    : [];
}

function renderRiskBadge(session) {
  if (!ui.riskBadge) return;
  const risk = session.liveRisk || {};
  ui.riskBadge.className = "badge";
  if (session.mode === "live") {
    ui.riskBadge.classList.add("badge-live");
    ui.riskBadge.textContent = `GUARDS ${formatNumber(risk.maxNotional, 0)} / ${risk.maxLeverage}x`;
    const symbolText = risk.allowedSymbolsConfigured ? risk.allowedSymbols.join(", ") : "all symbols";
    ui.riskBadge.title = `Live guardrails: max notional ${formatNumber(risk.maxNotional, 2)}, max leverage ${risk.maxLeverage}x, symbols ${symbolText}`;
    return;
  }
  ui.riskBadge.classList.add(session.mode === "testnet" ? "badge-testnet" : "badge-muted");
  ui.riskBadge.textContent = session.mode === "testnet" ? "TESTNET GUARDS STANDBY" : "DRY RUN";
  ui.riskBadge.title = "Live risk guardrails apply when live mode is unlocked.";
}

function renderSession() {
  const session = app.session;
  setModeBadge(session.mode);
  renderRiskBadge(session);
  const exchange = session.exchanges.find((item) => item.id === session.exchangeId);
  const exchangeLabel = exchange?.label || session.exchangeId;
  ui.connectionLabel.textContent = session.hasApiKey
    ? `${exchangeLabel} · API ${session.apiKeyPreview}`
    : `${exchangeLabel} · API 키 없음`;
}

async function loadSession() {
  app.session = await request("/api/session");
  renderSession();
}

async function loadSymbols() {
  const { symbols } = await request("/api/symbols");
  const allowedSymbols = liveAllowedSymbols();
  const visibleSymbols = allowedSymbols.length
    ? symbols.filter((item) => allowedSymbols.includes(item.symbol))
    : symbols;
  if (allowedSymbols.length && !visibleSymbols.length) {
    toast("LIVE_ALLOWED_SYMBOLS does not match any exchange symbols", true);
  }
  app.symbols = visibleSymbols.length ? visibleSymbols : symbols;
  const available = new Set(app.symbols.map((item) => item.symbol));
  const typed = (ui.symbolInput.value || app.activeSymbol || "BTCUSDC").trim().toUpperCase();
  const preferred = available.has(typed) ? typed : available.has("BTCUSDC") ? "BTCUSDC" : "BTCUSDT";
  ui.symbolOptions.innerHTML = app.symbols
    .map((item) => `<option value="${escapeHtml(item.symbol)}">${escapeHtml(item.baseAsset)}/${escapeHtml(item.quoteAsset)}</option>`)
    .join("");
  app.activeSymbol = available.has(preferred) ? preferred : app.symbols[0]?.symbol || "BTCUSDC";
  ui.symbolInput.value = app.activeSymbol;
  await loadLeverageBracket();
  updateChaseSummary();
}

async function loadLeverageBracket() {
  try {
    const payload = await request(`/api/account/leverage-bracket?symbol=${encodeURIComponent(currentSymbol())}`);
    const exchangeMax = Math.max(1, Number(payload.maxLeverage || 125));
    const riskMax = app.session?.mode === "live" ? Number(app.session.liveRisk?.maxLeverage || 0) : 0;
    app.leverageMax = riskMax > 0 ? Math.min(exchangeMax, riskMax) : exchangeMax;
  } catch {
    const riskMax = app.session?.mode === "live" ? Number(app.session.liveRisk?.maxLeverage || 0) : 0;
    app.leverageMax = riskMax > 0 ? Math.min(125, riskMax) : 125;
  }
  ui.leverageInput.max = String(app.leverageMax);
  if (Number(ui.leverageInput.value) > app.leverageMax) {
    ui.leverageInput.value = String(app.leverageMax);
  }
  updateLeverageDisplay();
}

async function loadMarket() {
  const symbol = currentSymbol();
  const interval = ui.intervalSelect.value;
  const limit = chartLimit();
  const requestSeq = ++app.marketRequestSeq;
  await post("/api/market/focus", { symbol, interval }).catch(() => null);
  const [price, klinesPayload, bookPayload] = await Promise.all([
    request(`/api/market/price?symbol=${encodeURIComponent(symbol)}`),
    request(`/api/market/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`),
    request(`/api/market/orderbook?symbol=${encodeURIComponent(symbol)}&limit=20`)
  ]);
  if (requestSeq !== app.marketRequestSeq || symbol !== currentSymbol()) return;
  app.klines = klinesPayload.klines;
  app.orderBook = bookPayload.orderBook;
  app.lastPriceValue = Number(price.price);
  ui.lastPrice.textContent = formatPrice(price.price);
  ui.limitMetaLabel.textContent = `Last ${formatPrice(price.price)}`;
  ui.bestBid.textContent = formatPrice(app.orderBook.bids?.[0]?.[0]);
  ui.bestAsk.textContent = formatPrice(app.orderBook.asks?.[0]?.[0]);
  if (!ui.limitPriceInput.value) {
    setReferenceLimitPrice();
  }
  updateChaseSummary();
  drawChart();
}

async function loadPriceTick() {
  const symbol = currentSymbol();
  try {
    const price = await request(`/api/market/price?symbol=${encodeURIComponent(symbol)}`);
    if (symbol !== currentSymbol()) return;
    app.lastPriceValue = Number(price.price);
    ui.lastPrice.textContent = formatPrice(price.price);
    ui.limitMetaLabel.textContent = `Last ${formatPrice(price.price)}`;
    if (updateLiveFifteenSecondCandle(price.price)) drawChart();
    updatePositionSize();
  } catch {
    // Keep the last known price. Full refresh will surface errors.
  }
}

function drawChart() {
  const canvas = ui.chart;
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(320, Math.floor(rect.width * dpr));
  const height = Math.max(260, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0b0f0e";
  ctx.fillRect(0, 0, width, height);

  const padding = {
    top: 20 * dpr,
    right: 70 * dpr,
    bottom: 28 * dpr,
    left: 14 * dpr
  };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const rows = app.klines;
  if (!rows.length) {
    ctx.fillStyle = "#8fa09a";
    ctx.fillText("No chart data", padding.left, padding.top + 20);
    return;
  }

  const highs = rows.map((row) => Number(row.high));
  const lows = rows.map((row) => Number(row.low));
  const rawMax = Math.max(...highs);
  const rawMin = Math.min(...lows);
  const rawSpan = Math.max(rawMax - rawMin, rawMax * 0.002);
  const max = rawMax + rawSpan * 0.08;
  const min = rawMin - rawSpan * 0.08;
  const span = max - min;
  const priceToY = (price) => padding.top + ((max - price) / span) * plotH;
  const candleW = Math.max(3 * dpr, plotW / rows.length * 0.62);
  const gapW = plotW / rows.length;

  ctx.strokeStyle = "#1e2824";
  ctx.lineWidth = 1 * dpr;
  ctx.font = `${11 * dpr}px ui-sans-serif, system-ui`;
  ctx.fillStyle = "#70807a";
  for (let grid = 0; grid <= 4; grid += 1) {
    const y = padding.top + (plotH / 4) * grid;
    const price = max - (span / 4) * grid;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right + 8 * dpr, y);
    ctx.stroke();
    ctx.fillText(formatPrice(price), width - padding.right + 12 * dpr, y + 4 * dpr);
  }

  rows.forEach((row, index) => {
    const open = Number(row.open);
    const close = Number(row.close);
    const high = Number(row.high);
    const low = Number(row.low);
    const x = padding.left + gapW * index + gapW / 2;
    const yOpen = priceToY(open);
    const yClose = priceToY(close);
    const yHigh = priceToY(high);
    const yLow = priceToY(low);
    const up = close >= open;
    const color = up ? "#20bf74" : "#ff5c5c";

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, yHigh);
    ctx.lineTo(x, yLow);
    ctx.stroke();

    const bodyY = Math.min(yOpen, yClose);
    const bodyH = Math.max(1.5 * dpr, Math.abs(yClose - yOpen));
    ctx.fillRect(x - candleW / 2, bodyY, candleW, bodyH);
  });

  const chartConfig = app.session?.chartConfig || {};
  if (chartConfig.vwapEnabled !== false && rows.length >= 2) {
    const vwapValues = rollingVwap(rows, chartConfig.vwapPeriod || chartLimit());
    ctx.strokeStyle = "rgba(255, 210, 114, 0.78)";
    ctx.lineWidth = 1.1 * dpr;
    ctx.setLineDash([]);
    ctx.beginPath();
    vwapValues.forEach((value, index) => {
      const x = padding.left + gapW * index + gapW / 2;
      const y = priceToY(value);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

  }

  const channelRows = rows.slice(ui.intervalSelect.value === "15s" ? -50 : -80);
  if (channelRows.length >= 20) {
    const offset = rows.length - channelRows.length;
    const n = channelRows.length;
    const closes = channelRows.map((row) => Number(row.close));
    const sumX = (n * (n - 1)) / 2;
    const sumY = closes.reduce((total, value) => total + value, 0);
    const sumXX = ((n - 1) * n * (2 * n - 1)) / 6;
    const sumXY = closes.reduce((total, value, index) => total + index * value, 0);
    const slope = (n * sumXY - sumX * sumY) / Math.max(1, n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    const residuals = closes.map((value, index) => value - (intercept + slope * index));
    const widthBand = Math.max(...residuals.map((value) => Math.abs(value)));

    const drawChannelLine = (shift, color, dash = []) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.9 * dpr;
      ctx.setLineDash(dash.map((item) => item * dpr));
      ctx.beginPath();
      for (let index = 0; index < n; index += 1) {
        const globalIndex = offset + index;
        const x = padding.left + gapW * globalIndex + gapW / 2;
        const y = priceToY(intercept + slope * index + shift);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };

    drawChannelLine(widthBand, "rgba(90, 167, 255, 0.42)");
    drawChannelLine(0, "rgba(232, 184, 74, 0.38)", [4, 5]);
    drawChannelLine(-widthBand, "rgba(90, 167, 255, 0.42)");
  }

  const last = Number(rows[rows.length - 1].close);
  const lastY = priceToY(last);
  ctx.strokeStyle = "#e8b84a";
  ctx.setLineDash([5 * dpr, 5 * dpr]);
  ctx.beginPath();
  ctx.moveTo(padding.left, lastY);
  ctx.lineTo(width - padding.right, lastY);
  ctx.stroke();
  ctx.setLineDash([]);

  if (app.chartPointer) {
    const x = app.chartPointer.x * dpr;
    const y = app.chartPointer.y * dpr;
    ctx.strokeStyle = "rgba(143, 160, 154, 0.55)";
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, height - padding.bottom);
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();

    const index = Math.max(0, Math.min(rows.length - 1, Math.floor((x - padding.left) / gapW)));
    const row = rows[index];
    if (row) {
      const date = new Date(row.openTime).toLocaleString("ko-KR", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      });
      ui.crosshairReadout.textContent = `${date} O ${formatPrice(row.open)} H ${formatPrice(row.high)} L ${formatPrice(row.low)} C ${formatPrice(row.close)}`;
    }
  } else {
    ui.crosshairReadout.textContent = `C ${formatPrice(rows[rows.length - 1].close)}`;
  }
}

function startAccountPolling() {
  if (app.accountTimer) return;
  app.accountTimer = window.setInterval(() => {
    loadAccount().catch((error) => toast(error.message, true));
  }, accountRefreshMs());
}

function accountRefreshMs() {
  const configured = Number(app.session?.accountStream?.refreshMs || ACCOUNT_REFRESH_MS);
  return Number.isFinite(configured) ? Math.max(250, configured) : ACCOUNT_REFRESH_MS;
}

function scheduleAccountRefresh(delay = 0) {
  window.clearTimeout(app.accountRefreshDelayTimer);
  app.accountRefreshDelayTimer = window.setTimeout(() => {
    loadAccount().catch((error) => toast(error.message, true));
  }, delay);
}

function connectAccountEvents() {
  if (!window.EventSource || app.accountEventSource) return;
  const source = new EventSource("/api/account/events");
  app.accountEventSource = source;
  source.addEventListener("account-dirty", () => {
    scheduleAccountRefresh(0);
  });
  source.addEventListener("stream-status", (event) => {
    try {
      const status = JSON.parse(event.data);
      app.session.accountStream = {
        ...(app.session.accountStream || {}),
        ...status
      };
    } catch {
      // Keep REST polling active if the status payload is malformed.
    }
  });
  source.onerror = () => {
    scheduleAccountRefresh(accountRefreshMs());
  };
}

function renderAccountSummary(summary) {
  app.accountSummary = summary;
  if (!ui.accountBalance || !ui.sessionPnl) return;

  const asset = summary?.asset || (currentSymbol().endsWith("USDC") ? "USDC" : "USDT");
  const balance = Number.isFinite(Number(summary?.availableBalance))
    ? summary.availableBalance
    : summary?.walletBalance;
  const pnl = Number(summary?.sessionPnl);

  ui.accountBalance.textContent = `${formatNumber(balance, 2)} ${asset}`;
  ui.sessionPnl.textContent = `${formatSignedAmount(pnl, 2)} ${asset}`;
  ui.sessionPnl.className = signedClass(pnl);
}

async function loadAccount() {
  if (app.accountRefreshInFlight) return;
  app.accountRefreshInFlight = true;
  const symbol = currentSymbol();
  try {
    const payload = await request(`/api/account/snapshot?symbol=${encodeURIComponent(symbol)}`);
    app.positions = payload.positions;
    renderPositions(payload.positions);
    renderOrders(payload.orders);
    renderJobs(payload.jobs);
    renderAccountSummary(payload.summary);
    if (syncCloseQuantityFromPositions()) updateChaseSummary();
    updatePositionSize();
  } finally {
    app.accountRefreshInFlight = false;
  }
}

function emptyRow(columns, text) {
  return `<tr><td colspan="${columns}" class="muted-cell">${escapeHtml(text)}</td></tr>`;
}

function renderPositions(positions) {
  if (!positions.length) {
    ui.positionsBody.innerHTML = emptyRow(7, "포지션 없음");
    return;
  }
  ui.positionsBody.innerHTML = positions.map((position) => `
    <tr>
      <td>${escapeHtml(position.symbol)}</td>
      <td class="${position.side === "LONG" ? "positive" : position.side === "SHORT" ? "negative" : ""}">${escapeHtml(position.side)}</td>
      <td>${formatNumber(position.positionAmt, 6)}</td>
      <td>${formatPrice(position.entryPrice)}</td>
      <td>${formatPrice(position.markPrice)}</td>
      <td class="${signedClass(position.unRealizedProfit)}">${formatNumber(position.unRealizedProfit, 4)}</td>
      <td>${formatPrice(position.liquidationPrice)}</td>
    </tr>
  `).join("");
}

function renderOrders(orders) {
  if (!orders.length) {
    ui.ordersBody.innerHTML = emptyRow(7, "오픈 오더 없음");
    return;
  }
  ui.ordersBody.innerHTML = orders.map((order) => `
    <tr>
      <td>${escapeHtml(order.symbol)}</td>
      <td class="${intentClass(order.action, order.positionSide)}">${escapeHtml(order.action || "-")}</td>
      <td>${escapeHtml(order.positionSide || "-")}</td>
      <td>${escapeHtml(order.type || "-")} ${escapeHtml(order.timeInForce || "")}</td>
      <td>${formatNumber(order.origQty, 6)}</td>
      <td>${formatPrice(order.price)}</td>
      <td>${escapeHtml(order.status)}</td>
    </tr>
  `).join("");
}

function jobPurposeLabel(purpose) {
  if (purpose === "reverse-close") return "REV CLOSE";
  if (purpose === "reverse-open") return "REV OPEN";
  return "";
}

function normalizedJobStatus(job) {
  return String(job?.status || "unknown").toLowerCase();
}

function jobStatusClass(job) {
  const status = normalizedJobStatus(job);
  if (status === "running" || status === "stopping") return "job-active";
  if (status === "error" || status === "rejected" || status === "expired") return "job-error-state";
  if (status === "filled" || status === "done") return "job-done";
  if (TERMINAL_JOB_STATUSES.has(status)) return "job-terminal";
  return "";
}

function statusPillClass(job) {
  const status = normalizedJobStatus(job);
  if (status === "running" || status === "stopping") return "status-active";
  if (status === "error" || status === "rejected" || status === "expired") return "status-error";
  if (status === "filled" || status === "done") return "status-done";
  if (TERMINAL_JOB_STATUSES.has(status)) return "status-terminal";
  return "status-muted";
}

function jobTitle(job) {
  return [
    jobPurposeLabel(job.purpose),
    job.symbol,
    job.action || job.side,
    job.positionSide,
    "LIMIT",
    job.timeInForce
  ].filter(Boolean).join(" ");
}

function jobTargetText(job) {
  const pending = job.pendingPrice ? formatPrice(job.pendingPrice) : "";
  const last = job.lastPrice ? formatPrice(job.lastPrice) : "";
  if (pending && pending !== "-") {
    return last && pending !== last ? `${pending} pending` : pending;
  }
  return last || "-";
}

function jobReplacementText(job) {
  const count = Number(job.replaceCount || 0);
  const max = Number(job.maxReplaces || 0);
  return max > 0 ? `${count}/${max}` : `${count}`;
}

function jobRetryText(job) {
  const current = Number(job.retryCount || 0);
  const total = Number(job.totalRetries || 0);
  return `${current}/${total}`;
}

function jobSortRank(job) {
  const status = normalizedJobStatus(job);
  if (status === "running") return 0;
  if (status === "stopping") return 1;
  if (status === "error" || status === "rejected" || status === "expired") return 2;
  if (status === "filled" || status === "done") return 3;
  if (TERMINAL_JOB_STATUSES.has(status)) return 4;
  return 5;
}

function jobSortTime(job) {
  const time = Date.parse(job?.updatedAt || job?.createdAt || "");
  return Number.isFinite(time) ? time : 0;
}

function shortTime(value) {
  if (!value) return "";
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return "";
  return time.toLocaleTimeString("ko-KR", { hour12: false });
}

function jobTerminalText(job) {
  const status = normalizedJobStatus(job);
  if (!TERMINAL_JOB_STATUSES.has(status)) return "";
  const time = shortTime(job.filledAt || job.updatedAt);
  const reason = compactText(job.terminalReason || job.error || "", 120);
  return [
    `terminal ${status.toUpperCase()}`,
    time ? `@ ${time}` : "",
    reason && reason.toLowerCase() !== status ? reason : ""
  ].filter(Boolean).join(" · ");
}

function jobLastErrorText(job) {
  return compactText(job.lastError || job.error || "", 140);
}

function renderJobField(label, value, extraClass = "") {
  return `
    <div class="job-field ${extraClass}">
      <span class="job-field-label">${escapeHtml(label)}</span>
      <span>${escapeHtml(value || "-")}</span>
    </div>
  `;
}

function compactJobTelemetry(job) {
  const parts = [];
  if (job.marketSource) parts.push(job.marketSource);
  if (job.lastWakeSource && job.lastWakeSource !== job.marketSource) parts.push(`wake ${job.lastWakeSource}`);
  if (job.replaceStrategy) parts.push(job.replaceStrategy);
  if (job.fillStatus && job.fillStatus !== "none") parts.push(`fill-state ${job.fillStatus}`);
  if (job.lastReplaceLatencyMs) parts.push(`ack ${job.lastReplaceLatencyMs}ms`);
  if (job.lastReplaceTotalMs && job.lastReplaceTotalMs !== job.lastReplaceLatencyMs) {
    parts.push(`total ${job.lastReplaceTotalMs}ms`);
  }
  if (job.rateGateWaitMs || job.lastRateGateWaitMs) parts.push(`gate ${job.rateGateWaitMs || job.lastRateGateWaitMs}ms`);
  if (job.statusSource) parts.push(`status ${job.statusSource}`);
  if (job.fillSource) parts.push(`fill ${job.fillSource}`);
  return parts.join(" · ");
}

function jobStateLabel(job) {
  const state = job.state || job.status || "";
  return job.terminalReason ? `${state} (${job.terminalReason})` : state;
}

function jobQuantityLabel(job) {
  const remaining = job.remainingQuantity || job.quantity;
  const original = job.originalQuantity || job.quantity;
  if (remaining !== original) {
    return `${formatNumber(remaining, 6)} / ${formatNumber(original, 6)}`;
  }
  return formatNumber(job.quantity, 6);
}

function renderJobs(jobs) {
  const sortedJobs = jobs.slice().sort((a, b) => (
    jobSortRank(a) - jobSortRank(b) ||
    jobSortTime(b) - jobSortTime(a)
  ));
  const activeJobs = sortedJobs.slice(0, 8);
  const runningJob = sortedJobs.find((job) => normalizedJobStatus(job) === "running");
  app.hasRunningChaseJob = Boolean(runningJob);
  app.chaseJobId = runningJob?.id || "";
  updateActionControls();
  if (!activeJobs.length) {
    ui.jobsList.innerHTML = `<div class="job-item"><span class="job-meta">추격 지정가 작업 없음</span></div>`;
    return;
  }
  ui.jobsList.innerHTML = activeJobs.map((job) => {
    const telemetry = compactJobTelemetry(job);
    const terminalText = jobTerminalText(job);
    const lastError = jobLastErrorText(job);
    return `
    <div class="job-item ${jobStatusClass(job)}">
      <div class="job-main">
        <span class="job-title">${escapeHtml(jobTitle(job))}</span>
        <span class="status-pill ${statusPillClass(job)}">${escapeHtml(normalizedJobStatus(job).toUpperCase())}</span>
      </div>
      <div class="job-fields">
        ${renderJobField("qty", formatNumber(job.quantity, 6))}
        ${renderJobField("target", jobTargetText(job))}
        ${renderJobField("peg", `${job.pegSide || pegSideLabel(job.action || "OPEN", job.positionSide || "LONG")} ${signedTickOffset(job.tickOffset)}`)}
        ${renderJobField("replace", jobReplacementText(job))}
        ${renderJobField("retry", jobRetryText(job), Number(job.retryCount || 0) > 0 ? "job-field-warn" : "")}
        ${renderJobField("interval", job.effectiveUpdateMs ? `${job.effectiveUpdateMs}ms` : "-")}
      </div>
      ${telemetry ? `<div class="job-meta job-telemetry">${escapeHtml(telemetry)}</div>` : ""}
      ${job.backoffMs ? `<div class="job-meta job-backoff">backoff ${escapeHtml(job.backoffMs)}ms</div>` : ""}
      ${terminalText ? `<div class="job-meta job-terminal-text">${escapeHtml(terminalText)}</div>` : ""}
      ${lastError ? `<div class="job-last-error">last error: ${escapeHtml(lastError)}</div>` : ""}
    </div>
  `;
  }).join("");
}

async function loadLogs() {
  const { logs } = await request("/api/logs");
  ui.logOutput.innerHTML = logs.map((line) => {
    const time = new Date(line.time).toLocaleTimeString("ko-KR", { hour12: false });
    const levelClass = line.level === "error" ? "log-error" : line.level === "warn" ? "log-warn" : "";
    return `
      <div class="log-line ${levelClass}">
        <span>${time}</span>
        <span>${escapeHtml(line.level.toUpperCase())}</span>
        <span>${escapeHtml(line.message)}</span>
      </div>
    `;
  }).join("");
  ui.lastUpdated.textContent = new Date().toLocaleTimeString("ko-KR", { hour12: false });
}

async function refreshAll() {
  try {
    await loadMarket();
    await loadAccount();
    await loadLogs();
  } catch (error) {
    toast(error.message, true);
  }
}

function orderBody() {
  return {
    symbol: currentSymbol(),
    action: app.selectedAction,
    positionSide: app.selectedIntent,
    leverage: Number(ui.leverageInput.value),
    quantity: ui.quantityInput.value,
    price: ui.limitPriceInput.value,
    executionMode: ui.fastModeInput.checked ? "MARKET" : "LIMIT",
    stopLossEnabled: ui.stopLossEnabledInput.checked,
    stopLossAmount: ui.stopLossAmountInput.value,
    takeProfitEnabled: ui.takeProfitEnabledInput.checked,
    takeProfitAmount: ui.takeProfitAmountInput.value
  };
}

async function setLeverage() {
  await post("/api/trade/leverage", {
    symbol: currentSymbol(),
    leverage: Number(ui.leverageInput.value)
  });
  await loadLogs();
}

function scheduleLeverageApply() {
  updateChaseSummary();
  window.clearTimeout(app.leverageApplyTimer);
  app.leverageApplyTimer = window.setTimeout(() => {
    setLeverage().catch((error) => toast(error.message, true));
  }, 700);
}

async function placeLimitOrder() {
  await post("/api/trade/limit-order", orderBody());
  toast("지정가 주문 전송 완료");
  await refreshAll();
}

async function placeMarketOrder() {
  await post("/api/trade/market-order", orderBody());
  toast("FAST 주문 체결 요청 완료");
  await refreshAll();
}

async function submitLimitOrder() {
  const actionKey = currentSubmitActionKey();
  await runTradeAction(actionKey, async () => {
    if (ui.fastModeInput.checked) {
      await placeMarketOrder();
      return;
    }
    if (ui.autoChaseInput.checked) {
      await startChase();
      return;
    }
    await placeLimitOrder();
  });
}

async function startChase() {
  const job = await post("/api/trade/chase/start", {
    ...orderBody()
  });
  app.chaseJobId = job.id;
  app.hasRunningChaseJob = normalizedJobStatus(job) === "running";
  updateActionControls();
  toast("추격 지정가 시작");
  await refreshAll();
}

async function reversePosition() {
  const from = app.selectedIntent;
  const to = oppositeIntent(from);
  const route = ui.fastModeInput.checked ? "MARKET 즉시" : "chase";
  const ok = window.confirm(`${currentSymbol()} ${from} 포지션을 현재 수량 기준으로 ${route} 정리 후 ${to} OPEN 합니다.`);
  if (!ok) return;

  await runTradeAction("reverse", async () => {
    const result = await post("/api/trade/reverse", {
      ...orderBody(),
      action: "CLOSE",
      positionSide: from,
      confirm: "REVERSE_POSITION"
    });
    if (result.id) {
      app.chaseJobId = result.id;
      app.hasRunningChaseJob = normalizedJobStatus(result) === "running";
      updateActionControls();
    }
    toast(`${ui.fastModeInput.checked ? "FAST " : ""}리버스 시작 ${from} -> ${to}`);
    await refreshAll();
  });
}

async function stopChase() {
  if (!app.chaseJobId || !app.hasRunningChaseJob) {
    const message = "CHASE STOP failed: 중지할 추격 지정가 작업이 없습니다";
    setOperationStatus(message, "negative");
    toast(message, true);
    return;
  }
  await runTradeAction("chaseStop", async () => {
    await post("/api/trade/chase/stop", {
      jobId: app.chaseJobId,
      cancelOrder: true,
      confirm: "STOP_CHASE"
    });
    app.hasRunningChaseJob = false;
    app.chaseJobId = "";
    updateActionControls();
    toast("추격 주문 중지");
    await refreshAll();
  });
}

async function cancelAllOrders() {
  const symbol = currentSymbol();
  const ok = window.confirm(`${symbol} 오픈 오더를 모두 취소할까요?`);
  if (!ok) return;
  await runTradeAction("cancel", async () => {
    await post("/api/trade/cancel-all", { symbol, confirm: "CANCEL_ALL" });
    toast("오픈 오더 취소 완료");
    await refreshAll();
  });

}

async function emergencyClose() {
  const target = ui.closeAllInput.checked ? "전체 심볼" : currentSymbol();
  const typed = window.prompt(`${target} 포지션 정리 확인: CLOSE_NOW 입력`);
  if (typed !== "CLOSE_NOW") return;
  await runTradeAction("emergency", async () => {
    await post("/api/trade/emergency-close", {
      symbol: currentSymbol(),
      all: ui.closeAllInput.checked,
      confirm: "CLOSE_NOW"
    });
    toast("긴급 정리 요청 완료");
    await refreshAll();
  });
}

function setAction(action) {
  if (app.selectedAction === "OPEN") app.openQuantityValue = ui.quantityInput.value;
  app.selectedAction = action;
  ui.openAction.classList.toggle("active", action === "OPEN");
  ui.closeAction.classList.toggle("active", action === "CLOSE");
  if (action === "OPEN") {
    ui.quantityInput.value = app.openQuantityValue || ui.quantityInput.value;
    ui.quantityInput.removeAttribute("max");
  } else {
    syncCloseQuantityFromPositions();
  }
  setReferenceLimitPrice();
  updateChaseSummary();
}

function setIntent(intent) {
  app.selectedIntent = intent;
  ui.longIntent.classList.toggle("active", intent === "LONG");
  ui.shortIntent.classList.toggle("active", intent === "SHORT");
  syncCloseQuantityFromPositions();
  setReferenceLimitPrice();
  updateChaseSummary();
}

function setReferenceLimitPrice() {
  const side = apiSideForIntent(app.selectedAction, app.selectedIntent);
  const bookPrice = side === "BUY" ? app.orderBook?.bids?.[0]?.[0] : app.orderBook?.asks?.[0]?.[0];
  if (bookPrice) ui.limitPriceInput.value = bookPrice;
}

async function applySymbolChange() {
  const typed = normalizedSymbolInput();
  if (!typed || !isKnownSymbol(typed) || typed === app.activeSymbol) return false;

  app.activeSymbol = typed;
  app.marketRequestSeq += 1;
  ui.symbolInput.value = app.activeSymbol;
  ui.limitPriceInput.value = "";
  app.positions = [];
  app.klines = [];
  app.orderBook = null;
  app.chartPointer = null;
  drawChart();
  syncCloseQuantityFromPositions();
  await loadLeverageBracket();
  scheduleLeverageApply();
  await refreshAll();
  return true;
}

function scheduleSymbolApply() {
  window.clearTimeout(app.symbolApplyTimer);
  const typed = normalizedSymbolInput();
  if (!isKnownSymbol(typed) || typed === app.activeSymbol) return;
  app.symbolApplyTimer = window.setTimeout(() => {
    applySymbolChange().catch((error) => toast(error.message, true));
  }, 180);
}

function bindEvents() {
  ui.refreshButton.addEventListener("click", refreshAll);
  ui.symbolInput.addEventListener("input", () => {
    ui.symbolInput.value = normalizedSymbolInput();
    scheduleSymbolApply();
  });
  ui.symbolInput.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    window.clearTimeout(app.symbolApplyTimer);
    if (await applySymbolChange()) return;
    ui.symbolInput.dispatchEvent(new Event("change"));
  });
  ui.symbolInput.addEventListener("change", async () => {
    const typed = ui.symbolInput.value.trim().toUpperCase();
    const exact = app.symbols.some((item) => item.symbol === typed);
    if (!exact) {
      toast("정확한 티커를 선택하세요", true);
      ui.symbolInput.value = app.activeSymbol;
      return;
    }
    app.activeSymbol = typed;
    ui.symbolInput.value = app.activeSymbol;
    ui.limitPriceInput.value = "";
    app.positions = [];
    syncCloseQuantityFromPositions();
    await loadLeverageBracket();
    scheduleLeverageApply();
    await refreshAll();
  });
  ui.intervalSelect.addEventListener("change", loadMarket);
  ui.positionsRefresh.addEventListener("click", loadAccount);
  ui.ordersRefresh.addEventListener("click", loadAccount);
  ui.limitOrderButton.addEventListener("click", submitLimitOrder);
  ui.reverseButton?.addEventListener("click", reversePosition);
  ui.stopChaseButton.addEventListener("click", stopChase);
  ui.cancelAllButton.addEventListener("click", cancelAllOrders);
  ui.emergencyButton.addEventListener("click", emergencyClose);
  ui.openAction.addEventListener("click", () => setAction("OPEN"));
  ui.closeAction.addEventListener("click", () => setAction("CLOSE"));
  ui.longIntent.addEventListener("click", () => setIntent("LONG"));
  ui.shortIntent.addEventListener("click", () => setIntent("SHORT"));
  ui.leverageInput.addEventListener("input", scheduleLeverageApply);
  ui.quantityInput.addEventListener("input", () => {
    if (app.selectedAction === "OPEN") app.openQuantityValue = ui.quantityInput.value;
  });
  ui.autoChaseInput.addEventListener("change", () => {
    normalizeOrderMode("CHASE");
    updateChaseSummary();
  });
  ui.fastModeInput.addEventListener("change", () => {
    normalizeOrderMode("FAST");
    updateChaseSummary();
  });
  ui.stopLossEnabledInput.addEventListener("change", () => {
    ui.stopLossAmountInput.disabled = !ui.stopLossEnabledInput.checked;
    updateChaseSummary();
  });
  ui.takeProfitEnabledInput.addEventListener("change", () => {
    ui.takeProfitAmountInput.disabled = !ui.takeProfitEnabledInput.checked;
    updateChaseSummary();
  });
  [
    ui.quantityInput,
    ui.limitPriceInput,
    ui.stopLossAmountInput,
    ui.takeProfitAmountInput
  ].forEach((control) => {
    control.addEventListener("input", updateChaseSummary);
    control.addEventListener("change", updateChaseSummary);
  });
  ui.chart.addEventListener("pointermove", (event) => {
    const rect = ui.chart.getBoundingClientRect();
    app.chartPointer = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
    drawChart();
  });
  ui.chart.addEventListener("pointerleave", () => {
    app.chartPointer = null;
    drawChart();
  });
  window.addEventListener("resize", drawChart);
}

async function boot() {
  bindEvents();
  await loadSession();
  connectAccountEvents();
  await loadSymbols();
  await refreshAll();
  startAccountPolling();
  app.refreshTimer = window.setInterval(() => {
    Promise.all([loadMarket(), loadLogs()]).catch((error) => toast(error.message, true));
  }, 15000);
  app.priceTimer = window.setInterval(loadPriceTick, 1000);
}

boot().catch((error) => {
  toast(error.message, true);
});
