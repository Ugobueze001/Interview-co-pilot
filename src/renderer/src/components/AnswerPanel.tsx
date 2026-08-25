import { useEffect, useRef, useState } from 'react'
import { streamAnswer } from '../services/openrouter'

/**
 * Streams AI answers token-by-token in response to:
 *  - VAD-detected interviewer utterances ('interviewer-question' events)
 *  - Manual text input from LiveView (same event)
 */
export default function AnswerPanel(): React.JSX.Element {
  const [answer, setAnswer] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: Event): void => {
      const question = (e as CustomEvent<string>).detail
      void generateAnswer(question)
    }
    window.addEventListener('interviewer-question', handler)
    return () => window.removeEventListener('interviewer-question', handler)
  }, [])

  // Auto-scroll as tokens arrive
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [answer])

  const generateAnswer = async (question: string): Promise<void> => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setAnswer('')
    setError(null)
    setStreaming(true)

    await streamAnswer(
      question,
      {
        onToken: (token) => setAnswer((prev) => prev + token),
        onDone: () => setStreaming(false),
        onError: (msg) => {
          setError(msg)
          setStreaming(false)
        }
      },
      abortRef.current.signal
    )
  }

  // Render streamed lines; highlight the numbered structure
  const lines = answer.split('\n')

  return (
    <div className="flex h-full min-h-0 flex-col border-t border-slate-800">
      <div className="flex items-center justify-between px-3 py-1">
        <span className="text-[9px] font-bold tracking-wider text-emerald-400 uppercase">
          AI Answer {streaming && <span className="animate-pulse">● streaming…</span>}
        </span>
        {answer && !streaming && (
          <button
            onClick={() => {
              setAnswer('')
              setError(null)
            }}
            className="text-[9px] text-slate-500 hover:text-slate-300"
          >
            clear
          </button>
        )}
      </div>

      {error && (
        <p className="mx-3 mb-2 rounded bg-red-500/10 px-2 py-1 text-[10px] text-red-300">{error}</p>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {lines.map((line, i) => (
          <p
            key={i}
            className={`text-xs leading-relaxed ${
              /^\s*[123]\./.test(line) ? 'mt-2 font-semibold text-emerald-200' : 'text-slate-300'
            }`}
          >
            {line || '\u00A0'}
          </p>
        ))}
        {streaming && <span className="inline-block h-3 w-1 animate-pulse bg-emerald-400" />}
      </div>
    </div>
  )
}