# Dry-Run and Testnet Validation

Use this checklist before evaluating the terminal with real funds. The default path is `dry-run`; `testnet` is the next gate. Do not use `live` until both have been completed with the same package and configuration style you intend to use.

Never commit or share `.env.session`, API keys, `local_config` values, logs, build artifacts, or screenshots that show account data.

## Automated Checks

Run these from the repository root in Windows PowerShell:

```powershell
node --test tests/*.test.js
npm run check
```

`npm test` runs the same `node --test tests/*.test.js` command.

If `npm` is not available in a portable/runtime-only shell, run the package check commands directly:

```powershell
node --check src/server.js
node --check src/account-stream-normalizers.js
node --check src/exchanges/binance-usdm.js
node --check src/exchanges/mememax-orderly.js
node --check src/exchanges/registry.js
node --check src/exchanges/types.js
node --check public/app.js
```

## Dry-Run Smoke Checklist

Prepare a dry-run session:

```powershell
Copy-Item .env.session.example .env.session
```

Confirm `.env.session` contains:

```env
SESSION_EXCHANGE_ID=mememax-orderly
TRADING_MODE=dry-run
```

Leave credential fields empty for this pass. Start the app:

```powershell
node src/server.js
```

Or use the portable launcher script:

```powershell
.\start-terminal.ps1
```

Open `http://127.0.0.1:8787` and verify each flow:

| Flow | Expected dry-run result |
| --- | --- |
| App launch | Header shows dry-run mode and the server logs do not print secrets. |
| Symbol load | MemeMax symbols load, with `BTCUSDC` available. |
| Chart load | 15s chart candles render for the selected symbol. |
| Orderbook/price load | Best bid/ask and current price are visible and internally plausible. |
| Leverage change | Moving the leverage slider updates the displayed value and accepts a dry-run leverage update. |
| Limit order | A limit OPEN order creates a dry-run open order with no real API credentials required. |
| FAST order | A FAST market OPEN fills in dry-run and creates a local position. |
| Chase start/stop | Starting Auto chase creates a chase job; stopping it marks the job stopped and cancels its dry-run order when present. |
| Reverse behavior | With a dry-run position open, Reverse closes the selected side and opens the opposite side. Test both normal chase reverse and FAST reverse when practical. |
| Cancel orders | Open order cancel removes dry-run open orders for the symbol. |
| Emergency close | Confirming emergency close with `CLOSE_NOW` cancels dry-run orders and flattens dry-run positions. |

If any step fails, stay in dry-run and fix that issue before attempting testnet.

## Testnet Readiness Checklist

Create or edit `.env.session` locally only. Required fields for MemeMax Orderly testnet:

```env
SESSION_EXCHANGE_ID=mememax-orderly
TRADING_MODE=testnet
MEMEMAX_ORDERLY_ACCOUNT_ID=<testnet account id>
MEMEMAX_ORDERLY_SECRET=<testnet orderly secret>
```

`MEMEMAX_ORDERLY_KEY` is optional only when it can be derived from `MEMEMAX_ORDERLY_SECRET`. Set `MEMEMAX_ORDER_TAG` if you need exchange-side order tagging.

Use the default testnet endpoints unless you have a known reason to override them:

```env
MEMEMAX_ORDERLY_TESTNET_BASE_URL=
MEMEMAX_ORDERLY_TESTNET_PUBLIC_WS_BASE_URL=
MEMEMAX_ORDERLY_TESTNET_PRIVATE_WS_BASE_URL=
```

Before testnet trading, verify:

| Flow | Expected testnet result |
| --- | --- |
| App launch | Header shows testnet mode and an API preview only, never the full key or secret. |
| Symbol load | `BTCUSDC` and other expected MemeMax perp symbols load from testnet/public data. |
| Chart load | 15s candles render; public WebSocket status is connected when credentials/runtime support it, or REST fallback remains usable. |
| Orderbook/price load | Orderbook and ticker update from testnet data. |
| Account summary | Balances and positions load for the testnet account, or a clear non-secret error is shown. |
| Leverage change | A small leverage change succeeds on testnet and is reflected in subsequent order flow. |
| Limit order | Place a tiny post-only limit order away from the touch; verify it appears in open orders; cancel it. |
| FAST order | Place the minimum practical testnet market order only after limit/cancel works; verify the resulting position. |
| Chase start/stop | Start chase with the smallest practical size; confirm replace cadence respects configured rate limits; stop and cancel the active order. |
| Reverse behavior | Reverse only a tiny testnet position; verify close/open sides and resulting position direction. |
| Cancel orders | Cancel all open orders for the symbol and verify none remain. |
| Emergency close | With a tiny testnet position open, confirm `CLOSE_NOW`; verify all symbol orders are canceled and the position is flat. |

Record only pass/fail notes that do not include secrets or account-identifying screenshots.

## Live Readiness Gate

Live mode is intentionally locked. A persisted live session must include:

```env
TRADING_MODE=live
LIVE_UNLOCK_PHRASE=I_ACCEPT_LIVE_RISK
```

Only set `LIVE_UNLOCK_PHRASE=I_ACCEPT_LIVE_RISK` after dry-run and testnet validation pass. Live mode is not part of this smoke path, and this checklist does not add or require live trading behavior.
