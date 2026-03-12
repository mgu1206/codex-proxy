/**
 * Session management - SQLite based conversation history with auto-compaction
 */
import { Database } from "bun:sqlite"
import { mkdirSync } from "fs"
import { randomUUIDv7 } from "bun"
import { DATA_DIR, SESSIONS_DB } from "./paths"

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })

const db = new Database(SESSIONS_DB)
db.exec("PRAGMA journal_mode=WAL")
db.exec("PRAGMA foreign_keys=ON")

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    model TEXT NOT NULL DEFAULT 'gpt-4o',
    system_prompt TEXT,
    summary TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`)

// Migration: add summary column if missing
try {
  db.exec("ALTER TABLE sessions ADD COLUMN summary TEXT")
} catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  )
`)

// ─── Model Context Limits (tokens) ───

export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4": 8_192,
  "gpt-3.5-turbo": 16_385,
  "gpt-5.4": 128_000,
  "gpt-5.3-codex": 400_000,
  "gpt-5.3-codex-spark": 400_000,
  "gpt-5.2-codex": 400_000,
  "gpt-5.1-codex": 400_000,
  "gpt-5.1-codex-mini": 400_000,
  "gpt-5.1-codex-max": 400_000,
}
const DEFAULT_CONTEXT_LIMIT = 128_000
const COMPACT_THRESHOLD = 0.9 // 90%
const KEEP_RECENT_MESSAGES = 6 // keep last N messages after compaction

// ─── Types ───

export interface Session {
  id: string
  title: string | null
  model: string
  system_prompt: string | null
  summary: string | null
  created_at: number
  updated_at: number
}

export interface Message {
  id: string
  session_id: string
  role: "system" | "user" | "assistant"
  content: string
  created_at: number
}

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

// ─── Prepared Statements ───

const stmts = {
  createSession: db.prepare(
    "INSERT INTO sessions (id, title, model, system_prompt, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ),
  getSession: db.prepare("SELECT * FROM sessions WHERE id = ?"),
  listSessions: db.prepare(
    "SELECT * FROM sessions ORDER BY updated_at DESC",
  ),
  updateSession: db.prepare(
    "UPDATE sessions SET title = coalesce(?, title), model = coalesce(?, model), system_prompt = coalesce(?, system_prompt), updated_at = ? WHERE id = ?",
  ),
  setSummary: db.prepare(
    "UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?",
  ),
  deleteSession: db.prepare("DELETE FROM sessions WHERE id = ?"),
  addMessage: db.prepare(
    "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
  ),
  getMessages: db.prepare(
    "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC",
  ),
  deleteMessagesBefore: db.prepare(
    "DELETE FROM messages WHERE session_id = ? AND created_at <= ?",
  ),
  countMessages: db.prepare(
    "SELECT COUNT(*) as count FROM messages WHERE session_id = ?",
  ),
  touchSession: db.prepare(
    "UPDATE sessions SET updated_at = ? WHERE id = ?",
  ),
}

// ─── Session Operations ───

export function createSession(opts?: {
  title?: string
  model?: string
  system_prompt?: string
}): Session {
  const now = Date.now()
  const id = randomUUIDv7()
  const title: string | null = typeof opts?.title === "string" && opts.title ? opts.title : null
  const model: string = typeof opts?.model === "string" && opts.model ? opts.model : "gpt-4o"
  const systemPrompt: string | null = typeof opts?.system_prompt === "string" && opts.system_prompt ? opts.system_prompt : null
  stmts.createSession.run(id, title, model, systemPrompt, null, now, now)
  return stmts.getSession.get(id) as Session
}

export function getSession(id: string): Session | null {
  return (stmts.getSession.get(id) as Session) ?? null
}

export function listSessions(): Session[] {
  return stmts.listSessions.all() as Session[]
}

export function updateSession(
  id: string,
  opts: { title?: string; model?: string; system_prompt?: string },
): Session | null {
  stmts.updateSession.run(
    typeof opts.title === "string" ? opts.title : null,
    typeof opts.model === "string" ? opts.model : null,
    typeof opts.system_prompt === "string" ? opts.system_prompt : null,
    Date.now(),
    id,
  )
  return getSession(id)
}

export function deleteSession(id: string): boolean {
  return stmts.deleteSession.run(id).changes > 0
}

// ─── Message Operations ───

export function addMessage(
  sessionId: string,
  role: ChatMessage["role"],
  content: string,
): Message {
  const id = randomUUIDv7()
  const now = Date.now()
  stmts.addMessage.run(id, sessionId, role, content, now)
  stmts.touchSession.run(now, sessionId)
  return { id, session_id: sessionId, role, content, created_at: now }
}

export function getMessages(sessionId: string): Message[] {
  return stmts.getMessages.all(sessionId) as Message[]
}

/**
 * Build full messages array for API call.
 * Includes: system_prompt → compacted summary (if any) → conversation messages.
 */
export function buildMessagesForAPI(session: Session): ChatMessage[] {
  const msgs: ChatMessage[] = []

  if (session.system_prompt) {
    msgs.push({ role: "system", content: session.system_prompt })
  }

  if (session.summary) {
    msgs.push({
      role: "system",
      content: `[Previous conversation summary]\n${session.summary}`,
    })
  }

  const history = getMessages(session.id)
  for (const msg of history) {
    msgs.push({ role: msg.role as ChatMessage["role"], content: msg.content })
  }

  return msgs
}

// ─── Token Estimation ───

/**
 * Rough token count estimation.
 * ~4 chars per token for English, ~2 for CJK. Uses a blended ratio.
 */
function estimateTokens(text: string): number {
  let cjk = 0
  for (const ch of text) {
    if (ch.charCodeAt(0) > 0x2e80) cjk++
  }
  const nonCjk = text.length - cjk
  return Math.ceil(nonCjk / 4 + cjk / 1.5)
}

function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0
  for (const msg of messages) {
    total += estimateTokens(msg.content) + 4 // role + framing overhead
  }
  return total
}

function getContextLimit(model: string): number {
  return MODEL_CONTEXT_LIMITS[model] ?? DEFAULT_CONTEXT_LIMIT
}

// ─── Auto-Compaction ───

export interface CompactResult {
  compacted: boolean
  tokensBefore: number
  tokensAfter: number
  messagesRemoved: number
}

/**
 * Check if session needs compaction based on estimated token usage.
 */
export function needsCompaction(session: Session): {
  needed: boolean
  currentTokens: number
  limit: number
} {
  const messages = buildMessagesForAPI(session)
  const currentTokens = estimateMessagesTokens(messages)
  const limit = getContextLimit(session.model)
  return {
    needed: currentTokens >= limit * COMPACT_THRESHOLD,
    currentTokens,
    limit,
  }
}

/**
 * Build the summarization prompt from messages that will be compacted.
 */
export function buildCompactPrompt(
  messagesToSummarize: ChatMessage[],
  existingSummary: string | null,
): ChatMessage[] {
  const conversationText = messagesToSummarize
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n\n")

  const prompt = existingSummary
    ? `You are a conversation summarizer. Below is a previous summary followed by new conversation that needs to be incorporated.

Previous summary:
${existingSummary}

New conversation to incorporate:
${conversationText}

Create a comprehensive, updated summary that captures all key information, decisions, context, code snippets, and important details from both the previous summary and the new conversation. The summary should preserve enough context so the conversation can continue naturally. Write in the same language as the conversation. Be thorough but concise.`
    : `You are a conversation summarizer. Below is a conversation that needs to be summarized.

Conversation:
${conversationText}

Create a comprehensive summary that captures all key information, decisions, context, code snippets, and important details. The summary should preserve enough context so the conversation can continue naturally. Write in the same language as the conversation. Be thorough but concise.`

  return [{ role: "user", content: prompt }]
}

/**
 * Execute compaction: summarize old messages, keep recent ones.
 * Returns the summary text to be sent to LLM by the caller.
 *
 * Flow:
 *   1. Determine which messages to summarize (all except recent N)
 *   2. Return prompt for caller to send to LLM
 *   3. Caller sends to LLM, gets summary
 *   4. Caller calls applyCompaction() with the summary
 */
export function prepareCompaction(session: Session): {
  prompt: ChatMessage[]
  messagesToRemoveBefore: number // created_at cutoff
  messagesRemoved: number
  tokensBefore: number
} | null {
  const allMessages = getMessages(session.id)

  if (allMessages.length <= KEEP_RECENT_MESSAGES) {
    return null // not enough messages to compact
  }

  const splitIdx = allMessages.length - KEEP_RECENT_MESSAGES
  const oldMessages: ChatMessage[] = allMessages.slice(0, splitIdx).map((m) => ({
    role: m.role as ChatMessage["role"],
    content: m.content,
  }))

  const cutoffTimestamp = allMessages[splitIdx - 1].created_at
  const apiMessages = buildMessagesForAPI(session)
  const tokensBefore = estimateMessagesTokens(apiMessages)

  const prompt = buildCompactPrompt(oldMessages, session.summary)

  return {
    prompt,
    messagesToRemoveBefore: cutoffTimestamp,
    messagesRemoved: splitIdx,
    tokensBefore,
  }
}

/**
 * Apply compaction result: save summary, delete old messages.
 */
export function applyCompaction(
  sessionId: string,
  summary: string,
  messagesToRemoveBefore: number,
): void {
  const now = Date.now()
  stmts.setSummary.run(summary, now, sessionId)
  stmts.deleteMessagesBefore.run(sessionId, messagesToRemoveBefore)
}
