# Orderly EVM API 참고 (링크 + 에러 코드)

이 터미널의 거래소 어댑터(`src/exchanges/mememax-orderly.js`)와 지갑 온보딩 플로우
(`src/server.js`)는 Orderly EVM API를 기준으로 구현돼 있습니다. 외부 문서 링크와 에러
코드를 한곳에 모아 둡니다.

> 확인 시점: 2026-06-21. Orderly가 문서를 개편하면 URL이 바뀔 수 있으니 깨진 링크는
> 문서 인덱스 `https://orderly.network/docs/llms.txt`에서 다시 찾으세요.

## 공식 문서 링크

| 항목 | URL |
|------|-----|
| 문서 인덱스 (llms.txt) | https://orderly.network/docs/llms.txt |
| EVM API 소개 | https://orderly.network/docs/build-on-omnichain/evm-api/introduction |
| API 인증 (orderly-key/secret 서명) | https://orderly.network/docs/build-on-omnichain/evm-api/api-authentication |
| 지갑 인증 (온보딩 흐름) | https://orderly.network/docs/build-on-evm/user-flows/wallet-authentication |
| **에러 코드** | https://orderly.network/docs/build-on-omnichain/error-codes |
| Register Account (POST /v1/register_account) | https://orderly.network/docs/build-on-omnichain/evm-api/restful-api/public/register-account |
| Add Orderly Key (POST /v1/orderly_key) | https://orderly.network/docs/build-on-omnichain/evm-api/restful-api/public/add-orderly-key |
| Get Orderly Key (GET /v1/get_orderly_key) | https://orderly.network/docs/build-on-omnichain/evm-api/restful-api/public/get-orderly-key |
| Create Order (POST /v1/order) | https://orderly.network/docs/build-on-omnichain/restful-api/private/create-order |
| WebSocket API 소개 | https://orderly.network/docs/build-on-omnichain/websocket-api/introduction |

베이스 URL:

- 메인넷: `https://api.orderly.org`
- 테스트넷: `https://testnet-api.orderly.org`

이 터미널은 실거래용이라 지갑 온보딩은 **항상 메인넷**으로만 키를 발급합니다
(`src/server.js`의 `orderlyOnboardingBaseUrl()`). 어댑터의 `testnet` 모드 자체는 별개로
남아 있습니다.

## 이 프로젝트가 사용하는 엔드포인트

| 코드 위치 | 메서드/경로 | 용도 |
|-----------|-------------|------|
| `prepareOrderlyWalletOnboarding` | `GET /v1/get_account` | 지갑 주소·broker로 기존 account_id 조회 |
| `prepareOrderlyWalletOnboarding` | `GET /v1/registration_nonce` | 계정 등록용 nonce 발급 |
| `completeOrderlyWalletOnboarding` | `POST /v1/register_account` | 신규 계정 등록 (IP당 10 req/s) |
| `completeOrderlyWalletOnboarding` | `POST /v1/orderly_key` | Orderly API 키 등록 |
| 어댑터 `request()` | `GET /v1/public/info`, `/v1/kline`, `/v1/orderbook/...` 등 | 공개 시세 |
| 어댑터 (signed) | `GET /v1/client/holding`, `/v1/positions`, `POST/PUT /v1/order` 등 | 잔고·포지션·주문 |

## 인증 / 타임스탬프 / 만료 규칙

서명 요청은 `orderly-key` + `orderly-secret`(ed25519)으로 서명하며 헤더에
`orderly-account-id`, `orderly-key`, `orderly-signature`, `orderly-timestamp`,
`Content-Type`를 포함합니다.

- **타임스탬프 단위는 밀리초(ms).** `orderly-timestamp` 헤더 및 온보딩 EIP-712 메시지의
  `timestamp` 모두 ms. → 코드의 `Date.now()` 사용과 일치.
- **요청 만료 윈도우는 300초(5분).** 서버 시간과 `orderly-timestamp` 차이가 300초 이상이면
  거부. → 온보딩 flow TTL 2분(`ORDERLY_WALLET_FLOW_TTL_MS`)이 이 안에 들어옴.
- **Orderly 키 만료(`expiration`) 최대 365일.** → 코드의
  `Math.min(365, …)`(`orderlyKeyExpirationDays`)과 일치. `expiration` 역시 ms 절대시각.

EIP-712 메시지 필드(이 코드가 서명·전송하는 형태):

- `Registration`: `brokerId`, `chainId`, `timestamp`, `registrationNonce`
- `AddOrderlyKey`: `brokerId`, `chainId`, `orderlyKey`, `scope`, `timestamp`, `expiration`
  - (Orderly 문서는 `chainType`, `tag`, `subAccountId`도 선택 필드로 정의하지만 이 터미널은
    사용하지 않습니다.)
- 도메인: `name="Orderly"`, `version="1"`, `verifyingContract=0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC`

## 에러 응답 포맷

실패 시 모든 API는 아래 형태로 응답합니다(`success: false`).

```json
{ "success": false, "code": -1005, "message": "order_price must be a positive number" }
```

어댑터/온보딩 코드는 `payload.success === false` 또는 `!response.ok`일 때
`ExchangeError(payload.message, { code: payload.code, status: response.status })`로 변환하고,
HTTP 429 또는 5xx는 `transient`로 표시해 재시도 대상으로 다룹니다.

## 에러 코드

| 코드 | HTTP | 의미 |
|------|------|------|
| -1000 | 500 | 처리 중 알 수 없는 오류 / 데이터 없음 |
| -1001 | 401 | API key 또는 secret 형식 오류 |
| -1002 | 401 | key/secret 무효·권한 부족·만료·폐기됨 |
| -1003 | 429 | 레이트 리밋 초과 |
| -1004 | 400 | 알 수 없는 파라미터 전송됨 |
| -1005 | 400 | 일부 파라미터 형식 오류 (예: 범위 0–1 위반, 가격/수량 형식) |
| -1006 | 400 | 서버에 데이터 없음 (예: 이미 취소된 주문을 취소) |
| -1007 | 409 | 데이터가 이미 존재하거나 중복 요청 |
| -1008 | 400 | 정산(settlement) 수량이 허용치 초과 |
| -1009 | 400 | 출금 불가 — 먼저 arrears 입금 필요 |
| -1011 | 400 | 내부 네트워크 오류로 주문 생성/취소 불가 |
| -1012 | 400 | 주문 거부 — 청산 중이거나 계정 오류 / 다른 청산 진행 중 |
| -1101 | 400 | 리스크 노출 과다 / 작업 후 마진 부족 |
| -1102 | 400 | 주문 가치(price × size)가 너무 작음 |
| -1103 | 400 | 가격이 `quote_min` 미만·`quote_max` 초과·tick size 불일치 |
| -1104 | 400 | 수량이 `base_min` 미만·`base_max` 초과·step/visible 수량 불일치 |
| -1105 | 400 | 가격이 mid price 대비 X% 초과/미만 |
| -1201 | 400 | Notional < 10000 / request ratio가 1이거나 지정값과 일치해야 함 |
| -1202 | 400 | 청산 불필요 또는 지정한 liquidation ID를 찾을 수 없음 |

> 전체 최신 목록은 위 "에러 코드" 페이지를 기준으로 합니다. 코드 번호가 같아도 컨텍스트에
> 따라 메시지가 다를 수 있으므로(`-1005`, `-1012` 등) 처리 분기는 가능하면 `code`와
> `message`를 함께 확인하세요.

## 출처

- [Error Codes](https://orderly.network/docs/build-on-omnichain/error-codes)
- [API Authentication](https://orderly.network/docs/build-on-omnichain/evm-api/api-authentication)
- [Add Orderly Key](https://orderly.network/docs/build-on-omnichain/evm-api/restful-api/public/add-orderly-key)
- [Register Account](https://orderly.network/docs/build-on-omnichain/evm-api/restful-api/public/register-account)
- [Wallet Authentication](https://orderly.network/docs/build-on-evm/user-flows/wallet-authentication)
- [EVM API Introduction](https://orderly.network/docs/build-on-omnichain/evm-api/introduction)
