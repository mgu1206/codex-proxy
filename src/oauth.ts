/**
 * OpenAI Codex OAuth implementation
 * - Browser: PKCE Authorization Code Flow
 * - Headless: Device Code Flow
 */
import { setTimeout as sleep } from "node:timers/promises"
import { type OAuthToken, setToken } from "./auth"

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const OAUTH_PORT = 1455

// ─── PKCE Utilities ───

async function generatePKCE() {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const bytes = crypto.getRandomValues(new Uint8Array(43))
  const verifier = Array.from(bytes, (b) => chars[b % chars.length]).join("")
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  )
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
  return { verifier, challenge }
}

function generateState(): string {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

// ─── JWT Parsing ───

interface TokenResponse {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

function extractAccountId(tokens: TokenResponse): string | undefined {
  for (const raw of [tokens.id_token, tokens.access_token]) {
    if (!raw) continue
    const parts = raw.split(".")
    if (parts.length !== 3) continue
    try {
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString())
      const id =
        claims.chatgpt_account_id ||
        claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
        claims.organizations?.[0]?.id
      if (id) return id
    } catch {}
  }
  return undefined
}

// ─── Token Exchange & Refresh ───

async function exchangeCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CLIENT_ID,
      code_verifier: codeVerifier,
    }).toString(),
  })
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`)
  return res.json()
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<TokenResponse> {
  const res = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`)
  return res.json()
}

// ─── HTML Responses ───

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

const HTML_SUCCESS = `<!doctype html>
<html><head><title>Authorization Successful</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#111;color:#eee}
.c{text-align:center;padding:2rem}h1{color:#4ade80}</style></head>
<body><div class="c"><h1>Authorization Successful</h1><p>You can close this window.</p></div>
<script>setTimeout(()=>window.close(),2000)</script></body></html>`

const HTML_ERROR = (msg: string) => `<!doctype html>
<html><head><title>Authorization Failed</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#111;color:#eee}
.c{text-align:center;padding:2rem}h1{color:#f87171}.err{color:#fca5a5;font-family:monospace;margin-top:1rem;padding:1rem;background:#1c1917;border-radius:.5rem}</style></head>
<body><div class="c"><h1>Authorization Failed</h1><div class="err">${escapeHtml(msg)}</div></div></body></html>`

// ─── Browser OAuth (PKCE) ───

interface PendingOAuth {
  verifier: string
  state: string
  resolve: (tokens: TokenResponse) => void
  reject: (error: Error) => void
}

let oauthServer: ReturnType<typeof Bun.serve> | undefined
let pendingOAuth: PendingOAuth | undefined

function stopOAuthServer() {
  if (oauthServer) {
    oauthServer.stop()
    oauthServer = undefined
  }
}

export async function startBrowserAuth(): Promise<{
  url: string
  wait: () => Promise<OAuthToken>
}> {
  stopOAuthServer()

  const pkce = await generatePKCE()
  const state = generateState()
  const redirectUri = `http://localhost:${OAUTH_PORT}/auth/callback`

  const tokenPromise = new Promise<TokenResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingOAuth = undefined
      reject(new Error("OAuth timeout (5 min)"))
    }, 5 * 60 * 1000)

    pendingOAuth = {
      verifier: pkce.verifier,
      state,
      resolve: (t) => {
        clearTimeout(timeout)
        resolve(t)
      },
      reject: (e) => {
        clearTimeout(timeout)
        reject(e)
      },
    }
  })

  oauthServer = Bun.serve({
    port: OAUTH_PORT,
    fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === "/auth/callback") {
        const error = url.searchParams.get("error")
        const errorDesc = url.searchParams.get("error_description")
        const code = url.searchParams.get("code")
        const cbState = url.searchParams.get("state")

        if (error) {
          const msg = errorDesc || error
          pendingOAuth?.reject(new Error(msg))
          pendingOAuth = undefined
          return new Response(HTML_ERROR(msg), {
            headers: { "Content-Type": "text/html" },
          })
        }

        if (!code || !pendingOAuth || cbState !== pendingOAuth.state) {
          const msg = !code
            ? "Missing authorization code"
            : "Invalid state parameter"
          pendingOAuth?.reject(new Error(msg))
          pendingOAuth = undefined
          return new Response(HTML_ERROR(msg), {
            status: 400,
            headers: { "Content-Type": "text/html" },
          })
        }

        const current = pendingOAuth
        pendingOAuth = undefined

        exchangeCode(code, redirectUri, current.verifier)
          .then((t) => current.resolve(t))
          .catch((e) => current.reject(e))

        return new Response(HTML_SUCCESS, {
          headers: { "Content-Type": "text/html" },
        })
      }

      return new Response("Not Found", { status: 404 })
    },
  })

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "codex-proxy",
  })
  const authUrl = `${ISSUER}/oauth/authorize?${params}`

  return {
    url: authUrl,
    async wait() {
      try {
        const tokens = await tokenPromise
        const accountId = extractAccountId(tokens)
        const oauthToken: OAuthToken = {
          type: "oauth",
          refresh: tokens.refresh_token,
          access: tokens.access_token,
          expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
          ...(accountId && { accountId }),
        }
        await setToken(oauthToken)
        return oauthToken
      } finally {
        stopOAuthServer()
      }
    },
  }
}

// ─── Headless PKCE (paste callback URL) ───

interface HeadlessPKCE {
  authUrl: string
  redirectUri: string
  verifier: string
  state: string
}

let pendingHeadless: HeadlessPKCE | null = null
let pendingHeadlessTimer: ReturnType<typeof setTimeout> | null = null

const HEADLESS_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

function clearPendingHeadless() {
  pendingHeadless = null
  if (pendingHeadlessTimer) {
    clearTimeout(pendingHeadlessTimer)
    pendingHeadlessTimer = null
  }
}

/**
 * Start headless PKCE auth: returns an auth URL.
 * After user authenticates and gets redirected to a dead localhost URL,
 * they paste that URL back via submitCallbackUrl().
 * Times out after 5 minutes.
 */
export async function startHeadlessPKCE(): Promise<{
  authUrl: string
  redirectUri: string
}> {
  // Clear any existing pending session
  clearPendingHeadless()

  const pkce = await generatePKCE()
  const state = generateState()
  const redirectUri = `http://localhost:${OAUTH_PORT}/auth/callback`

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "codex-proxy",
  })

  pendingHeadless = {
    authUrl: `${ISSUER}/oauth/authorize?${params}`,
    redirectUri,
    verifier: pkce.verifier,
    state,
  }

  pendingHeadlessTimer = setTimeout(() => {
    console.log("[auth] headless PKCE session expired (5 min timeout)")
    pendingHeadless = null
    pendingHeadlessTimer = null
  }, HEADLESS_TIMEOUT_MS)

  return { authUrl: pendingHeadless.authUrl, redirectUri }
}

/**
 * Submit the callback URL the user copied from their browser.
 * Extracts code + state, validates, exchanges for tokens.
 */
export async function submitCallbackUrl(callbackUrl: string): Promise<OAuthToken> {
  if (!pendingHeadless) {
    throw new Error("No pending auth. Call /auth/headless first.")
  }

  const url = new URL(callbackUrl)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const error = url.searchParams.get("error")

  if (error) {
    const desc = url.searchParams.get("error_description") || error
    clearPendingHeadless()
    throw new Error(`OAuth error: ${desc}`)
  }

  if (!code) {
    clearPendingHeadless()
    throw new Error("No authorization code found in URL")
  }

  if (state !== pendingHeadless.state) {
    clearPendingHeadless()
    throw new Error("State mismatch - possible CSRF. Start auth again.")
  }

  const { verifier, redirectUri } = pendingHeadless
  clearPendingHeadless()

  const tokens = await exchangeCode(code, redirectUri, verifier)
  const accountId = extractAccountId(tokens)
  const oauthToken: OAuthToken = {
    type: "oauth",
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    ...(accountId && { accountId }),
  }
  await setToken(oauthToken)
  return oauthToken
}

// ─── Headless OAuth (Device Code Flow) ───

export async function startDeviceAuth(): Promise<{
  url: string
  userCode: string
  wait: () => Promise<OAuthToken>
}> {
  const res = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": `codex-proxy/0.2.0`,
    },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  })
  if (!res.ok) throw new Error("Failed to initiate device auth")

  const data = (await res.json()) as {
    device_auth_id: string
    user_code: string
    interval: string
  }
  const interval = Math.max(parseInt(data.interval) || 5, 1) * 1000 + 3000

  return {
    url: `${ISSUER}/codex/device`,
    userCode: data.user_code,
    async wait() {
      while (true) {
        const pollRes = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": `codex-proxy/0.2.0`,
          },
          body: JSON.stringify({
            device_auth_id: data.device_auth_id,
            user_code: data.user_code,
          }),
        })

        if (pollRes.ok) {
          const pollData = (await pollRes.json()) as {
            authorization_code: string
            code_verifier: string
          }

          const tokenRes = await fetch(`${ISSUER}/oauth/token`, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code: pollData.authorization_code,
              redirect_uri: `${ISSUER}/deviceauth/callback`,
              client_id: CLIENT_ID,
              code_verifier: pollData.code_verifier,
            }).toString(),
          })

          if (!tokenRes.ok) {
            throw new Error(`Token exchange failed: ${tokenRes.status}`)
          }

          const tokens: TokenResponse = await tokenRes.json()
          const accountId = extractAccountId(tokens)
          const oauthToken: OAuthToken = {
            type: "oauth",
            refresh: tokens.refresh_token,
            access: tokens.access_token,
            expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
            ...(accountId && { accountId }),
          }
          await setToken(oauthToken)
          return oauthToken
        }

        if (pollRes.status !== 403 && pollRes.status !== 404) {
          throw new Error(`Device auth failed: ${pollRes.status}`)
        }

        await sleep(interval)
      }
    },
  }
}
