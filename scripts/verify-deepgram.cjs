/**
 * END-TO-END Deepgram STT verification with the REAL configured key.
 * Streams real speech PCM over wss://api.deepgram.com/v1/listen using the
 * SAME URL/params/auth as src/renderer/src/services/deepgram.ts, then
 * asserts non-empty final transcripts come back. Never prints the key.
 */
const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')

const ROOT = path.join(__dirname, '..')

function readConfiguredKey() {
  try {
    const content = fs.readFileSync(path.join(ROOT, '.env'), 'utf-8')
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const k = line.slice(0, eq).trim()
      let v = line.slice(eq + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      if (k === 'DEEPGRAM_API_KEY' && v) return v
    }
  } catch {}
  try {
    return fs.readFileSync(path.join(ROOT, 'deepgram.key'), 'utf-8').trim()
  } catch {}
  return null
}

function fetchBuffer(url, depth) {
  depth = depth || 0
  if (depth > 5) return Promise.reject(new Error('too many redirects'))
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http:') ? http : https
    mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return resolve(fetchBuffer(new URL(res.headers.location, url).href, depth + 1))
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)) }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject).setTimeout(10000, function () { this.destroy(new Error('download timeout')) })
  })
}

function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file')
  }
  let off = 12
  let fmt = null
  let data = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bitsPerSample: buf.readUInt16LE(off + 22)
      }
    } else if (id === 'data') {
      data = buf.subarray(off + 8, off + 8 + size)
    }
    off += 8 + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('Missing fmt/data chunk')
  return { ...fmt, pcm: data }
}

// Linear-interpolation resampler (16-bit PCM)
function resampleTo16k(pcm, fromRate, channels) {
  if (fromRate === 16000 || channels !== 1) return pcm
  const total = Math.floor(pcm.length / 2)
  const ratio = fromRate / 16000
  const outN = Math.floor(total / ratio)
  const out = Buffer.alloc(outN * 2)
  for (let s = 0; s < outN; s++) {
    const p = s * ratio
    const i0 = Math.floor(p)
    const f = p - i0
    const a = pcm.readInt16LE(Math.min(i0, total - 1) * 2)
    const b = pcm.readInt16LE(Math.min(i0 + 1, total - 1) * 2)
    out.writeInt16LE(Math.round(a + (b - a) * f), s * 2)
  }
  return out
}

// Pre-recorded REST transcription - proves key + STT work without WS framing
function prerecorded(key, wavBuf) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.deepgram.com',
        path: '/v1/listen?smart_format=true&model=nova-2',
        method: 'POST',
        headers: {
          Authorization: 'Token ' + key,
          'Content-Type': 'audio/wav',
          'Content-Length': wavBuf.length
        },
        timeout: 12000
      },
      (res) => {
        let b = ''
        res.on('data', (c) => (b += c))
        res.on('end', () => {
          try {
            const j = JSON.parse(b)
            const alts = j.results && j.results.channels && j.results.channels[0] && j.results.channels[0].alternatives
            const t = ((alts && alts[0] && alts[0].transcript) || '').trim()
            resolve('[pre-recorded] HTTP ' + res.statusCode + ' transcript="' + t + '"')
          } catch {
            resolve('[pre-recorded] HTTP ' + res.statusCode + ' body=' + b.slice(0, 150))
          }
        })
      }
    )
    req.on('timeout', () => { req.destroy(); resolve('[pre-recorded] TIMEOUT') })
    req.on('error', (e) => resolve('[pre-recorded] ERROR ' + e.message))
    req.end(wavBuf)
  })
}

;(async () => {
  // Hard watchdog so this always finishes inside the 30s command budget
  setTimeout(() => { console.log('WATCHDOG: aborting at 25s'); process.exit(2) }, 25000)

  const key = readConfiguredKey()
  if (!key) { console.log('NO KEY FOUND'); process.exit(1) }

  // Get (or create) a real speech sample. Windows SAPI TTS renders one locally.
  const { execSync } = require('child_process')
  const samplePath = path.join(ROOT, '.verify-sample.wav')
  if (!fs.existsSync(samplePath)) {
    console.log('Generating speech sample via Windows TTS...')
    const ps =
      "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
      "$s.SetOutputToWaveFile('" + samplePath.replace(/\//g, '\\') + "'); " +
      "$s.Rate = 0; " +
      "$s.Speak('Hello, this is a live transcription test of the interview assistant. The quick brown fox jumps over the lazy dog.'); " +
      '$s.Dispose()'
    execSync('powershell -NoProfile -Command "' + ps + '"', { stdio: 'inherit' })
  }

  let wav = null
  try {
    wav = fs.readFileSync(samplePath)
    console.log('Using speech sample: ' + samplePath)
  } catch {}
  if (!wav) { console.log('No sample audio available'); process.exit(1) }

  console.log(await prerecorded(key, wav))

  const audio = parseWav(wav)
  // Downmix stereo -> mono (the app's AudioContext pipeline is mono too)
  if (audio.channels === 2 && audio.bitsPerSample === 16) {
    const mono = Buffer.alloc(audio.pcm.length / 2)
    let j = 0
    for (let i = 0; i + 3 < audio.pcm.length; i += 4) {
      const l = audio.pcm.readInt16LE(i)
      const r = audio.pcm.readInt16LE(i + 2)
      mono.writeInt16LE(Math.max(-32768, Math.min(32767, (l + r) >> 1)), j)
      j += 2
    }
    audio.pcm = mono
    audio.channels = 1
  }
  // Resample to 16 kHz mono - exactly what the app's AudioContext produces
  if (audio.sampleRate !== 16000) {
    audio.pcm = resampleTo16k(audio.pcm, audio.sampleRate, audio.channels)
    audio.sampleRate = 16000
  }
  // Repeat the short clip so we feed several seconds of sustained speech
  const reps = Math.max(1, Math.ceil((audio.sampleRate * 4 * audio.channels * (audio.bitsPerSample / 8)) / audio.pcm.length))
  const orig = audio.pcm
  const parts = []
  for (let i = 0; i < Math.min(reps, 8); i++) parts.push(orig)
  audio.pcm = Buffer.concat(parts)
  const durSec = (audio.pcm.length / (audio.sampleRate * audio.channels * audio.bitsPerSample / 8)).toFixed(1)
  console.log('Audio: ' + (audio.audioFormat === 1 ? 'PCM' : 'fmt=' + audio.audioFormat) + ', ' + audio.channels + 'ch, ' + audio.sampleRate + 'Hz, ' + audio.bitsPerSample + '-bit, ~' + durSec + 's')

  // ---- Connect with the app's params, matched to this audio ----
  const qs = 'model=nova-2&smart_format=true&interim_results=true&endpointing=600' +
    '&encoding=linear16&sample_rate=' + audio.sampleRate + '&channels=' + audio.channels
  console.log('Connecting: wss://api.deepgram.com/v1/listen?' + qs)

  const ws = new WebSocket('wss://api.deepgram.com/v1/listen?' + qs, ['token', key])
  ws.binaryType = 'arraybuffer'

  const finals = []
  let opened = false

  ws.onopen = () => {
    opened = true
    console.log('WebSocket OPENED - handshake accepted')
    // Stream much faster than realtime: ~0.5s of audio per 20ms tick
    const bytesPerSlice = Math.ceil(audio.sampleRate * 0.5) * audio.channels * (audio.bitsPerSample / 8)
    let pos = 0
    const timer = setInterval(() => {
      if (pos >= audio.pcm.length || ws.readyState !== 1) {
        clearInterval(timer)
        try { ws.send(JSON.stringify({ type: 'Finalize' })) } catch {}
        setTimeout(() => { try { ws.close() } catch {} }, 3000)
        return
      }
      ws.send(audio.pcm.subarray(pos, pos + bytesPerSlice))
      pos += bytesPerSlice
    }, 20)
  }

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      if (msg.type !== 'Results') console.log('   <' + msg.type + '>')
      if (msg.type === 'Results') {
        const alts = msg.channel && msg.channel.alternatives
        const t = ((alts && alts[0] && alts[0].transcript) || '').trim()
        if (t) console.log('   [' + (msg.is_final ? 'final  ' : 'interim') + '] "' + t + '"')
        if (t && msg.is_final) finals.push(t)
      }
    } catch {}
  }

  ws.onerror = () => { if (!opened) console.log('handshake FAILED') }
  ws.onclose = (ev) => {
    console.log('CLOSED code=' + ev.code + ' reason="' + (ev.reason || '') + '" wasClean=' + ev.wasClean)
  }

  const outcome = await new Promise((resolve) => {
    const started = Date.now()
    const check = setInterval(() => {
      if (finals.length) { clearInterval(check); resolve('FINAL RECEIVED') }
      else if (ws.readyState === 3) { clearInterval(check); resolve('CLOSED-WITHOUT-FINAL') }
      else if (Date.now() - started > 25000) { clearInterval(check); resolve('TIMEOUT') }
    }, 200)
  })

  console.log('\nFinal transcripts received: ' + finals.length)
  if (outcome === 'FINAL RECEIVED' && finals.join(' ').length > 3) {
    console.log('\n==============================')
    console.log('PASS: E2E TEST PASSED - real speech in, real transcript out')
    console.log('==============================')
    process.exit(0)
  } else {
    console.log('\nFAIL: E2E TEST FAILED (' + outcome + ')')
    process.exit(1)
  }
})().catch((e) => { console.log('FATAL: ' + e.message); process.exit(1) })