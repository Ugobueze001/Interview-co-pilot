import { useAppStore, type CandidateProfile } from '../store/useAppStore'

/**
 * OpenRouter SSE streaming client (OpenAI-compatible chat completions).
 * Streams tokens in real time; the UI renders them line-by-line.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const MODEL = 'openai/gpt-4o-mini' // fast + cheap default; any OpenRouter model works

export const SYSTEM_PROMPT = `You are the ultimate interview assistant. Using the dynamically retrieved Resume and Job Description context, answer the interviewer's question perfectly. Format your response EXACTLY like this and be concise:
1. Define First: [Clear, concise definition or direct answer to the question]
2. Why it matters: [Explain the business impact, value, or importance in the context of the job description]
3. Example: [Provide a specific, actionable example, ideally mapping to the candidate's past experience]`

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
// SSE streaming
// ------------------------------------------------------------

export interface StreamCallbacks {
  onToken: (token: string) => void
  onDone: (fullAnswer: string) => void
  onError: (error: string) => void
}

export async function streamAnswer(
  question: string,
  callbacks: StreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const store = useAppStore.getState()
  const apiKey = store.openRouterKey
  const profile = store.profile

  if (!apiKey) {
    callbacks.onError('No OpenRouter API key configured.')
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

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
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
      throw new Error(`OpenRouter ${response.status}: ${errText.slice(0, 300)}`)
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
          }
          const token = json.choices?.[0]?.delta?.content
          if (token) {
            full += token
            callbacks.onToken(token)
          }
        } catch {
          // ignore malformed keep-alive chunks
        }
      }
    }

    callbacks.onDone(full)
  } catch (err) {
    if (signal?.aborted) return
    callbacks.onError(err instanceof Error ? err.message : String(err))
  }
}