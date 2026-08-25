/**
 * Audio utilities: resampling to 16kHz mono and WAV encoding
 * for local Whisper.cpp transcription.
 */

export const WHISPER_SAMPLE_RATE = 16000

/**
 * Resample an AudioBuffer to 16kHz mono Float32 PCM.
 */
export function resampleTo16kMono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels
  const sourceRate = buffer.sampleRate

  // Mix down to mono
  const mono = new Float32Array(buffer.length)
  for (let ch = 0; ch < channels; ch++) {
    const data = buffer.getChannelData(ch)
    for (let i = 0; i < data.length; i++) {
      mono[i] += data[i] / channels
    }
  }

  if (sourceRate === WHISPER_SAMPLE_RATE) return mono

  // Linear interpolation resample
  const ratio = sourceRate / WHISPER_SAMPLE_RATE
  const outLength = Math.floor(mono.length / ratio)
  const output = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const srcIndex = i * ratio
    const low = Math.floor(srcIndex)
    const high = Math.min(low + 1, mono.length - 1)
    const frac = srcIndex - low
    output[i] = mono[low] * (1 - frac) + mono[high] * frac
  }
  return output
}

/**
 * Encode Float32 PCM samples as a 16-bit WAV file buffer.
 */
export function encodeWav(samples: Float32Array, sampleRate = WHISPER_SAMPLE_RATE): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  // RIFF header
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(view, 8, 'WAVE')

  // fmt chunk
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // chunk size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample

  // data chunk
  writeString(view, 36, 'data')
  view.setUint32(40, samples.length * 2, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }

  return buffer
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}