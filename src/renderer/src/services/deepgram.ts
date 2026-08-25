/**
 * Deepgram real-time streaming STT client.
 *
 * Streams 16kHz linear16 PCM over WebSocket. Deepgram's server-side
 * endpointing (600ms) replaces local Silero VAD for silence detection:
 * a final transcript arrives ~600ms after the speaker stops talking.
 *
 * Browser/Electron auth uses the WebSocket subprotocol:
 *   new WebSocket(url, ['token', DEEPGRAM_API_KEY])
 */
export interface DeepgramStreamOptions {
  onInterim?: (text: string) => void
  onFinal: (text: string) => void
  onError?: (error: string) => void
  onOpen?: () => void
  onClose?: () => void
}

export interface DeepgramStream {
  sendPcm16: (samples: Int16Array) => void
  close: () => void
}

/**
 * Strip anything that could corrupt the Sec-WebSocket-Protocol header value.
 * A key pasted / loaded with a trailing newline (CRLF .env), BOM, or stray
 * whitespace will otherwise make the browser's WebSocket handshake fail with
 * an HTTP 400 before it ever reaches Deepgram's API.
 */
export function sanitizeDeepgramKey(key: string): string {
  if (typeof key !== 'string') return ''
  // Remove BOM, control chars (incl. \r, \n, \t) and surrounding whitespace.
  return key.replace(/^\uFEFF/, '').replace(/[\u0000-\u001F\u007F]/g, '').trim()
}

/**
 * Fail fast on obviously-broken keys so the user gets an actionable message
 * instead of an opaque WebSocket handshake error later.
 */
export function validateDeepgramKey(key: string): string {
  const cleaned = sanitizeDeepgramKey(key)
  if (!cleaned) {
    throw new Error('Deepgram API key is empty — add it in the onboarding form or .env.')
  }
  if (
    /^(your[-_ ]?api[-_ ]?key|your[-_ ]?key|changeme|placeholder|replace[_-]?me|demo|example)$/i.test(
      cleaned
    )
  ) {
    throw new Error(
      `"${cleaned}" looks like a placeholder, not a real Deepgram key. Paste the key from console.deepgram.com.`
    )
  }
  return cleaned
}

export function createDeepgramStream(
  apiKey: string,
  options: DeepgramStreamOptions
): DeepgramStream {
  const key = sanitizeDeepgramKey(apiKey)
  const url =
    'wss://api.deepgram.com/v1/listen' +
    '?model=nova-2' +
    '&smart_format=true' +
    '&interim_results=true' +
    '&endpointing=600' + // 600ms silence -> final transcript (replaces VAD)
    '&encoding=linear16' +
    '&sample_rate=16000' +
    '&channels=1'

  let handshakeSucceeded = false

  const ws = new WebSocket(url, ['token', key])

  ws.onopen = () => {
    handshakeSucceeded = true
    options.onOpen?.()
  }

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data as string) as {
        type: string
        channel?: {
          alternatives?: Array<{ transcript?: string }>
        }
        is_final?: boolean
      }

      if (data.type === 'Results') {
        const transcript = data.channel?.alternatives?.[0]?.transcript?.trim() ?? ''
        if (!transcript) return
        if (data.is_final) {
          options.onFinal(transcript)
        } else {
          options.onInterim?.(transcript)
        }
      }
    } catch {
      // ignore malformed frames
    }
  }

  ws.onerror = () => {
    // If we never saw `onopen`, the handshake itself failed (the browser
    // swallows the exact HTTP status, so report the realistic causes).
    if (!handshakeSucceeded) {
      options.onError?.(
        'Deepgram rejected the WebSocket handshake (HTTP 4xx). Check the API key in onboarding/.env is valid, not a placeholder, and that your network allows wss:// to api.deepgram.com.'
      )
      return
    }
    options.onError?.('Deepgram connection dropped mid-stream — check your network and retry.')
  }

  ws.onclose = (event) => {
    if (handshakeSucceeded) {
      // 4000/4040 + 4001 = Deepgram rejected the API key after the handshake.
      if (event.code === 4000 || event.code === 4040 || event.code === 4001) {
        options.onError?.(
          `Deepgram rejected the session (${event.code}). Your API key is invalid or expired — refresh it at console.deepgram.com.`
        )
      }
    }
    options.onClose?.()
  }

  return {
    sendPcm16: (samples: Int16Array) => {
      if (handshakeSucceeded && ws.readyState === WebSocket.OPEN) {
        ws.send(samples.buffer as ArrayBuffer)
      }
    },
    close: () => {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          // Ask Deepgram to flush any pending audio before closing.
          ws.send(JSON.stringify({ type: 'Finalize' }))
          ws.close()
        }
      } catch {
        // already closed
      }
    }
  }
}

/** Convert Float32 PCM samples (-1..1) to Int16 PCM. */
export function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return int16
}