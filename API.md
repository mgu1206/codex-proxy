# Codex Proxy REST API

OpenAI Codex API에 ChatGPT OAuth 토큰을 자동 주입하는 프록시 서버.
세션 기반 대화 관리, 자동 컨텍스트 압축, SSE 스트리밍을 지원합니다.

- **Base URL**: `http://localhost:3456` (기본)
- **Runtime**: Bun + Hono
- **Data**: `~/.codex-proxy/sessions.db` (SQLite)

---

## 인증

`GET /` 를 제외한 모든 요청에 admin key가 필요합니다.

**헤더 (둘 중 하나 사용)**:

```
X-Admin-Key: <admin-key>
Authorization: Bearer <admin-key>
```

인증 실패 시:

```json
// 401
{ "error": "Unauthorized. Provide valid admin key via X-Admin-Key header." }

// 503 (admin key 미설정)
{ "error": "Server not initialized. Set admin key first." }
```

---

## 엔드포인트

### Health Check

#### `GET /`

서버 상태 및 엔드포인트 목록 반환. 인증 불필요.

**Response** `200`:

```json
{
  "name": "codex-proxy",
  "version": "0.2.0",
  "endpoints": {
    "auth": ["POST /auth/login", "POST /auth/device", "GET /auth/status", "DELETE /auth/logout"],
    "sessions": ["POST /sessions", "GET /sessions", "GET /sessions/:id", "PATCH /sessions/:id", "DELETE /sessions/:id", "POST /sessions/:id/chat"],
    "proxy": ["POST /v1/responses", "POST /v1/chat/completions"]
  }
}
```

---

### Admin (localhost 전용)

admin key 설정 및 변경은 **localhost에서만** 가능합니다. 원격 요청 시 `403`을 반환합니다.

#### `POST /admin/setup`

최초 admin key 설정. admin key가 이미 설정된 경우 `409`를 반환합니다.

**Request Body**:

```json
{ "key": "my-secret-key" }
```

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `key` | string | Y | 8자 이상 |

**Response** `200`:

```json
{ "status": "ok", "message": "Admin key configured." }
```

**Errors**:

| 코드 | 설명 |
|------|------|
| `400` | key가 8자 미만 |
| `403` | localhost가 아닌 원격 요청 |
| `409` | admin key 이미 설정됨 |

---

#### `PUT /admin/key`

admin key를 변경합니다. 현재 key를 확인한 뒤 새 key로 교체합니다.

**Request Body**:

```json
{
  "current_key": "old-key-here",
  "new_key": "new-secret-key"
}
```

| 필드 | 타입 | 필수 | 설명 |
|------|------|------|------|
| `current_key` | string | Y | 현재 admin key |
| `new_key` | string | Y | 새 admin key (8자 이상) |

**Response** `200`:

```json
{ "status": "ok", "message": "Admin key updated." }
```

**Errors**:

| 코드 | 설명 |
|------|------|
| `400` | admin key 미설정 또는 new_key가 8자 미만 |
| `401` | current_key가 일치하지 않음 |
| `403` | localhost가 아닌 원격 요청 |

---

### Auth (OAuth)

ChatGPT 계정으로 OAuth 인증을 수행합니다. 인증된 토큰은 Codex API 호출 시 자동 주입됩니다.

#### `POST /auth/login`

브라우저 기반 OAuth 인증을 시작합니다.

**Response** `200`:

```json
{
  "status": "pending",
  "message": "Open this URL in your browser:",
  "url": "https://auth0.openai.com/authorize?..."
}
```

이미 인증된 경우:

```json
{ "status": "already_authenticated", "expires": 1710000000000 }
```

---

#### `POST /auth/device`

Device Code 방식 인증을 시작합니다. 서버 환경에 권장됩니다.

**Response** `200`:

```json
{
  "status": "pending",
  "message": "Visit the URL and enter the code:",
  "url": "https://auth0.openai.com/activate",
  "code": "ABCD-EFGH"
}
```

---

#### `POST /auth/headless`

Headless PKCE 방식 인증을 시작합니다. 브라우저를 열 수 없는 환경용.

**Response** `200`:

```json
{
  "status": "pending",
  "method": "headless",
  "message": "Open this URL, authenticate, then paste the callback URL back.",
  "authUrl": "https://auth0.openai.com/authorize?...",
  "redirectUri": "http://localhost:1455/auth/callback"
}
```

---

#### `POST /auth/headless/callback`

Headless 인증의 콜백 URL을 제출합니다.

**Request Body**:

```json
{ "url": "http://localhost:1455/auth/callback?code=...&state=..." }
```

**Response** `200`:

```json
{ "status": "authenticated", "accountId": "user-xxx" }
```

---

#### `GET /auth/status`

현재 OAuth 인증 상태를 확인합니다.

**Response** `200`:

```json
{
  "authenticated": true,
  "expires": 1710000000000,
  "expired": false,
  "accountId": "user-xxx"
}
```

미인증:

```json
{ "authenticated": false }
```

---

#### `DELETE /auth/logout`

저장된 OAuth 토큰을 삭제합니다.

**Response** `200`:

```json
{ "status": "logged_out" }
```

---

### Models

#### `GET /models`

사용 가능한 모델 목록과 컨텍스트 윈도우 크기를 반환합니다.

**Response** `200`:

```json
[
  { "id": "gpt-4o", "context_window": 128000 },
  { "id": "gpt-5.4", "context_window": 128000 },
  { "id": "gpt-5.3-codex", "context_window": 400000 },
  { "id": "gpt-5.3-codex-spark", "context_window": 400000 },
  { "id": "gpt-5.2-codex", "context_window": 400000 },
  { "id": "gpt-5.1-codex", "context_window": 400000 }
]
```

---

### One-shot Chat

#### `POST /chat`

세션을 만들지 않고 일회성으로 메시지를 보내고 응답을 받습니다.

**Request Body**:

```json
{
  "content": "Hello!",
  "model": "gpt-4o",
  "instructions": "You are a helpful assistant.",
  "stream": false,
  "temperature": 0.7,
  "max_output_tokens": 4096
}
```

| 필드 | 타입 | 필수 | 기본값 | 설명 |
|------|------|------|--------|------|
| `content` | string | Y | - | 사용자 메시지 |
| `model` | string | N | `"gpt-4o"` | 사용할 모델 |
| `instructions` | string | N | `"You are a helpful assistant."` | 시스템 프롬프트 |
| `stream` | boolean | N | `false` | SSE 스트리밍 여부 |

Codex 옵션도 함께 전달할 수 있습니다 (아래 [Codex 옵션](#codex-옵션) 참고).

**Response (non-streaming)** `200`:

```json
{ "message": "AI의 응답 텍스트" }
```

**Response (streaming)**: `text/event-stream`

**Errors**:

| 코드 | 설명 |
|------|------|
| `400` | `content` 누락 |
| `502` | Codex API 에러 |

---

### Sessions

세션 기반 대화를 관리합니다. 각 세션은 독립적인 대화 히스토리, 모델 설정, 시스템 프롬프트를 가집니다.

#### `POST /sessions`

새 세션을 생성합니다.

**Request Body** (모두 선택):

```json
{
  "title": "코딩 도우미",
  "model": "gpt-4o",
  "system_prompt": "You are a helpful coding assistant."
}
```

| 필드 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `title` | string | `null` | 세션 제목 |
| `model` | string | `"gpt-4o"` | 사용할 모델 |
| `system_prompt` | string | `null` | 시스템 프롬프트 |

**지원 모델**:
`gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `gpt-4`, `gpt-3.5-turbo`, `gpt-5.3-codex`, `gpt-5.2-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-mini`, `gpt-5.1-codex-max`

**Response** `201`:

```json
{
  "id": "019577a0-0000-7000-8000-000000000000",
  "title": "코딩 도우미",
  "model": "gpt-4o",
  "system_prompt": "You are a helpful coding assistant.",
  "summary": null,
  "created_at": 1710000000000,
  "updated_at": 1710000000000
}
```

---

#### `GET /sessions`

모든 세션을 `updated_at` 내림차순으로 반환합니다.

**Response** `200`:

```json
[
  {
    "id": "019577a0-...",
    "title": "코딩 도우미",
    "model": "gpt-4o",
    "system_prompt": "...",
    "summary": null,
    "created_at": 1710000000000,
    "updated_at": 1710000000000
  }
]
```

---

#### `GET /sessions/:id`

세션 상세 정보와 전체 메시지 히스토리를 반환합니다.

**Response** `200`:

```json
{
  "id": "019577a0-...",
  "title": "코딩 도우미",
  "model": "gpt-4o",
  "system_prompt": "...",
  "summary": null,
  "created_at": 1710000000000,
  "updated_at": 1710000000000,
  "messages": [
    {
      "id": "019577a1-...",
      "session_id": "019577a0-...",
      "role": "user",
      "content": "Hello!",
      "created_at": 1710000001000
    },
    {
      "id": "019577a2-...",
      "session_id": "019577a0-...",
      "role": "assistant",
      "content": "안녕하세요! 무엇을 도와드릴까요?",
      "created_at": 1710000002000
    }
  ]
}
```

**Errors**: `404` 세션 없음

---

#### `PATCH /sessions/:id`

세션의 제목, 모델, 시스템 프롬프트를 수정합니다. 전달된 필드만 업데이트됩니다.

**Request Body** (모두 선택):

```json
{
  "title": "새 제목",
  "model": "gpt-5.3-codex",
  "system_prompt": "Updated instructions."
}
```

**Response** `200`: 업데이트된 세션 객체

**Errors**: `404` 세션 없음

---

#### `DELETE /sessions/:id`

세션과 관련 메시지를 모두 삭제합니다.

**Response** `200`:

```json
{ "status": "deleted" }
```

**Errors**: `404` 세션 없음

---

#### `POST /sessions/:id/chat`

세션에 메시지를 전송하고 AI 응답을 받습니다.

내부적으로 Codex API에 항상 스트리밍으로 요청합니다. `stream: false`인 경우 전체 응답을 수집한 뒤 JSON으로 반환합니다.

**Request Body**:

```json
{
  "content": "파이썬으로 피보나치 함수 만들어줘",
  "stream": false,
  "temperature": 0.7
}
```

| 필드 | 타입 | 필수 | 기본값 | 설명 |
|------|------|------|--------|------|
| `content` | string | Y | - | 사용자 메시지 |
| `stream` | boolean | N | `false` | SSE 스트리밍 여부 |

Codex 옵션도 함께 전달할 수 있습니다 (아래 [Codex 옵션](#codex-옵션) 참고).

**Response (non-streaming)** `200`:

```json
{
  "session_id": "019577a0-...",
  "message": "AI의 응답 텍스트",
  "compacted": false
}
```

**Response (streaming)**: `text/event-stream`

SSE 형식으로 Codex API 스트림을 그대로 전달합니다.
자동 컴팩션이 발생한 경우 `X-Compacted: true` 헤더가 포함됩니다.

**Errors**:

| 코드 | 설명 |
|------|------|
| `400` | `content` 누락 |
| `404` | 세션 없음 |
| `502` | Codex API 에러 (상세 내용은 `detail` 필드) |

---

### Raw Proxy

세션 관리 없이 요청을 Codex API로 직접 전달합니다. OAuth 토큰만 자동 주입됩니다.

#### `POST /v1/responses`

Codex responses API로 프록시합니다.

**Request Body**: Codex API 요청 형식 그대로 전달

```json
{
  "model": "gpt-4o",
  "instructions": "You are a helpful assistant.",
  "input": [
    { "role": "user", "content": "Hello" }
  ],
  "stream": true,
  "store": false
}
```

> **주의**: Codex API는 `stream: true`와 `store: false`를 요구합니다.

**Response**: Codex API 응답을 그대로 반환 (스트리밍 시 SSE)

---

#### `POST /v1/chat/completions`

Chat completions 형식의 요청도 Codex responses 엔드포인트로 전달됩니다.

---

#### `* /v1/*`

기타 경로는 `https://chatgpt.com/backend-api/codex/...`로 매핑되어 전달됩니다.

---

## Codex 옵션

`POST /chat` 및 `POST /sessions/:id/chat`의 body에 아래 옵션을 추가로 전달할 수 있습니다. Codex responses API에 그대로 전달됩니다.

| 필드 | 타입 | 설명 |
|------|------|------|
| `temperature` | number (0~2) | 응답의 무작위성. 낮을수록 결정적 |
| `top_p` | number (0~1) | Nucleus sampling. temperature와 함께 사용 비권장 |
| `max_output_tokens` | number | 최대 출력 토큰 수 |
| `truncation` | `"auto"` \| `"disabled"` | 입력이 컨텍스트를 초과할 때 자동 잘림 여부 |
| `tool_choice` | `"auto"` \| `"none"` \| `"required"` | 도구 호출 방식 |
| `tools` | array | 사용할 도구 정의 배열 |
| `parallel_tool_calls` | boolean | 병렬 도구 호출 허용 여부 |
| `reasoning` | object | 추론 설정 |
| `reasoning.effort` | `"low"` \| `"medium"` \| `"high"` | 추론 노력 수준 |
| `reasoning.summary` | `"auto"` \| `"concise"` \| `"detailed"` \| `"disabled"` | 추론 요약 방식 |
| `metadata` | object | 요청에 첨부할 키-값 메타데이터 |

**예시**:

```json
{
  "content": "복잡한 알고리즘 설명해줘",
  "stream": false,
  "temperature": 0.3,
  "max_output_tokens": 8192,
  "reasoning": { "effort": "high", "summary": "concise" }
}
```

---

## 자동 컴팩션

세션의 토큰 사용량이 모델 컨텍스트 한도의 **90%**에 도달하면 자동으로 오래된 메시지를 요약합니다.

- 최근 6개 메시지는 유지
- 그 이전 메시지들을 LLM으로 요약하여 `summary` 필드에 저장
- 요약된 원본 메시지는 DB에서 삭제
- API 호출 시 `system_prompt` → `summary` → 최근 메시지 순으로 구성

| 모델 | 컨텍스트 한도 |
|------|--------------|
| `gpt-4o` / `gpt-4o-mini` / `gpt-4-turbo` / `gpt-5.4` | 128K |
| `gpt-4` | 8K |
| `gpt-3.5-turbo` | 16K |
| `gpt-5.3-codex` / `gpt-5.3-codex-spark` | 400K |
| `gpt-5.2-codex` / `gpt-5.1-codex` / `gpt-5.1-codex-mini` / `gpt-5.1-codex-max` | 400K |

> 전체 목록은 `GET /models`로 확인할 수 있습니다.

---

## 사용 예시

### 빠른 시작

```bash
# 1. 서버 시작
bun run serve

# 2. 세션 생성
curl -s -X POST http://localhost:3456/sessions \
  -H "X-Admin-Key: mykey123" \
  -H "Content-Type: application/json" \
  -d '{"title": "Test", "model": "gpt-4o"}' | jq .

# 3. 채팅 (session id를 넣어주세요)
curl -s -X POST http://localhost:3456/sessions/<id>/chat \
  -H "X-Admin-Key: mykey123" \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello!"}' | jq .

# 4. 스트리밍 채팅
curl -N -X POST http://localhost:3456/sessions/<id>/chat \
  -H "X-Admin-Key: mykey123" \
  -H "Content-Type: application/json" \
  -d '{"content": "Tell me a story", "stream": true}'

# 5. Raw 프록시
curl -s -X POST http://localhost:3456/v1/responses \
  -H "X-Admin-Key: mykey123" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "instructions": "Be concise.",
    "input": [{"role": "user", "content": "Hi"}],
    "stream": true,
    "store": false
  }'
```

### 에러 응답 형식

모든 에러는 다음 형식을 따릅니다:

```json
{ "error": "에러 메시지" }
```

Codex API 에러의 경우:

```json
{
  "error": "Codex API error",
  "status": 400,
  "detail": "{\"detail\":\"...\"}"
}
```
