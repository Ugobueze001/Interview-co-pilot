import { useCallback, useEffect, useRef } from 'react'
import { createDeepgramStream, float32ToInt16, validateDeepgramKey, type DeepgramStream } from '../services/deepgram'
import { clearInterviewSession } from '../services/openrouter'
import { useAppStore } from '../store/useAppStore'

interface ChannelPipeline {
  audioContext: AudioContext
  processor: ScriptProcessorNode
  source: MediaStreamAudioSourceNode
  stream: DeepgramStream
  gate: UtteranceGate
}

// ---------------------------------------------------------------------------
// Utterance gate — never cut off an incomplete question.
//
// Deepgram delivers `is_final` segments quickly (~600ms endpointing) so the
// transcript stays live, but those segments are fragments of a longer
// utterance ("How would you handle a race condition in Node.js..." + pause +
// "...when using Redis locks?"). Committing every fragment to the store would
// fire the LLM on incomplete questions.
//
// The gate buffers final segments and only commits when the question is
// actually complete:
//   1. Deepgram `speech_final=true` on a final segment, OR
//   2. An `UtteranceEnd` event (>= utterance_end_ms pause), OR
//   3. SILENCE_COMMIT_MS of sustained quiet with no new speech activity.
// ---------------------------------------------------------------------------

const SILENCE_COMMIT_MS = 1800

interface UtteranceGate {
  onFinalSegment: (text: string, speechFinal: boolean) => void
  onUtteranceEnd: () => void
  dispose: () => void
}

function createUtteranceGate(commit: (text: string) => void): UtteranceGate {
  let buffer = ''
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (reason: string): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const text = buffer.trim()
    buffer = ''
    if (!text) return
    console.log(`[Audio] utterance committed (${reason}): "${text.slice(0, 120)}"`);
    commit(text)
  }

  const rearm = (): void => {
    if (timer) clearTimeout(timer)
    // Last resort: if neither speech_final nor UtteranceEnd arrives (e.g. a
    // provider quirk), commit after sustained silence anyway.
    timer = setTimeout(() => flush('silence-timeout'), SILENCE_COMMIT_MS)
  }

  return {
    onFinalSegment: (text: string, speechFinal: boolean): void => {
      buffer = buffer ? `${buffer} ${text}` : text
      if (speechFinal) {
        flush('speech-final')
      } else {
        rearm()
      }
    },
    onUtteranceEnd: (): void => {
      flush('utterance-end')
    },
    dispose: (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      buffer = ''
    }
  }
}

function describeTracks(stream: MediaStream | null | undefined, label: string): void {
  if (!stream) { console.log(`[Audio] ${label}: <no stream>`); return; }
  const v = stream.getVideoTracks(); const a = stream.getAudioTracks();
  console.log(`[Audio] ${label}: video=${v.length} audio=${a.length} id=${stream.id}`);
  for (const t of v) { console.log(`[Audio]   video track: kind=${t.kind} label="${t.label}" enabled=${t.enabled} muted=${t.muted} readyState=${t.readyState}`); }
  for (const t of a) { console.log(`[Audio]   audio track: kind=${t.kind} label="${t.label}" enabled=${t.enabled} muted=${t.muted} readyState=${t.readyState}`); }
}

function startChannelPipeline(
  mediaStream: MediaStream,
  apiKey: string,
  onInterim: (text: string) => void,
  onFinal: (text: string) => void
): ChannelPipeline {
  const audioContext = new AudioContext({ sampleRate: 16000 });
  const source = audioContext.createMediaStreamSource(mediaStream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const gate = createUtteranceGate(onFinal);
  const stream = createDeepgramStream(apiKey, {
    onInterim,
    onFinal: (text, meta) => gate.onFinalSegment(text, meta?.speechFinal === true),
    onUtteranceEnd: () => gate.onUtteranceEnd(),
    onError: (err) => useAppStore.getState().setSttError(err)
  });
  let firstFrameLogged = false;
  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    if (!firstFrameLogged) {
      let peak = 0;
      for (let i = 0; i < input.length; i++) { const v = Math.abs(input[i] ?? 0); if (v > peak) peak = v; }
      console.log(`[Audio] first PCM frame: samples=${input.length} peak=${peak.toFixed(4)}`);
      firstFrameLogged = true;
    }
    stream.sendPcm16(float32ToInt16(input));
  };
  const silence = audioContext.createGain();
  silence.gain.value = 0;
  source.connect(processor);
  processor.connect(silence);
  silence.connect(audioContext.destination);
  return { audioContext, processor, source, stream, gate };
}

function stopChannelPipeline(pipeline: ChannelPipeline | null): void {
  if (!pipeline) return;
  try {
    pipeline.gate.dispose();
    pipeline.stream.close();
    pipeline.processor.disconnect();
    pipeline.source.disconnect();
    if (pipeline.audioContext.state !== 'closed') {
      pipeline.audioContext.close();
    }
  } catch {}
}

// STRICT STREAM CLEANUP - prevents Chromium 16-stream limit
function cleanupAllStreams(
  streamsRef: React.MutableRefObject<MediaStream[]>,
  interviewerRef: React.MutableRefObject<ChannelPipeline | null>,
  userRef: React.MutableRefObject<ChannelPipeline | null>
): void {
  console.log('[Audio] cleanup: stopping all streams and pipelines...');
  
  // Stop all MediaStreamTracks in stored streams
  for (const stream of streamsRef.current) {
    for (const track of stream.getTracks()) {
      try {
        track.stop();
        console.log('[Audio] cleanup: stopped track', track.kind, track.id);
      } catch (e) {
        console.log('[Audio] cleanup: error stopping track:', e);
      }
    }
  }
  streamsRef.current = [];
  
  // Stop channel pipelines
  stopChannelPipeline(interviewerRef.current);
  interviewerRef.current = null;
  stopChannelPipeline(userRef.current);
  userRef.current = null;
  
  console.log('[Audio] cleanup: complete');
}

export function useDualAudio(): { startListening: () => Promise<void>; stopListening: () => void } {
  const interviewerRef = useRef<ChannelPipeline | null>(null);
  const userRef = useRef<ChannelPipeline | null>(null);
  const streamsRef = useRef<MediaStream[]>([]);
  const isStartingRef = useRef(false); // Lock to prevent concurrent starts

  const stopListening = useCallback(() => {
    console.log('[Audio] stopListening called');
    cleanupAllStreams(streamsRef, interviewerRef, userRef);
    useAppStore.getState().setListening(false);
    useAppStore.getState().setInterviewerSpeaking(false);
  }, []);

  const startListening = useCallback(async () => {
    // Prevent concurrent calls
    if (isStartingRef.current) {
      console.log('[Audio] startListening: already in progress, skipping');
      return;
    }
    
    const store = useAppStore.getState();
    if (store.listening) {
      console.log('[Audio] startListening: already listening, skipping');
      return;
    }

    // New interview session -> fresh conversational memory.
    clearInterviewSession();
    
    isStartingRef.current = true;
    console.log('[Audio] startListening: acquiring lock');
    
    try {
      // CRITICAL: Clean up ANY existing streams BEFORE acquiring new ones
      // This prevents the Chromium 16-stream limit error
      cleanupAllStreams(streamsRef, interviewerRef, userRef);
      
      console.log('[Audio] active tracks after cleanup:', streamsRef.current.length);
      
      // Validate Deepgram key
      const rawKey = useAppStore.getState().deepgramKey || (await window.api?.config?.getDeepgramKey()) || '';
      let apiKey: string;
      try {
        apiKey = validateDeepgramKey(rawKey);
      } catch (err) {
        useAppStore.getState().setSttError(err instanceof Error ? err.message : String(err));
        return;
      }

      // Log platform info
      console.log('[Audio] platform info:');
      console.log('[Audio]   userAgent:', navigator.userAgent);
      console.log('[Audio]   platform:', navigator.platform);
      const em = navigator.userAgent.match(/Electron\/(\S+)/);
      const cm = navigator.userAgent.match(/Chrome\/(\S+)/);
      console.log('[Audio]   Electron version:', em ? em[1] : 'unknown');
      console.log('[Audio]   Chrome version:', cm ? cm[1] : 'unknown');

      // Request display media with audio
      const displayConstraints = { video: true, audio: true };
      console.log('[Audio] getDisplayMedia constraints:', JSON.stringify(displayConstraints));
      
      const displayStream = await navigator.mediaDevices.getDisplayMedia(displayConstraints);
      console.log('[Audio] getDisplayMedia returned stream');

      // Log track details
      const vt = displayStream.getVideoTracks();
      const at = displayStream.getAudioTracks();
      console.log('[Audio] stream has ' + vt.length + ' video tracks and ' + at.length + ' audio tracks');
      
      for (const t of vt) {
        console.log('[Audio] VIDEO track: id=' + t.id + ' label=' + JSON.stringify(t.label) + ' readyState=' + t.readyState + ' enabled=' + t.enabled + ' muted=' + t.muted);
      }
      
      for (const t of at) {
        console.log('[Audio] AUDIO track: id=' + t.id + ' label=' + JSON.stringify(t.label) + ' readyState=' + t.readyState + ' enabled=' + t.enabled + ' muted=' + t.muted);
        
        // Analyze audio levels
        try {
          const ac2 = new AudioContext();
          const src2 = ac2.createMediaStreamSource(displayStream);
          const analyser = ac2.createAnalyser();
          analyser.fftSize = 2048;
          src2.connect(analyser);
          const buf = new Uint8Array(analyser.frequencyBinCount);
          setTimeout(() => {
            analyser.getByteFrequencyData(buf);
            const max = Math.max(...buf);
            const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
            console.log('[Audio] system audio: max=' + max + ' avg=' + avg.toFixed(2));
            if (max < 5) {
              console.warn('[Audio] WARNING: Audio appears SILENT. CoreAudio Tap may not be working.');
            } else {
              console.log('[Audio] SUCCESS: System audio contains REAL data');
            }
            ac2.close();
          }, 500);
        } catch (e) {
          console.log('[Audio] audio analysis failed:', e);
        }
      }
      
      describeTracks(displayStream, 'display capture');
      
      if (!displayStream.getAudioTracks().length) {
        const hint = 'On macOS: re-share and check the Share audio checkbox.';
        console.error('[Audio] SYSTEM_OUTPUT track missing. ' + hint);
        displayStream.getTracks().forEach((t) => t.stop());
        throw new Error('No system-audio track in shared stream. ' + hint);
      }
      
      streamsRef.current.push(displayStream);
      console.log('[Audio] requesting microphone...');
      
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      describeTracks(micStream, 'microphone');
      streamsRef.current.push(micStream);

      // Start pipelines
      interviewerRef.current = startChannelPipeline(
        displayStream, apiKey,
        () => useAppStore.getState().setInterviewerSpeaking(true),
        (text) => {
          useAppStore.getState().setInterviewerSpeaking(false);
          useAppStore.getState().addTranscript('interviewer', text);
          window.dispatchEvent(new CustomEvent('interviewer-question', { detail: text }));
        }
      );
      
      userRef.current = startChannelPipeline(
        micStream, apiKey,
        () => {},
        (text) => { useAppStore.getState().addTranscript('user', text); }
      );

      // Handle user ending screen share
      displayStream.getVideoTracks()[0]?.addEventListener('ended', () => {
        console.log('[Audio] display capture ended by user');
        stopListening();
      });

      console.log('[Audio] both pipelines running');
      useAppStore.getState().setListening(true);
      useAppStore.getState().setSttError(null);
      
    } catch (err) {
      console.error('[Audio] start failed:', err);
      cleanupAllStreams(streamsRef, interviewerRef, userRef);
      useAppStore.getState().setSttError(err instanceof Error ? err.message : String(err));
    } finally {
      isStartingRef.current = false;
      console.log('[Audio] startListening: released lock');
    }
  }, [stopListening]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      console.log('[Audio] useDualAudio unmounting, cleaning up...');
      cleanupAllStreams(streamsRef, interviewerRef, userRef);
    };
  }, []);

  return { startListening, stopListening };
}
