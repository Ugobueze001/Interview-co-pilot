import { useCallback, useEffect, useRef } from 'react'
import { createDeepgramStream, float32ToInt16, validateDeepgramKey, type DeepgramStream } from '../services/deepgram'
import { useAppStore } from '../store/useAppStore'

/**
 * Dual Audio Listener System (Deepgram streaming edition)
 *
 * - Interviewer channel: system/tab audio via getDisplayMedia, streamed to
 *   Deepgram. Deepgram's 600ms server-side endpointing detects when the
 *   interviewer stops talking -> final transcript triggers the AI pipeline.
 *
 * - User channel: microphone via getUserMedia, streamed to a second Deepgram
 *   connection for context logging only (does not trigger answers).
 */

interface ChannelPipeline {
  audioContext: AudioContext
  processor: ScriptProcessorNode
  source: MediaStreamAudioSourceNode
  stream: DeepgramStream
}

function startChannelPipeline(
  mediaStream: MediaStream,
  apiKey: string,
  onInterim: (text: string) => void,
  onFinal: (text: string) => void
): ChannelPipeline {
  // 16kHz AudioContext -> PCM matches Deepgram's expected sample rate
  const audioContext = new AudioContext({ sampleRate: 16000 })
  const source = audioContext.createMediaStreamSource(mediaStream)
  const processor = audioContext.createScriptProcessor(4096, 1, 1)

  const stream = createDeepgramStream(apiKey, {
    onInterim,
    onFinal,
    onError: (err) => useAppStore.getState().setSttError(err)
  })

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0)
    stream.sendPcm16(float32ToInt16(input))
  }

  // Muted gain node keeps the graph pulling without echoing audio out
  const silence = audioContext.createGain()
  silence.gain.value = 0
  source.connect(processor)
  processor.connect(silence)
  silence.connect(audioContext.destination)

  return { audioContext, processor, source, stream }
}

function stopChannelPipeline(pipeline: ChannelPipeline): void {
  try {
    pipeline.stream.close()
    pipeline.processor.disconnect()
    pipeline.source.disconnect()
    void pipeline.audioContext.close()
  } catch {
    // already torn down
  }
}

export function useDualAudio(): {
  startListening: () => Promise<void>
  stopListening: () => void
} {
  const interviewerRef = useRef<ChannelPipeline | null>(null)
  const userRef = useRef<ChannelPipeline | null>(null)
  const streamsRef = useRef<MediaStream[]>([])

  const stopListening = useCallback((): void => {
    if (interviewerRef.current) stopChannelPipeline(interviewerRef.current)
    if (userRef.current) stopChannelPipeline(userRef.current)
    interviewerRef.current = null
    userRef.current = null
    streamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()))
    streamsRef.current = []
    useAppStore.getState().setListening(false)
    useAppStore.getState().setInterviewerSpeaking(false)
  }, [])

  const startListening = useCallback(async (): Promise<void> => {
    const store = useAppStore.getState()
    if (store.listening) return

    // Prefer the key entered on the onboarding form; fall back to .env/IPC
    const rawKey =
      useAppStore.getState().deepgramKey ||
      (await window.api?.config?.getDeepgramKey()) ||
      ''

    // Validate/sanitize up front: a placeholder, empty, or control-character
    // corrupted key would otherwise fail later as an opaque WS handshake 400.
    let apiKey: string
    try {
      apiKey = validateDeepgramKey(rawKey)
    } catch (err) {
      useAppStore
        .getState()
        .setSttError(err instanceof Error ? err.message : String(err))
      return
    }

    try {
      // ---- Interviewer channel: system audio via screen capture ----
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true, // required by Chrome to enable audio capture
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      })

      if (!displayStream.getAudioTracks().length) {
        displayStream.getTracks().forEach((t) => t.stop())
        throw new Error(
          'No audio in shared stream. Re-share and make sure to tick "Share audio".'
        )
      }
      streamsRef.current.push(displayStream)

      // ---- User channel: microphone ----
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      streamsRef.current.push(micStream)

      // ---- Interviewer pipeline (triggers answers) ----
      interviewerRef.current = startChannelPipeline(
        displayStream,
        apiKey,
        () => useAppStore.getState().setInterviewerSpeaking(true),
        (text) => {
          useAppStore.getState().setInterviewerSpeaking(false)
          useAppStore.getState().addTranscript('interviewer', text)
          window.dispatchEvent(new CustomEvent('interviewer-question', { detail: text }))
        }
      )

      // ---- User pipeline (context logging only) ----
      userRef.current = startChannelPipeline(
        micStream,
        apiKey,
        () => {},
        (text) => {
          useAppStore.getState().addTranscript('user', text)
        }
      )

      // Handle user ending screen share natively
      displayStream.getVideoTracks()[0]?.addEventListener('ended', () => {
        stopListening()
      })

      useAppStore.getState().setListening(true)
      useAppStore.getState().setSttError(null)
    } catch (err) {
      stopListening()
      useAppStore.getState().setSttError(err instanceof Error ? err.message : String(err))
    }
  }, [stopListening])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopListening()
    }
  }, [stopListening])

  return { startListening, stopListening }
}