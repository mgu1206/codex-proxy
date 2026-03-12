/**
 * Token storage + refresh lock + admin key management
 */
import { readFile, writeFile, mkdir, rename } from "fs/promises"
import { DATA_DIR, AUTH_FILE, ADMIN_KEY_FILE } from "./paths"

export interface OAuthToken {
  type: "oauth"
  refresh: string
  access: string
  expires: number
  accountId?: string
}

/** Buffer before actual expiry to avoid mid-request expiration */
const TOKEN_EXPIRY_BUFFER_MS = 30_000

async function ensureDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 })
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf-8"))
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await ensureDir()
  const tmp = path + ".tmp"
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  await rename(tmp, path)
}

// ─── Admin Key ───

export async function getAdminKey(): Promise<string | null> {
  try {
    const key = (await readFile(ADMIN_KEY_FILE, "utf-8")).trim()
    return key || null
  } catch {
    return null
  }
}

export async function setAdminKey(key: string): Promise<void> {
  await ensureDir()
  const tmp = ADMIN_KEY_FILE + ".tmp"
  await writeFile(tmp, key, { mode: 0o600 })
  await rename(tmp, ADMIN_KEY_FILE)
}

export async function removeAdminKey(): Promise<void> {
  try {
    const { unlink } = await import("fs/promises")
    await unlink(ADMIN_KEY_FILE)
  } catch {}
}

export function validateAdminKey(provided: string | null | undefined, stored: string): boolean {
  if (!provided || !stored) return false
  // Constant-time comparison to prevent timing attacks
  if (provided.length !== stored.length) return false
  let result = 0
  for (let i = 0; i < provided.length; i++) {
    result |= provided.charCodeAt(i) ^ stored.charCodeAt(i)
  }
  return result === 0
}

// ─── OAuth Token Storage ───

export async function getToken(): Promise<OAuthToken | null> {
  try {
    const data = await readJson<Record<string, OAuthToken>>(AUTH_FILE)
    return data.openai ?? null
  } catch {
    return null
  }
}

export async function setToken(token: OAuthToken): Promise<void> {
  let data: Record<string, OAuthToken> = {}
  try {
    data = await readJson<Record<string, OAuthToken>>(AUTH_FILE)
  } catch {}
  data.openai = token
  await writeJsonAtomic(AUTH_FILE, data)
}

export async function removeToken(): Promise<void> {
  let data: Record<string, unknown> = {}
  try {
    data = await readJson<Record<string, unknown>>(AUTH_FILE)
  } catch {}
  delete data.openai
  await writeJsonAtomic(AUTH_FILE, data)
}

// ─── Token Refresh Lock ───

let refreshPromise: Promise<OAuthToken> | null = null

/**
 * Ensure token is valid with concurrent refresh protection.
 * Multiple callers will share the same refresh promise.
 */
export async function ensureValidToken(): Promise<OAuthToken> {
  const token = await getToken()
  if (!token) {
    throw new Error("Not authenticated. POST /auth/login first.")
  }

  if (token.access && token.expires > Date.now() + TOKEN_EXPIRY_BUFFER_MS) {
    return token
  }

  if (refreshPromise) {
    return refreshPromise
  }

  refreshPromise = doRefresh(token)
  try {
    return await refreshPromise
  } finally {
    refreshPromise = null
  }
}

async function doRefresh(token: OAuthToken): Promise<OAuthToken> {
  console.log("[auth] refreshing expired token...")
  const { refreshAccessToken } = await import("./oauth")
  const refreshed = await refreshAccessToken(token.refresh)
  const accountId = token.accountId || extractAccountIdFromJwt(refreshed.access_token)

  const updated: OAuthToken = {
    type: "oauth",
    refresh: refreshed.refresh_token,
    access: refreshed.access_token,
    expires: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
    ...(accountId && { accountId }),
  }
  await setToken(updated)
  return updated
}

function extractAccountIdFromJwt(jwt: string): string | undefined {
  try {
    const claims = JSON.parse(
      Buffer.from(jwt.split(".")[1], "base64url").toString(),
    )
    return (
      claims.chatgpt_account_id ||
      claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
      claims.organizations?.[0]?.id
    )
  } catch {
    return undefined
  }
}
