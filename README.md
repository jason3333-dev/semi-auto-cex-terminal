# MemeMax Orderly Semi-Auto Terminal

MemeMax Orderly perps를 기준으로 만든 로컬 반자동 트레이딩 터미널입니다. 기본 모드는 `dry-run`이며, API 키가 없으면 실제 주문을 내지 않습니다. UI는 프로 트레이더가 빠르게 쓰는 것을 기준으로 최소한의 조작만 남깁니다.

## 주요 기능

- MemeMax Orderly perp 심볼 검색과 TradingView Lightweight Charts 기반 5분 기본 차트, 볼륨 표시
- Orderly public WebSocket 기반 가격, 오더북, ticker, trade, kline 구독
- 티커 변경 시 이전 market stream 구독 정리
- OPEN/CLOSE, LONG/SHORT, 레버리지 슬라이더, 수량/지정가 입력
- 기본 Auto chase 지정가 주문과 MARKET 시장가 주문
- Rate limit 안에서 chase replace 속도 제어
- Reverse: 현재 포지션 chase 정리 후 반대 포지션 OPEN
- Stop loss / take profit 금액 또는 `%` 비율 입력
- 포지션, 오픈 오더, chase job, 잔액, 세션 PnL 표시
- 긴급 정리: 오픈 오더 개별/전체 취소, 포지션 정리
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
MEMEMAX_ORDERLY_BROKER_ID=
MEMEMAX_ORDERLY_WALLET_ADDRESS=
MEMEMAX_ORDERLY_KEY_SCOPE=read,trading
MEMEMAX_ORDERLY_KEY_EXPIRATION_DAYS=365
MEMEMAX_ORDERLY_KEY_CREATED_AT=
MEMEMAX_ORDERLY_KEY_EXPIRES_AT=
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

MEMEMAX_MARKET_DATA_MODE=live

CHART_VWAP_ENABLED=true
CHART_VWAP_PERIOD=80
```

`MEMEMAX_ORDERLY_KEY`는 secret에서 유도할 수 있는 경우 생략할 수 있습니다. `TRADING_MODE=dry-run`이어도 `MEMEMAX_MARKET_DATA_MODE=live`가 기본이라 차트, last, 호가는 Orderly public live market data만 사용합니다. live public 요청이 실패하면 mock 가격으로 조용히 대체하지 않고 오류를 표시합니다. 오프라인 데모나 테스트만 `MEMEMAX_MARKET_DATA_MODE=mock`으로 바꿉니다. `live`를 영구 설정하려면 `LIVE_UNLOCK_PHRASE=I_ACCEPT_LIVE_RISK`가 필요합니다.

## 지갑 기반 거래 활성화

상단의 `지갑 연결`로 브라우저 지갑을 연결하면 MemeMax Orderly 계정 등록과 API 키 생성을 자동으로 진행합니다. 필요한 경우 브라우저 지갑의 권한/서명 모달이 뜨며, `거래 활성화` 버튼으로 같은 흐름을 수동 재시도할 수도 있습니다. 생성된 account id, orderly key, secret, 지갑 주소, 생성/만료 시각은 로컬 `.env.session`에만 저장됩니다.

이미 `.env.session`에 같은 지갑의 유효한 MemeMax Orderly 키가 있으면 새 키를 만들지 않고 재사용합니다. 키가 만료되었거나 저장된 지갑과 현재 지갑이 다르면 지갑 서명 모달을 통해 새 키를 발급합니다.

이 터미널은 실거래용이므로 온보딩은 **항상 Orderly 메인넷(`https://api.orderly.org`, 또는 `MEMEMAX_ORDERLY_BASE_URL`)** 으로만 키를 발급합니다. testnet으로는 전환하지 않습니다. 온보딩 후 거래 모드는 라이브 안전장치를 따릅니다. `.env`에 `LIVE_UNLOCK_PHRASE=I_ACCEPT_LIVE_RISK`가 설정돼 있으면 온보딩 완료 시 `live`(실거래)로 전환되고, 설정돼 있지 않으면 메인넷 키만 저장한 채 `dry-run`을 유지합니다(실주문은 나가지 않음). 실거래를 하려면 `LIVE_UNLOCK_PHRASE`를 먼저 설정하세요.

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

5분 봉을 기본으로 사용합니다. 15초 봉은 Orderly의 1분 kline과 trade/ticker stream을 합쳐 로컬에서 합성합니다.

공식 문서 링크와 API 에러 코드는 [`docs/orderly-api.md`](docs/orderly-api.md)에 정리해 두었습니다.

## 차트 엔진

차트는 TradingView Lightweight Charts v5.0.8 standalone 파일을 `public/vendor/`에 vendoring해서 사용합니다. 포터블 실행 파일에서도 인터넷 없이 동작하며, 라이브러리 라이선스 파일은 `public/vendor/lightweight-charts.LICENSE.txt`에 포함되어 있습니다. TradingView attribution logo는 차트 옵션에서 켜 둡니다.

## 지원 범위

현재 배포와 UI는 MemeMax Orderly 전용입니다. 다른 CEX 어댑터는 이 빌드의 활성 경로에 포함하지 않습니다.

## 안전 메모

이 도구는 매매 판단을 대신하지 않습니다. 네트워크 지연, API 제한, 부분 체결, Orderly 계정 상태, 포지션 모드, 거래소 장애로 인해 UI와 실제 주문 상태가 어긋날 수 있습니다. 큰 금액을 넣기 전에 [dry-run/testnet validation](docs/validation.md)을 먼저 통과하세요.
