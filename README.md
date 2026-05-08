# Semi-Auto CEX Terminal

로컬에서 실행하는 Binance USD-M Futures 반자동 터미널입니다. 기본 모드는 `dry-run`이라 실제 주문을 내지 않습니다.

## 기능

- 티커 선택, 실시간성 가격/오더북/캔들 차트
- 레버리지 설정
- 지정가 주문과 limit 자동 chase 작업
- 현재 포지션, 오픈 오더, 실행 로그
- 원버튼 긴급 포지션 정리: 오픈 오더 취소 후 현재 포지션을 시장가 reduce 방향으로 정리
- 거래소 어댑터 인터페이스 분리: `src/exchanges`에 Bybit, OKX 등을 추가 가능

## 실행

```bash
node src/server.js
```

Codex 번들 Node를 사용할 때는:

```powershell
& 'C:\Users\zinfr\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' src/server.js
```

또는 PowerShell에서:

```powershell
.\start-terminal.ps1
```

브라우저에서 `http://127.0.0.1:8787`을 엽니다.

## 실행 파일

```powershell
.\build-launcher.ps1
.\dist\SemiAutoCexTerminal.exe
```

`SemiAutoCexTerminal.exe`는 로컬 서버를 실행하고 브라우저를 엽니다. 런처 창을 닫으면 로컬 서버도 같이 종료됩니다.

## 세션과 API 키

세션은 `.env.session`에서만 관리합니다. 이 파일은 Git ignore 대상이며, UI에는 API 키나 모드 변경 폼을 두지 않습니다. 값을 바꾼 뒤 서버를 재시작하면 반영됩니다.

```env
SESSION_EXCHANGE_ID=binance-usdm
TRADING_MODE=dry-run
BINANCE_API_KEY=
BINANCE_API_SECRET=
BINANCE_ACCOUNT_MODE=portfolio
BINANCE_POSITION_MODE=hedge
BINANCE_MARGIN_MODE=cross
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
CHASE_MIN_UPDATE_MS=500
CHASE_UPDATE_MS=500
CHASE_MAX_REPLACES=240
CHASE_RATE_LIMIT_10S_ORDERS=300
CHASE_RATE_LIMIT_SAFETY=0.7
ACCOUNT_REFRESH_MS=1000
ACCOUNT_STREAM_ENABLED=true
ACCOUNT_STREAM_KEEPALIVE_MS=3000000
ACCOUNT_STREAM_RECONNECT_MS=5000
CHART_VWAP_ENABLED=true
CHART_VWAP_PERIOD=80
```

`.env`는 포트 같은 공통 런타임 설정용으로만 두고, 거래 모드와 API 키는 `.env.session`에 둡니다.

실거래 `live`는 UI에서 별도 문구 입력이 필요합니다. 운영 전에는 Binance Futures Testnet에서 먼저 확인하세요.

## Binance 문서 기준

구현 기준은 Binance 공식 USD-M Futures REST 문서입니다.

- Exchange info: `GET /fapi/v1/exchangeInfo`
- Klines: `GET /fapi/v1/klines`
- Price ticker: `GET /fapi/v2/ticker/price`
- New order: `POST /fapi/v1/order`
- Test order: `POST /fapi/v1/order/test`
- Leverage: `POST /fapi/v1/leverage`
- Position risk V3: `GET /fapi/v3/positionRisk`
- Open orders: `GET /fapi/v1/openOrders`
- Cancel all open orders: `DELETE /fapi/v1/allOpenOrders`

## 다른 CEX 추가

1. `src/exchanges/types.js`의 메서드 계약을 맞춥니다.
2. 새 어댑터 파일을 `src/exchanges/<exchange>.js`로 추가합니다.
3. `src/exchanges/registry.js`에 등록합니다.
4. UI의 거래소 선택 목록에 노출합니다.

## 안전 메모

이 앱은 매매 판단을 대신하지 않습니다. 네트워크 지연, API 제한, 부분 체결, Hedge Mode 설정, 거래소 장애로 인해 주문 상태가 UI와 다를 수 있습니다. 큰 금액을 넣기 전에 testnet과 소액으로 반드시 검증하세요.
