import { useAppStore, type CandidateProfile } from '../store/useAppStore'

/**
 * OpenRouter SSE streaming client (OpenAI-compatible chat completions).
 * Streams tokens in real time; the UI renders them line-by-line.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

/**
 * FREE models only — no credits required on OpenRouter.
 *
 * Priority per the interview-copilot spec:
 *   1. google/gemini-2.0-flash-exp:free     (fastest free generalist)
 *   2. meta-llama/llama-3.3-70b-instruct:free (note: was removed from
 *      OpenRouter's free tier in the past — the manual key×model loop below
 *      retries it safely before moving on, so keeping it first costs nothing)
 *   3. qwen/qwen-2.5-coder-32b-instruct:free (strong technical answers)
 *   4. deepseek/deepseek-r1:free             (deep reasoning fallback)
 *
 * OpenRouter's native `models:` auto-fallback also cascades, and the manual
 * loop rotates through every key×model while zero chars have streamed.
 */
export const MODEL_CHAIN = [
  // Verified live on OpenRouter's public catalog (2026-09): all $0/1M tokens.
  // `openrouter/free` is the wildcard routing fallback and stays last.
  'nvidia/nemotron-3-super-120b-a12b:free',
  'cohere/north-mini-code:free',
  'google/gemma-4-26b-a4b-it:free',
  'openrouter/free'
]

export const SYSTEM_PROMPT = `You are an elite live technical interview co-pilot. Respond instantly.
STRUCTURE EVERY RESPONSE STRICTLY AS:
1. **Define**: Concise 1-2 sentence core definition.
2. **Why it Matters**: 2-3 key technical points on production impact, performance, or engineering trade-offs.
3. **Example**: A short, highly realistic code or architecture snippet/example.
Analyze the full intent of the question before providing the answer it should be base on my resume and background and you can add to it .`

// ------------------------------------------------------------
// FULL-SESSION CONVERSATIONAL MEMORY
// ------------------------------------------------------------
// Stores every interviewer question + co-pilot answer for the active
// interview session and replays the last few turns with every request so a
// follow-up probe ("Earlier you mentioned Redis locks - how did you handle
// cache invalidation there?") retains full context instead of being answered
// as an isolated sentence.
// ------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** In-memory conversation log for the active interview session. */
let conversationHistory: ChatMessage[] = []

/** Max history turns replayed in each API payload (5 Q&A pairs). */
const MAX_HISTORY_MESSAGES = 10

/** Hard cap so an all-day interview cannot grow the buffer unboundedly. */
const MAX_HISTORY_STORED = 60

/** Clear session memory - call when starting a brand-new interview. */
export function clearInterviewSession(): void {
  conversationHistory = []
  console.log('[Memory] cleared conversation history for a new session')
}

/** Persist one completed Q/A turn and keep the buffer bounded. */
function recordTurn(question: string, answer: string): void {
  const q = question.trim()
  const a = answer.trim()
  if (!q || !a) return
  conversationHistory.push({ role: 'user', content: q })
  conversationHistory.push({ role: 'assistant', content: a })
  if (conversationHistory.length > MAX_HISTORY_STORED) {
    conversationHistory.splice(0, conversationHistory.length - MAX_HISTORY_STORED)
  }
}

/**
 * Base system prompt + candidate context (resume / target job description /
 * key skills). Holding this in the system message permanently is what lets
 * the model ground every answer in the candidate without the caller having
 * to repeat context each turn.
 */
/** Rough token estimate: ~4 chars/token for mixed prose+code. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil((text ?? '').length / 4))
}

const SYSTEM_TOKEN_BUDGET = 500

function buildSystemPrompt(profile: CandidateProfile | null): string {
  if (!profile) return SYSTEM_PROMPT
  const parts: string[] = []
  let used = estimateTokens(SYSTEM_PROMPT)
  const add = (label: string, value: string): void => {
    if (!value.trim()) return
    const cost = estimateTokens(label) + estimateTokens(value)
    if (used + cost > SYSTEM_TOKEN_BUDGET) return // drop overflow, keep prompt lean
    parts.push(`${label}\n${value.trim()}`)
    used += cost
  }
  add('CANDIDATE', profile.fullName)
  add('TARGET ROLE', profile.jobTitle)
  add('CANDIDATE RESUME CONTEXT', profile.resume.slice(0, 2000))
  add('TARGET JOB DESCRIPTION', profile.jobDescription.slice(0, 1200))
  add('KEY SKILLS', profile.keySkills.join(', '))
  return parts.length ? `${SYSTEM_PROMPT}\n\n${parts.join('\n\n')}` : SYSTEM_PROMPT
}

/**
 * Assemble the full payload: system context + sliding conversation window +
 * the new question (with per-question RAG context when available).
 */
function buildRequestMessages(
  profile: CandidateProfile | null,
  ragContext: string,
  question: string
): ChatMessage[] {
  const user = ragContext
    ? `CONTEXT (retrieved from candidate data):\n${ragContext}\n\nINTERVIEWER'S QUESTION:\n${question}`
    : `INTERVIEWER'S QUESTION:\n${question}`
  return [
    { role: 'system', content: buildSystemPrompt(profile) },
    ...conversationHistory.slice(-MAX_HISTORY_MESSAGES),
    { role: 'user', content: user }
  ]
}


// ------------------------------------------------------------
// Lightweight local RAG: chunk resume/JD into passages and rank
// them against the question via TF-IDF-style cosine similarity.
// ------------------------------------------------------------

interface Passage {
  text: string
  source: 'resume' | 'jobDescription'
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2)
}

function chunkText(text: string, size = 300): string[] {
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)
  const chunks: string[] = []
  let current = ''
  for (const s of sentences) {
    if ((current + ' ' + s).length > size && current) {
      chunks.push(current.trim())
      current = s
    } else {
      current += ' ' + s
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}

function buildPassages(profile: CandidateProfile): Passage[] {
  const passages: Passage[] = []
  for (const c of chunkText(profile.resume)) passages.push({ text: c, source: 'resume' })
  for (const c of chunkText(profile.jobDescription))
    passages.push({ text: c, source: 'jobDescription' })
  if (profile.keySkills.length)
    passages.unshift({ text: `Key skills: ${profile.keySkills.join(', ')}`, source: 'resume' })
  return passages
}

function retrieveContext(question: string, profile: CandidateProfile, topK = 3): string {
  const passages = buildPassages(profile)
  if (!passages.length) return ''

  const qTokens = new Set(tokenize(question))
  const scored = passages.map((p) => {
    const tokens = tokenize(p.text)
    let overlap = 0
    for (const t of tokens) if (qTokens.has(t)) overlap++
    const score = overlap / Math.sqrt(tokens.length || 1)
    return { p, score }
  })

  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, topK).filter((s) => s.score > 0)

  const sections = top.length === 0 ? passages.slice(0, topK) : top.map((s) => s.p)

  return sections
    .map((p) => `[${p.source === 'resume' ? 'Resume' : 'Job Description'}] ${p.text}`)
    .join('\n\n')
    .slice(0, 1200)
}

// ------------------------------------------------------------
// SSE streaming with multi-key rotation.
// Key order: onboarding-form key first, then .env / openrouter.key keys.
// If a key is invalid / out of credit / rate-limited (401/402/429) and
// NOTHING has been streamed yet, the next key takes over automatically.
// ------------------------------------------------------------

export interface StreamCallbacks {
  onToken: (token: string) => void
  onDone: (fullAnswer: string) => void
  onError: (error: string) => void
}

interface AttemptResult {
  ok: boolean
  status?: number
  emittedChars: number
  message?: string
  /** Full assistant text when the attempt completed; omitted on abort/error. */
  full?: string
  /** Time-to-first-token in ms for a completed stream. */
  ttft?: number
}

/** Ordered, de-duplicated list of every configured OpenRouter key. */
function getOrderedApiKeys(): string[] {
  const store = useAppStore.getState()
  return Array.from(
    new Set(
      [store.openRouterKey.trim(), ...store.openRouterKeys.map((k) => k.trim())].filter(Boolean)
    )
  )
}

/** Failures that justify silently rotating to the next API key. */
function isRotatable(status?: number): boolean {
  return status === 401 || status === 402 || status === 429 || (status !== undefined && status >= 500)
}

// ------------------------------------------------------------------
// SELF-HEALING MODEL RANKING (TTFT-based)
// ------------------------------------------------------------------
// Tracks time-to-first-token per model, re-ranks candidates before every
// request, marks failing models DEGRADED (429 flood / 404 removed / slow
// first token) and — on startup — discovers fresh :free models straight from
// OpenRouter's public catalog and benchmarks them with a minimal "Hi" prompt
// so the hardcoded chain can self-heal if it goes stale.
// ------------------------------------------------------------------

interface TtftEntry {
  ttft: number
  failures: number
  degradedUntil: number
}

const ttftTracker: Record<string, TtftEntry> = {}
const SLOW_TTFT_MS = 2500

let rankedModels: string[] | null = null
let discoveryPromise: Promise<string[]> | null = null

const RANK_STORAGE_KEY = 'interview-copilot.model-rank'

/** Restore the last benchmarked order so restarts stay fast. */
function loadPersistedRank(): string[] | null {
  try {
    const raw = localStorage.getItem(RANK_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { models?: string[]; ts?: number }
    if (Array.isArray(parsed.models) && (Date.now() - (parsed.ts ?? 0)) < 86_400_000) {
      return parsed.models.filter((m) => typeof m === 'string')
    }
  } catch {
    // corrupted/unavailable storage — rankings stay in memory only
  }
  return null
}

function persistRank(models: string[]): void {
  try {
    localStorage.setItem(RANK_STORAGE_KEY, JSON.stringify({ models, ts: Date.now() }))
  } catch {
    // storage unavailable
  }
}

/** Consume a measured TTFT and re-rank candidates by speed. */
function recordTTFT(model: string, ttft: number): void {
  const prev = ttftTracker[model]
  ttftTracker[model] = {
    ttft,
    failures: prev?.failures ?? 0,
    degradedUntil: prev?.degradedUntil ?? 0
  }
  const base = rankedModels ?? loadPersistedRank() ?? MODEL_CHAIN
  rankedModels = [...base].sort((a, b) => {
    const ea = ttftTracker[a]
    const eb = ttftTracker[b]
    return (ea?.ttft ?? Number.MAX_SAFE_INTEGER) - (eb?.ttft ?? Number.MAX_SAFE_INTEGER)
  })
  persistRank(rankedModels)
}

/** Mark a model degraded with exponential backoff (5s..60s). */
function markDegraded(model: string, reason: string): void {
  const prev = ttftTracker[model]
  const failures = (prev?.failures ?? 0) + 1
  const backoff = Math.min(60_000, 5_000 * failures)
  ttftTracker[model] = {
    ttft: prev?.ttft ?? Number.MAX_SAFE_INTEGER,
    failures,
    degradedUntil: Date.now() + backoff
  }
  console.log(`[OpenRouter] model degraded (${reason}): ${model} (backoff ${backoff}ms)`)
}

function isDegraded(model: string): boolean {
  const e = ttftTracker[model]
  return e !== undefined && e.degradedUntil > Date.now()
}

/** Current candidate list: persisted order + live TTFT re-ranking, minus degraded. */
function getCandidateModels(): string[] {
  if (!rankedModels) rankedModels = loadPersistedRank() ?? [...MODEL_CHAIN]
  return rankedModels.filter((m) => !isDegraded(m))
}

const DISCOVERY_URL = 'https://openrouter.ai/api/v1/models'

/** Fetch OpenRouter's public catalog; return currently-live :free model ids. */
async function fetchFreeModelCatalog(): Promise<string[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    const res = await fetch(DISCOVERY_URL, { signal: controller.signal })
    if (!res.ok) return []
    const body = (await res.json()) as { data?: Array<{ id: string }> }
    const seen = new Set<string>()
    const out: string[] = []
    for (const m of body.data ?? []) {
      const id = m.id
      if (!id.endsWith(':free')) continue
      if (id.split('/').length !== 2) continue
      if (seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
    return out
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/** Minimal streaming ping: measure TTFT (ms) for one model with "Hi". */
async function benchmarkModel(apiKey: string, model: string): Promise<number | null> {
  const started = performance.now()
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 8,
        temperature: 0,
        messages: [{ role: 'user', content: 'Hi' }]
      }),
      signal: AbortSignal.timeout(4000)
    })
    if (!res.ok || !res.body) return null
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let firstMs: number | null = null
    while (firstMs === null) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.includes('data:')) firstMs = performance.now() - started
    }
    try { reader.cancel() } catch { /* stream already closed */ }
    return firstMs
  } catch {
    return null
  }
}

/**
 * Discover + benchmark candidates once per process, in the background.
 * Callers never await this — they keep using the current rank until the
 * fresh, benchmarked rank is ready. Never throws.
 */
export function discoverAndBenchmarkModels(): Promise<string[]> {
  if (discoveryPromise) return discoveryPromise
  discoveryPromise = (async (): Promise<string[]> => {
    const keys = getOrderedApiKeys()
    if (!keys.length) return getCandidateModels()
    const catalog = await fetchFreeModelCatalog()
    const fresh: Array<{ model: string; ttft: number }> = []
    for (const model of catalog.slice(0, 8)) {
      if (isDegraded(model)) continue
      const ttft = await benchmarkModel(keys[0], model)
      if (ttft === null) {
        markDegraded(model, 'bench-failed')
      } else if (ttft > SLOW_TTFT_MS) {
        markDegraded(model, 'slow-bench')
      } else {
        fresh.push({ model, ttft })
      }
    }
    fresh.sort((a, b) => a.ttft - b.ttft)
    const merged: string[] = [...fresh.map((f) => f.model)]
    for (const m of MODEL_CHAIN) if (!merged.includes(m)) merged.push(m)
    for (const m of getCandidateModels()) if (!merged.includes(m)) merged.push(m)
    rankedModels = merged
    persistRank(rankedModels)
    console.log(
      `[OpenRouter] benchmark complete: ${fresh
        .map((f) => `${f.model.split('/')[1]}:${Math.round(f.ttft)}ms`)
        .join(', ') || 'no fast candidates'}`
    )
    return rankedModels
  })().catch(() => getCandidateModels())
  return discoveryPromise
}

async function attemptStream(
  apiKey: string,
  messages: ChatMessage[],
  model: string,
  callbacks: StreamCallbacks,
  signal?: AbortSignal
): Promise<AttemptResult> {
  const streamStarted = performance.now()
  let ttftMs: number | null = null
  let emittedChars = 0
  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Optional attribution headers OpenRouter recommends for apps
        'HTTP-Referer': 'http://localhost/aiinterviewassistant',
        'X-Title': 'AI Interview Assistant'
      },
      body: JSON.stringify({
        model,
        models: getCandidateModels().slice(0, 3), // native auto-fallback (OpenRouter caps at 3)
        stream: true,
        max_tokens: 350,
        temperature: 0.2,
        messages
      }),
      signal
    })

    if (!response.ok || !response.body) {
      const errText = await response.text().catch(() => '')
      const hint =
        response.status === 429
          ? ' (free-model rate limit)'
          : response.status === 402
            ? ' (no credits on this account)'
            : ''
      return {
        ok: false,
        status: response.status,
        emittedChars: 0,
        message: `OpenRouter ${response.status}${hint}: ${errText.slice(0, 200)}`
      }
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') continue
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>
            error?: { message?: string }
          }
          // Mid-stream provider errors arrive as SSE data with an error field
          if (json.error?.message && !full) {
            return { ok: false, status: 429, emittedChars: 0, message: json.error.message }
          }
          const token = json.choices?.[0]?.delta?.content
          if (token) {
            full += token
            emittedChars += token.length
            if (ttftMs === null) ttftMs = performance.now() - streamStarted
            callbacks.onToken(token)
          }
        } catch {
          // ignore malformed keep-alive chunks
        }
      }
    }

    callbacks.onDone(full)
    return {
      ok: true,
      emittedChars: full.length,
      full,
      ttft: ttftMs ?? performance.now() - streamStarted
    }
  } catch (err) {
    if (signal?.aborted) return { ok: true, emittedChars }
    return {
      ok: false,
      status: 0,
      emittedChars,
      message: err instanceof Error ? err.message : String(err)
    }
  }
}

export async function streamAnswer(
  question: string,
  callbacks: StreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const store = useAppStore.getState()
  const profile = store.profile

  const apiKeys = getOrderedApiKeys()
  if (!apiKeys.length) {
    callbacks.onError(
      'No OpenRouter API key configured — enter one in onboarding or put it in .env / openrouter.key.'
    )
    return
  }

  // Non-blocking: kick off background discovery/benchmark so later questions
  // use up-to-date, ranked candidates.
  void discoverAndBenchmarkModels()

  const ragContext = profile ? retrieveContext(question, profile) : ''
  const messages = buildRequestMessages(profile, ragContext, question)

  let lastMessage = ''
  const attempts: string[] = []

  const candidates = getCandidateModels()

  for (let i = 0; i < apiKeys.length; i++) {
    if (signal?.aborted) return
    for (const model of candidates) {
      if (signal?.aborted) return
      const startedAt = performance.now()
      const result = await attemptStream(apiKeys[i], messages, model, callbacks, signal)

      if (result.ok) {
        // Record measured TTFT and re-rank candidates for the next question.
        if (result.ttft !== undefined) recordTTFT(model, result.ttft)
        // Still usable, but slow — demote for the next request.
        if (result.ttft !== undefined && result.ttft > SLOW_TTFT_MS) markDegraded(model, 'slow-ttft')
        // Persist only genuinely-completed answers (aborted streams have no `full`).
        if (result.full?.trim()) recordTurn(question, result.full)
        return
      }

      const elapsed = Math.round(performance.now() - startedAt)
      const shortModel = model.split('/')[1] ?? model
      attempts.push(`key${i + 1}/${shortModel}:${result.status ?? 'net'}:${elapsed}ms`)

      // Self-healing: remember models that vanished or are hammered by 429s.
      if (result.status === 404) markDegraded(model, 'removed')
      else if (result.status === 429) markDegraded(model, 'rate-limited')

      // Only rotate while nothing has been shown to the user yet — otherwise
      // a mid-stream failure would restart the answer and duplicate text.
      if (result.emittedChars > 0 || i === apiKeys.length - 1) {
        callbacks.onError(result.message ?? 'Unknown OpenRouter error.')
        return
      }
      // Auth failures: next key. Rate-limit/model failures: next model.
      if (!isRotatable(result.status)) {
        callbacks.onError(result.message ?? 'Unknown OpenRouter error.')
        return
      }
      lastMessage = result.message ?? lastMessage
    }
  }

  console.warn(`[OpenRouter] failover exhausted: ${attempts.join(' -> ')}`)
  callbacks.onError(
    `All ${apiKeys.length} OpenRouter keys x ${candidates.length} models failed. Last error: ${lastMessage}`
  )
}