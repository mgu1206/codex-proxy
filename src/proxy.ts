/**
 * Proxy handler - injects OAuth token and forwards to Codex API
 * Includes opencode-compatible headers and session tracking
 */
import type { Context } from "hono"
import { ensureValidToken, type OAuthToken } from "./auth"
import os from "os"
import type { ChatMessage } from "./session"

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const VERSION = "0.3.0"
const USER_AGENT = `codex-proxy/${VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`

/**
 * Build headers matching opencode's Codex API format.
 */
function buildCodexHeaders(token: OAuthToken, sessionId?: string): Headers {
  const headers = new Headers()
  headers.set("authorization", `Bearer ${token.access}`)
  headers.set("content-type", "application/json")
  headers.set("originator", "codex-proxy")
  headers.set("user-agent", USER_AGENT)
  if (sessionId) {
    headers.set("session_id", sessionId)
  }
  if (token.accountId) {
    headers.set("chatgpt-account-id", token.accountId)
  }
  return headers
}

/**
 * Extra options forwarded to the Codex responses API.
 */
export interface CodexOptions {
  temperature?: number
  top_p?: number
  max_output_tokens?: number
  truncation?: "auto" | "disabled"
  tool_choice?: "auto" | "none" | "required" | string
  tools?: Array<Record<string, unknown>>
  parallel_tool_calls?: boolean
  reasoning?: { effort?: "low" | "medium" | "high"; summary?: "auto" | "concise" | "detailed" | "disabled" }
  metadata?: Record<string, string>
}

/**
 * Send messages to Codex API. Used by session-based chat.
 */
export async function sendToCodex(
  messages: ChatMessage[],
  model: string,
  stream: boolean = false,
  sessionId?: string,
  options?: CodexOptions,
): Promise<Response> {
  const token = await ensureValidToken()
  const headers = buildCodexHeaders(token, sessionId)

  // Codex responses API expects { instructions, input } format, not { messages }
  // Extract system messages as instructions, rest as input items
  let instructions = ""
  const input: Array<{ role: string; content: string }> = []

  for (const msg of messages) {
    if (msg.role === "system") {
      instructions += (instructions ? "\n\n" : "") + msg.content
    } else {
      input.push({ role: msg.role, content: msg.content })
    }
  }

  return fetch(CODEX_API_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      instructions: instructions || "You are a helpful assistant.",
      input,
      stream: true,
      store: false,
      ...options,
    }),
  })
}

/**
 * Raw proxy handler - forwards request as-is with OAuth token injected.
 * For direct /v1/* passthrough without session management.
 */
export async function proxyHandler(c: Context) {
  const token = await ensureValidToken()

  const body = await c.req.raw.clone().arrayBuffer()

  const pathname = c.req.path
  let targetUrl: string

  if (
    pathname.startsWith("/v1/responses") ||
    pathname.startsWith("/v1/chat/completions")
  ) {
    targetUrl = CODEX_API_ENDPOINT
  } else {
    targetUrl = `https://chatgpt.com/backend-api/codex${pathname.replace("/v1", "")}`
  }

  const headers = buildCodexHeaders(token)

  // Forward non-auth headers from client
  for (const [key, value] of c.req.raw.headers.entries()) {
    const lower = key.toLowerCase()
    if (
      lower === "host" ||
      lower === "authorization" ||
      lower === "content-length" ||
      lower === "connection" ||
      lower === "user-agent" ||
      lower === "originator" ||
      lower === "chatgpt-account-id" ||
      lower === "session_id" ||
      lower === "x-admin-key"
    ) {
      continue
    }
    headers.set(key, value)
  }

  const upstream = await fetch(targetUrl, {
    method: c.req.method,
    headers,
    body: body.byteLength > 0 ? body : undefined,
  })

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type":
        upstream.headers.get("content-type") || "application/json",
      ...(upstream.headers.get("transfer-encoding") && {
        "transfer-encoding": upstream.headers.get("transfer-encoding")!,
      }),
    },
  })
}
