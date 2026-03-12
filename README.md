# codex-proxy

[English](#english) | [한국어](#한국어)

---

## English

A local proxy server that auto-injects ChatGPT OAuth tokens into the OpenAI Codex API.

Enables using the Codex API as a REST API through ChatGPT Plus/Pro account OAuth authentication.

### Features

- **Auto OAuth Management** — Authenticate with your ChatGPT account, tokens auto-refresh
- **Session-based Conversations** — Conversation history management (SQLite), automatic context compression
- **One-shot Chat** — Quick query/response without sessions
- **Raw Proxy** — Direct Codex API calls via `/v1/*` routes
- **Streaming Support** — SSE streaming and non-streaming modes
- **Web Console** — Browser-based chat UI (Python)

### Requirements

- [Bun](https://bun.sh) v1.0+
- ChatGPT Plus or Pro account
- Python 3.x (for web console)

### Quick Start

```bash
# Install dependencies
bun install

# Start server (proxy + web console)
bun run serve

# Or start API only
bun run start
```

On first run, you'll be prompted to set an admin key and complete ChatGPT OAuth authentication.

```bash
# OAuth authentication (Device Code flow)
bun run auth:device
```

### Usage

#### One-shot Chat

```bash
curl -X POST http://localhost:3456/chat \
  -H "X-Admin-Key: <your-key>" \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello!", "model": "gpt-4o"}'
```

#### Session-based Conversation

```bash
# Create session
curl -X POST http://localhost:3456/sessions \
  -H "X-Admin-Key: <your-key>" \
  -H "Content-Type: application/json" \
  -d '{"title": "My Chat", "model": "gpt-4o"}'

# Chat
curl -X POST http://localhost:3456/sessions/<id>/chat \
  -H "X-Admin-Key: <your-key>" \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello!"}'
```

#### Raw Proxy

```bash
curl -X POST http://localhost:3456/v1/responses \
  -H "X-Admin-Key: <your-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "instructions": "Be concise.",
    "input": [{"role": "user", "content": "Hi"}],
    "stream": true,
    "store": false
  }'
```

### CLI Commands

```
codex-proxy serve              Start proxy + web console (background)
codex-proxy start              Start proxy only (background)
codex-proxy stop               Stop running proxy
codex-proxy status             Check proxy status
codex-proxy auth               OAuth authentication
codex-proxy auth --device      Device Code flow authentication
codex-proxy reset-key          Remove admin key
codex-proxy version            Show version
codex-proxy help               Show help
```

#### Options

```
--port <n>         Proxy port (default: 3456)
--web-port <n>     Web console port (default: 19880)
--hostname <host>  Bind address (default: 127.0.0.1)
--no-open          Disable auto browser open
--no-web           Disable web console
-f, --foreground   Run in foreground (no detach)
```

### API Documentation

See [API.md](./API.md) for the full REST API documentation.

#### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Health check |
| `GET` | `/models` | List supported models |
| `POST` | `/chat` | One-shot chat |
| `POST` | `/sessions` | Create session |
| `GET` | `/sessions` | List sessions |
| `GET` | `/sessions/:id` | Get session details |
| `PATCH` | `/sessions/:id` | Update session |
| `DELETE` | `/sessions/:id` | Delete session |
| `POST` | `/sessions/:id/chat` | Session chat |
| `POST` | `/v1/responses` | Raw proxy |
| `POST` | `/v1/chat/completions` | Raw proxy |

### Tech Stack

- **Runtime**: [Bun](https://bun.sh)
- **Framework**: [Hono](https://hono.dev)
- **Database**: SQLite (bun:sqlite)
- **Web Console**: Python + Flask

---

## 한국어

OpenAI Codex API에 ChatGPT OAuth 토큰을 자동 주입하는 로컬 프록시 서버.

ChatGPT Plus/Pro 계정의 OAuth 인증을 통해 Codex API를 REST API로 사용할 수 있게 해줍니다.

### 기능

- **OAuth 자동 관리** — ChatGPT 계정으로 인증, 토큰 자동 갱신
- **세션 기반 대화** — 대화 히스토리 관리 (SQLite), 자동 컨텍스트 압축
- **일회성 채팅** — 세션 없이 바로 질의/응답
- **Raw 프록시** — `/v1/*` 경로로 Codex API 직접 호출
- **스트리밍 지원** — SSE 스트리밍 및 논스트리밍 모드
- **웹 콘솔** — 브라우저 기반 채팅 UI (Python)

### 요구사항

- [Bun](https://bun.sh) v1.0+
- ChatGPT Plus 또는 Pro 계정
- Python 3.x (웹 콘솔 사용 시)

### 빠른 시작

```bash
# 의존성 설치
bun install

# 서버 시작 (프록시 + 웹 콘솔)
bun run serve

# 또는 API만 시작
bun run start
```

첫 실행 시 admin key 설정과 ChatGPT OAuth 인증을 진행합니다.

```bash
# OAuth 인증 (Device Code 방식)
bun run auth:device
```

### 사용법

#### 일회성 채팅

```bash
curl -X POST http://localhost:3456/chat \
  -H "X-Admin-Key: <your-key>" \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello!", "model": "gpt-4o"}'
```

#### 세션 기반 대화

```bash
# 세션 생성
curl -X POST http://localhost:3456/sessions \
  -H "X-Admin-Key: <your-key>" \
  -H "Content-Type: application/json" \
  -d '{"title": "My Chat", "model": "gpt-4o"}'

# 채팅
curl -X POST http://localhost:3456/sessions/<id>/chat \
  -H "X-Admin-Key: <your-key>" \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello!"}'
```

#### Raw 프록시

```bash
curl -X POST http://localhost:3456/v1/responses \
  -H "X-Admin-Key: <your-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "instructions": "Be concise.",
    "input": [{"role": "user", "content": "Hi"}],
    "stream": true,
    "store": false
  }'
```

### CLI 명령어

```
codex-proxy serve              프록시 + 웹 콘솔 시작 (백그라운드)
codex-proxy start              프록시만 시작 (백그라운드)
codex-proxy stop               실행 중인 프록시 종료
codex-proxy status             프록시 실행 상태 확인
codex-proxy auth               OAuth 인증
codex-proxy auth --device      Device Code 방식 인증
codex-proxy reset-key          Admin key 제거
codex-proxy version            버전 확인
codex-proxy help               도움말
```

#### 옵션

```
--port <n>         프록시 포트 (기본: 3456)
--web-port <n>     웹 콘솔 포트 (기본: 19880)
--hostname <host>  바인드 주소 (기본: 127.0.0.1)
--no-open          브라우저 자동 열기 비활성화
--no-web           웹 콘솔 비활성화
-f, --foreground   포그라운드에서 실행 (detach 안 함)
```

### API 문서

전체 REST API 문서는 [API.md](./API.md)를 참고하세요.

#### 엔드포인트

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Health check |
| `GET` | `/models` | 지원 모델 목록 |
| `POST` | `/chat` | 일회성 채팅 |
| `POST` | `/sessions` | 세션 생성 |
| `GET` | `/sessions` | 세션 목록 |
| `GET` | `/sessions/:id` | 세션 상세 |
| `PATCH` | `/sessions/:id` | 세션 수정 |
| `DELETE` | `/sessions/:id` | 세션 삭제 |
| `POST` | `/sessions/:id/chat` | 세션 채팅 |
| `POST` | `/v1/responses` | Raw 프록시 |
| `POST` | `/v1/chat/completions` | Raw 프록시 |

### 기술 스택

- **Runtime**: [Bun](https://bun.sh)
- **Framework**: [Hono](https://hono.dev)
- **Database**: SQLite (bun:sqlite)
- **Web Console**: Python + Flask

---

## License

MIT
