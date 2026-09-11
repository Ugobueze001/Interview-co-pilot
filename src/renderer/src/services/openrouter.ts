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
  'openrouter/free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen-2.5-coder-32b-instruct:free',
  'deepseek/deepseek-r1:free'
]

/**
 * Value sent in the payload's `models:` field — OpenRouter rejects more than 3
 * auto-fallback models. The manual key×model loop still tries EVERY model in
 * MODEL_CHAIN; this array only drives OpenRouter's native failover.
 */
const AUTO_FALLBACK_MODELS = MODEL_CHAIN.slice(0, 3)

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
function buildSystemPrompt(profile: CandidateProfile | null): string {
  if (!profile) return SYSTEM_PROMPT
  const ctx: string[] = []
  if (profile.fullName.trim()) ctx.push(`CANDIDATE: ${profile.fullName.trim()}`)
  if (profile.jobTitle.trim()) ctx.push(`TARGET ROLE: ${profile.jobTitle.trim()}`)
  if (profile.resume.trim()) {
    ctx.push(`CANDIDATE RESUME CONTEXT:\n${profile.resume.trim().slice(0, 4000)}`)
  }
  if (profile.jobDescription.trim()) {
    ctx.push(`TARGET JOB DESCRIPTION:\n${profile.jobDescription.trim().slice(0, 2000)}`)
  }
  if (profile.keySkills.length) ctx.push(`KEY SKILLS: ${profile.keySkills.join(', ')}`)
  return ctx.length ? `${SYSTEM_PROMPT}\n\n${ctx.join('\n\n')}` : SYSTEM_PROMPT
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

function chunkText(text: string, size = 400): string[] {
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

function retrieveContext(question: string, profile: CandidateProfile, topK = 4): string {
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

async function attemptStream(
  apiKey: string,
  messages: ChatMessage[],
  model: string,
  callbacks: StreamCallbacks,
  signal?: AbortSignal
): Promise<AttemptResult> {
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
        models: AUTO_FALLBACK_MODELS, // native auto-fallback (OpenRouter caps at 3)
        stream: true,
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
            callbacks.onToken(token)
          }
        } catch {
          // ignore malformed keep-alive chunks
        }
      }
    }

    callbacks.onDone(full)
    return { ok: true, emittedChars: full.length, full }
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

  const ragContext = profile ? retrieveContext(question, profile) : ''
  const messages = buildRequestMessages(profile, ragContext, question)

  let lastMessage = ''
  const attempts: string[] = []

  for (let i = 0; i < apiKeys.length; i++) {
    if (signal?.aborted) return
    for (const model of MODEL_CHAIN) {
      if (signal?.aborted) return
      const startedAt = performance.now()
      const result = await attemptStream(apiKeys[i], messages, model, callbacks, signal)

      if (result.ok) {
        // Persist only genuinely-completed answers (aborted streams have no `full`).
        if (result.full?.trim()) recordTurn(question, result.full)
        return
      }

      const elapsed = Math.round(performance.now() - startedAt)
      const shortModel = model.split('/')[1] ?? model
      attempts.push(`key${i + 1}/${shortModel}:${result.status ?? 'net'}:${elapsed}ms`)

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
    `All ${apiKeys.length} OpenRouter keys x ${MODEL_CHAIN.length} models failed. Last error: ${lastMessage}`
  )
}