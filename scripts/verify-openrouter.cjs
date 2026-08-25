/**
 * Verifies OpenRouter FREE-model access with the REAL configured key,
 * mirroring src/renderer/src/services/openrouter.ts exactly.
 * Test 1: non-streaming completion through the app's fallback chain
 * Test 2: SSE streaming (the app's actual code path)
 * Test 3: multi-key rotation - [invalid key, real key] must still answer
 * Never prints the API key. Exit 0 = PASS.
 */
const fs = require('fs')
const path = require('path')
const https = require('https')

const ROOT = path.join(__dirname, '..')
const MODEL_CHAIN = [
  'minimax/minimax-m2.7:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free'
]

function readKey() {
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
      if (k === 'OPENROUTER_API_KEY' && v) return v
    }
  } catch {}
  try {
    return fs.readFileSync(path.join(ROOT, 'openrouter.key'), 'utf-8').trim()
  } catch {}
  return null
}

function post(key, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = https.request(
      {
        hostname: 'openrouter.ai',
        path: '/api/v1/chat/completions',
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + key,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost/aiinterviewassistant',
          'X-Title': 'AI Interview Assistant',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 60000
      },
      resolve
    )
    req.on('error', reject)
    req.end(payload)
  })
}

async function collect(res) {
  const chunks = []
  for await (const c of res) chunks.push(c)
  return Buffer.concat(chunks).toString('utf-8')
}

// One completion attempt; throws Error("OpenRouter <status>: ...") on failure
// exactly like attemptStream() in src/renderer/src/services/openrouter.ts
async function ask(key, question, stream) {
  const res = await post(key, {
    model: MODEL_CHAIN[0],
    models: MODEL_CHAIN,
    stream: !!stream,
    messages: [
      { role: 'system', content: 'Answer in one short sentence.' },
      { role: 'user', content: question }
    ]
  })
  if (res.statusCode !== 200) {
    const errText = (await collect(res)).slice(0, 150)
    throw new Error('OpenRouter ' + res.statusCode + ': ' + errText)
  }
  if (!stream) {
    const j = JSON.parse(await collect(res))
    if (j.error) throw new Error('OpenRouter error: ' + JSON.stringify(j.error))
    return {
      model: j.model,
      text: ((j.choices?.[0]?.message?.content ?? '')).trim()
    }
  }
  // SSE parse
  let full = ''
  let servedBy = '(unknown)'
  let sbuf = ''
  for await (const chunk of res) {
    sbuf += chunk
    const lines = sbuf.split('\n')
    sbuf = lines.pop()
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const p = t.slice(5).trim()
      if (p === '[DONE]') continue
      try {
        const j = JSON.parse(p)
        if (j.model) servedBy = j.model
        const tok = j.choices?.[0]?.delta?.content
        if (tok) full += tok
      } catch {}
    }
  }
  return { model: servedBy, text: full.trim() }
}

;(async () => {
  const realKey = readKey()
  if (!realKey) { console.log('NO OPENROUTER KEY FOUND'); process.exit(1) }

  // ---- Test 1: non-streaming through the fallback chain ----
  console.log('Test 1: non-streaming via chain:', MODEL_CHAIN.join(' -> '))
  const a1 = await ask(realKey, 'What is a JavaScript closure?', false)
  console.log('HTTP OK | served by:', a1.model)
  console.log('Answer:', a1.text.slice(0, 220))
  if (a1.text.length < 10) { console.log('\nFAIL Test 1'); process.exit(1) }

  // ---- Test 2: SSE streaming - the app's real code path ----
  console.log('\nTest 2: SSE streaming (app code path)')
  const a2 = await ask(realKey, 'Explain a React useEffect cleanup function in one sentence.', true)
  console.log('Served by:', a2.model)
  console.log('Streamed answer:', a2.text.slice(0, 220))
  if (a2.text.length < 20) { console.log('\nFAIL Test 2'); process.exit(1) }

  // ---- Test 3: multi-key rotation - [invalid key, real key] ----
  console.log('\nTest 3: multi-key rotation [fake key -> real key]')
  const keys = ['sk-or-v1-000000000000000000000000000000000000000000dead00', realKey]
  let served = -1
  let lastErr = ''
  for (let i = 0; i < keys.length; i++) {
    try {
      const r = await ask(keys[i], 'Name one JavaScript data type.', false)
      served = i
      console.log('Succeeded via key index', i, '- answer:', r.text.slice(0, 120))
      break
    } catch (e) {
      const m = e.message
      const st = parseInt((m.match(/OpenRouter (\d{3})/) || [])[1] || '0', 10)
      const rotatable = st === 401 || st === 402 || st === 429 || st >= 500
      console.log(`  key[${i}] failed with ${st} (${rotatable ? 'rotatable' : 'fatal'})`)
      if (!rotatable || i === keys.length - 1) { lastErr = m; break }
    }
  }
  if (served !== 1) {
    console.log('\nFAIL Test 3 - rotation did not reach key 2. ' + lastErr)
    process.exit(1)
  }

  console.log('\n========================================')
  console.log('PASS: free models work + multi-key rotation verified')
  console.log('========================================')
  process.exit(0)
})().catch((e) => { console.log('FATAL:', e.message); process.exit(1) })