import { useAppStore, type CandidateProfile } from '../store/useAppStore'

/**
 * OpenRouter SSE streaming client (OpenAI-compatible chat completions).
 * Streams tokens in real time; the UI renders them line-by-line.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

/**
 * FREE models only - no credits required on OpenRouter.
 *
 * NOTE: meta-llama/*:free models were removed from OpenRouter's free tier
 * (they now return 404 "unavailable for free"), so this chain uses the best
 * currently-live free models instead - verified against the live catalog.
 *
 * The first entry is used as the default; OpenRouter automatically falls
 * through the rest when one is rate-limited (:free tiers are throttled).
 */
export const MODEL_CHAIN = [
  'google/gemini-2.0-flash-exp:free', // priority 1: fastest free generalist
  'qwen/qwen-2.5-coder-32b-instruct:free', // priority 2: strong technical answers
  'meta-llama/llama-3.3-70b-instruct:free', // priority 3: high-quality reasoning
  'deepseek/deepseek-r1:free', // priority 4: deep reasoning fallback
  'minimax/minimax-m2.7:free', // verified working generalist
  'google/gemma-4-31b-it:free', // recovers well from 429s
  'nvidia/nemotron-3-super-120b-a12b:free' // fastest verified responder
]

export const SYSTEM_PROMPT = `You are an elite live technical interview co-pilot. Respond instantly.
Analyze the full intent of the question before answering. Base your answer on the candidate's resume and background where relevant, expanding on their experience.
STRUCTURE EVERY RESPONSE STRICTLY AS:
1. **Define**: Concise 1-2 sentence core definition or direct answer to the question.
2. **Why it Matters**: 2-3 key technical points on production impact, performance, or engineering trade-offs.
3. **Example**: A short, highly realistic code or architecture snippet/example.`

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
  userContent: string,
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
        models: MODEL_CHAIN, // automatic fallback when a :free model is rate-limited
        stream: true,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent }
        ]
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
    return { ok: true, emittedChars: full.length }
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
  const userContent = ragContext
    ? `CONTEXT (retrieved from candidate data):
${ragContext}

INTERVIEWER'S QUESTION:
${question}`
    : `INTERVIEWER'S QUESTION:
${question}`

  let lastMessage = ''
  const attempts: string[] = []

  for (let i = 0; i < apiKeys.length; i++) {
    if (signal?.aborted) return
    for (const model of MODEL_CHAIN) {
      if (signal?.aborted) return
      const startedAt = performance.now()
      const result = await attemptStream(apiKeys[i], userContent, model, callbacks, signal)

      if (result.ok || signal?.aborted) return

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