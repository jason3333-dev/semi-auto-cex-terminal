# MemeMax Orderly Semi-Auto Terminal

MemeMax Orderly perps를 기준으로 만든 로컬 반자동 트레이딩 터미널입니다. 기본 모드는 `dry-run`이며, API 키가 없으면 실제 주문을 내지 않습니다. UI는 프로 트레이더가 빠르게 쓰는 것을 기준으로 최소한의 조작만 남깁니다.

## 주요 기능

- MemeMax Orderly perp 심볼 검색과 TradingView Lightweight Charts 기반 15초 기본 차트
- Orderly public WebSocket 기반 가격, 오더북, ticker, trade, kline 구독
- 티커 변경 시 이전 market stream 구독 정리
- OPEN/CLOSE, LONG/SHORT, 레버리지 슬라이더, 수량/지정가 입력
- Auto chase 지정가 주문과 FAST 시장가 주문
- Rate limit 안에서 chase replace 속도 제어
- Reverse: 현재 포지션 chase 정리 후 반대 포지션 OPEN
- Stop loss / take profit 금액 입력
- 포지션, 오픈 오더, chase job, 잔액, 세션 PnL 표시
- 긴급 정리: 오픈 오더 취소, 포지션 정리
- 거래소 어댑터 구조: MemeMax Orderly를 기본으로 두고 필요 시 확장

## 실행

개발 모드:

```powershell
node src/server.js
```

Codex 번들 Node를 직접 사용할 때:

```powershell
& 'C:\Users\zinfr\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' src/server.js
```

PowerShell 런처:

```powershell
.\start-terminal.ps1
```

브라우저에서 `http://127.0.0.1:8787`을 엽니다.

Dry-run smoke와 testnet 준비 절차는 [docs/validation.md](docs/validation.md)에 정리되어 있습니다. `live` 모드는 dry-run/testnet 검증 후에만 사용하고, 영구 live 설정에는 반드시 `LIVE_UNLOCK_PHRASE=I_ACCEPT_LIVE_RISK`가 필요합니다.

## 실행 파일

```powershell
.\build-launcher.ps1
.\dist\SemiAutoCexTerminal.exe
```

`SemiAutoCexTerminal.exe`는 로컬 서버를 실행하고 브라우저를 엽니다. 런처 창을 닫으면 로컬 서버도 같이 종료됩니다.

## 리테일 포터블 배포

```powershell
.\build-retail.ps1
```

생성 위치:

```text
dist\retail\SemiAutoCexTerminal-win-x64\
dist\retail\SemiAutoCexTerminal-win-x64.zip
```

포터블 패키지는 `SemiAutoCexTerminal.exe`, `runtime\node.exe`, `app\` 소스 파일을 포함합니다. 실제 세션 설정은 패키지 폴더가 아니라 아래 위치에 생성됩니다.

```text
%LOCALAPPDATA%\SemiAutoCexTerminal\.env.session
```

## Order audit logs

Order lifecycle audit events are appended as UTF-8 JSONL here by default:

```text
%LOCALAPPDATA%\SemiAutoCexTerminal\logs\order-audit.jsonl
```

Each line is one JSON object. The log records submit, replace, cancel, bracket,
reverse, emergency close, chase transition, fill, and error events with API keys,
account ids, signatures, private keys, credentials, and raw session config
redacted before writing. To use a different local path, set
`ORDER_AUDIT_LOG_PATH` in `.env.session`.

To clear the audit log, stop the terminal and delete either
`%LOCALAPPDATA%\SemiAutoCexTerminal\logs\order-audit.jsonl` or the whole
`%LOCALAPPDATA%\SemiAutoCexTerminal\logs\` directory. Do not commit or share
audit logs; they are local runtime data.

첫 실행 시 `app\.env.session.example`을 기반으로 dry-run 템플릿을 만듭니다. 패키지에는 실제 `.env.session`, API 키, 로그, 디버그 이미지, 빌드 산출물이 포함되지 않습니다.

## 세션과 API 설정

세션은 `.env.session`에서만 관리합니다. 이 파일은 Git ignore 대상이며 UI에는 API 키나 모드 변경 폼을 두지 않습니다. 값을 바꾼 뒤 서버를 재시작하면 반영됩니다.

MemeMax Orderly 기준 예시:

```env
SESSION_EXCHANGE_ID=mememax-orderly
TRADING_MODE=dry-run

MEMEMAX_ORDERLY_ACCOUNT_ID=
MEMEMAX_ORDERLY_KEY=
MEMEMAX_ORDERLY_SECRET=
MEMEMAX_ORDER_TAG=
MEMEMAX_ORDERLY_BASE_URL=
MEMEMAX_ORDERLY_TESTNET_BASE_URL=
MEMEMAX_ORDERLY_PUBLIC_WS_BASE_URL=
MEMEMAX_ORDERLY_TESTNET_PUBLIC_WS_BASE_URL=
MEMEMAX_ORDERLY_PRIVATE_WS_BASE_URL=
MEMEMAX_ORDERLY_TESTNET_PRIVATE_WS_BASE_URL=

MEMEMAX_CHASE_MIN_UPDATE_MS=100
MEMEMAX_CHASE_UPDATE_MS=100
MEMEMAX_CHASE_RATE_LIMIT_10S_ORDERS=100
MEMEMAX_CHASE_RATE_LIMIT_SAFETY=1
MEMEMAX_CHASE_RATE_LIMIT_WINDOW_MS=1000
MEMEMAX_CHASE_ORDER_OPS_PER_REPLACE=1
MEMEMAX_CHASE_REST_FALLBACK_UPDATE_MS=1000
MEMEMAX_CHASE_STATUS_CHECK_MS=1000
MEMEMAX_CHASE_STATUS_POLL_WITH_PRIVATE_STREAM=false

MEMEMAX_ALGO_RATE_LIMIT_10S_ORDERS=10
MEMEMAX_ALGO_RATE_LIMIT_WINDOW_MS=1000
MEMEMAX_ALGO_RATE_LIMIT_SAFETY=1

ORDER_POST_ONLY=true
CHASE_POST_ONLY=true
CHASE_TICK_OFFSET=0
CHASE_MAX_REPLACES=240

LIVE_MAX_NOTIONAL=100
LIVE_MAX_LEVERAGE=10
# LIVE_ALLOWED_SYMBOLS=BTCUSDC,ETHUSDC

ACCOUNT_REFRESH_MS=1000
ACCOUNT_STREAM_ENABLED=true
ACCOUNT_STREAM_KEEPALIVE_MS=3000000
ACCOUNT_STREAM_RECONNECT_MS=5000

CHART_VWAP_ENABLED=true
CHART_VWAP_PERIOD=80
```

`MEMEMAX_ORDERLY_KEY`는 secret에서 유도할 수 있는 경우 생략할 수 있습니다. `live`를 영구 설정하려면 `LIVE_UNLOCK_PHRASE=I_ACCEPT_LIVE_RISK`가 필요합니다.

## MemeMax Orderly 기준

구현 기준은 Orderly EVM API입니다.

- Public info: `GET /v1/public/info`
- Futures ticker: `GET /v1/public/futures/{symbol}`
- Kline: `GET /v1/kline`
- Orderbook: `GET /v1/orderbook/{symbol}`
- Order create/edit/cancel/query: `/v1/order`, `/v1/orders`
- Position and account: `/v1/position`, `/v1/client/info`, `/v1/balances`
- Public WebSocket: `bbo`, `orderbook`, `ticker`, `trade`, `kline`
- Private WebSocket: execution report, position, balance/account updates

15초 봉은 Orderly의 1분 kline과 trade/ticker stream을 합쳐 로컬에서 합성합니다.

## 차트 엔진

차트는 TradingView Lightweight Charts v5.0.8 standalone 파일을 `public/vendor/`에 vendoring해서 사용합니다. 포터블 실행 파일에서도 인터넷 없이 동작하며, 라이브러리 라이선스 파일은 `public/vendor/lightweight-charts.LICENSE.txt`에 포함되어 있습니다. TradingView attribution logo는 차트 옵션에서 켜 둡니다.

## 기타 어댑터

기존 보조 어댑터는 `src/exchanges/` 아래에 남아 있지만, 문서와 기본 실행 기준은 MemeMax Orderly입니다. 다른 거래소를 쓰려면 `.env.session`에서 `SESSION_EXCHANGE_ID`를 명시하고 해당 API 키를 별도로 설정합니다.

## 다른 거래소 추가

1. `src/exchanges/types.js`의 어댑터 계약을 맞춥니다.
2. `src/exchanges/<exchange>.js` 파일을 추가합니다.
3. `src/exchanges/registry.js`에 등록합니다.
4. UI는 `/api/symbols`, `/api/market/*`, `/api/account/*`, `/api/trade/*` 계약을 통해 같은 방식으로 동작합니다.

## 안전 메모

이 도구는 매매 판단을 대신하지 않습니다. 네트워크 지연, API 제한, 부분 체결, Orderly 계정 상태, 포지션 모드, 거래소 장애로 인해 UI와 실제 주문 상태가 어긋날 수 있습니다. 큰 금액을 넣기 전에 [dry-run/testnet validation](docs/validation.md)을 먼저 통과하세요.
