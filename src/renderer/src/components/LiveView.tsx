import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useDualAudio } from '../hooks/useDualAudio'
import AnswerPanel from './AnswerPanel'

export default function LiveView(): React.JSX.Element {
  const profile = useAppStore((s) => s.profile)
  const listening = useAppStore((s) => s.listening)
  const interviewerSpeaking = useAppStore((s) => s.interviewerSpeaking)
  const transcripts = useAppStore((s) => s.transcripts)
  const sttError = useAppStore((s) => s.sttError)
  const { startListening, stopListening } = useDualAudio()

  const [manualQuestion, setManualQuestion] = useState('')
  const [deepgramReady, setDeepgramReady] = useState<boolean | null>(null)
  const [capturing, setCapturing] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.api?.config?.getDeepgramKey().then((key) => setDeepgramReady(Boolean(key)))
  }, [])

  // Auto-scroll transcript list
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [transcripts])

  const submitManualQuestion = (e: React.FormEvent): void => {
    e.preventDefault()
    const q = manualQuestion.trim()
    if (!q) return
    useAppStore.getState().addTranscript('interviewer', q)
    window.dispatchEvent(new CustomEvent('interviewer-question', { detail: q }))
    setManualQuestion('')
  }

  /**
   * Capture the entire screen, convert to a base64 PNG, and send it to the
   * AI with a prompt asking it to analyze/answer whatever is on screen.
   * Uses getDisplayMedia — the main process auto-grants the primary display
   * (no picker dialog) via setDisplayMediaRequestHandler.
   */
  const captureScreen = async (): Promise<void> => {
    if (capturing) return
    setCapturing(true)
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 } as MediaTrackConstraints,
        audio: false
      })

      // Grab one frame from the video stream
      const track = stream.getVideoTracks()[0]
      if (!track) {
        console.warn('[Capture] no video track available')
        return
      }

      const video = document.createElement('video')
      video.srcObject = stream
      video.muted = true
      await video.play()

      // Wait a tick so the video element has valid dimensions
      await new Promise((r) => setTimeout(r, 200))

      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth || 1280
      canvas.height = video.videoHeight || 720
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        console.warn('[Capture] could not get 2d context')
        return
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

      // Stop all tracks immediately so the screen-share indicator disappears
      stream.getTracks().forEach((t) => t.stop())

      // Convert to base64 PNG (data URL)
      const imageUrl = canvas.toDataURL('image/png')

      // Log the capture in the transcript panel
      useAppStore.getState().addTranscript('interviewer', '[📸 Screenshot captured — sending to AI...]')

      // Dispatch the screenshot event that AnswerPanel listens for
      window.dispatchEvent(
        new CustomEvent<{ imageUrl: string; prompt: string }>('screenshot-question', {
          detail: {
            imageUrl,
            prompt:
              'I am sharing a screenshot of my screen during a technical interview. Please analyze the image carefully and provide a detailed, structured answer to whatever question, problem, or code you see. Use the format: 1. **Define** 2. **Why it Matters** 3. **Example**. Be concise and precise.'
          }
        })
      )
    } catch (err) {
      console.warn('[Capture] screen capture failed or was cancelled:', err)
      useAppStore
        .getState()
        .addTranscript('interviewer', '[📸 Screen capture cancelled or failed]')
    } finally {
      if (stream) stream.getTracks().forEach((t) => t.stop())
      setCapturing(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Control bar */}
      <div className="flex shrink-0 items-center justify-between border-b border-slate-800 px-4 py-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => (listening ? stopListening() : void startListening())}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
              listening
                ? 'bg-red-600/80 text-white hover:bg-red-500'
                : 'bg-emerald-600 text-white hover:bg-emerald-500'
            }`}
          >
            {listening ? '■ Stop Listening' : '● Start Listening'}
          </button>
          <button
            onClick={() => void captureScreen()}
            disabled={capturing}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
              capturing
                ? 'bg-amber-600/50 text-amber-200 cursor-wait'
                : 'bg-violet-600 text-white hover:bg-violet-500'
            }`}
            title="Capture the entire screen and send it to the AI for an answer"
          >
            {capturing ? '⏳ Capturing…' : '📸 Capture Screen'}
          </button>
          <span
            className={`h-2 w-2 rounded-full ${
              listening
                ? interviewerSpeaking
                  ? 'animate-pulse bg-amber-400'
                  : 'bg-emerald-400'
                : 'bg-slate-600'
            }`}
            title={
              listening
                ? interviewerSpeaking
                  ? 'Interviewer speaking...'
                  : 'Silence detected'
                : 'Not listening'
            }
          />
        </div>
        <span className="text-[10px] text-slate-500">
          {deepgramReady === null
            ? 'checking STT…'
            : deepgramReady
              ? 'Deepgram live STT ready'
              : '⚠ Deepgram key missing — use manual input'}
        </span>
      </div>

      {/* Error banner */}
      {sttError && (
        <p className="shrink-0 border-b border-red-900/50 bg-red-500/10 px-4 py-1.5 text-[11px] text-red-300">
          {sttError}
        </p>
      )}

      {/* Dual transcript panels */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {transcripts.length === 0 && (
          <p className="mt-4 text-center text-xs text-slate-600">
            {listening
              ? 'Listening… ask a question out loud or type one below.'
              : 'Press “Start Listening” and share your screen with audio.'}
          </p>
        )}
        {transcripts.map((t) => (
          <div
            key={t.id}
            className={`rounded-lg px-3 py-2 text-xs leading-relaxed ${
              t.channel === 'interviewer'
                ? 'ml-6 border border-indigo-800/60 bg-indigo-950/40 text-indigo-100'
                : 'mr-6 border border-slate-700/60 bg-slate-900/60 text-slate-300'
            }`}
          >
            <span
              className={`mb-0.5 block text-[9px] font-bold tracking-wider uppercase ${
                t.channel === 'interviewer' ? 'text-indigo-400' : 'text-slate-500'
              }`}
            >
              {t.channel === 'interviewer'
                ? 'Interviewer'
                : `You${profile ? ` (${profile.fullName})` : ''}`}
            </span>
            {t.text}
          </div>
        ))}
      </div>

      {/* AI answer stream */}
      <div className="h-[45%] shrink-0">
        <AnswerPanel />
      </div>

      {/* Manual input fallback */}
      <form onSubmit={submitManualQuestion} className="shrink-0 border-t border-slate-800 p-3">
        <div className="flex gap-2">
          <input
            value={manualQuestion}
            onChange={(e) => setManualQuestion(e.target.value)}
            placeholder="Type the question here if audio fails…"
            className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100 placeholder-slate-500 outline-none focus:border-emerald-500"
          />
          <button
            type="submit"
            className="rounded-lg bg-slate-700 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-600"
          >
            Ask ↵
          </button>
        </div>
      </form>
    </div>
  )
}