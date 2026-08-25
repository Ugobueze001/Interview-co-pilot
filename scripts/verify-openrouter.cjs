/**
 * Verifies OpenRouter FREE-model access with the REAL configured key,
 * mirroring src/renderer/src/services/openrouter.ts exactly.
 * 1. Non-streaming completion through the app's fallback chain
 * 2. SSE streaming (the app's actual code path)
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

function post(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = https.request(
      {
        hostname: 'openrouter.ai',
        path: '/api/v1/chat/completions',
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + readKey(),
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

;(async () => {
  if (!readKey()) { console.log('NO OPENROUTER KEY FOUND'); process.exit(1) }

  // ---- Test 1: non-streaming through the fallback chain ----
  console.log('Test 1: non-streaming via chain:', MODEL_CHAIN.join(' -> '))
  const res = await post({
    model: MODEL_CHAIN[0],
    models: MODEL_CHAIN,
    messages: [
      { role: 'system', content: 'Answer in exactly one short sentence.' },
      { role: 'user', content: 'What is a JavaScript closure?' }
    ]
  })
  const body = await collect(res)
  let answer = ''
  try {
    const j = JSON.parse(body)
    if (j.error) {
      console.log('FAILED:', JSON.stringify(j.error).slice(0, 300))
      process.exit(1)
    }
    answer = (j.choices?.[0]?.message?.content ?? '').trim()
    console.log('HTTP', res.statusCode, '| served by:', j.model)
    console.log('Answer:', answer.slice(0, 220))
  } catch {
    console.log('Unexpected response (' + res.statusCode + '):', body.slice(0, 300))
    process.exit(1)
  }

  // ---- Test 2: SSE streaming - the app's real code path ----
  console.log('\nTest 2: SSE streaming (app code path)')
  const sres = await post({
    model: MODEL_CHAIN[0],
    models: MODEL_CHAIN,
    stream: true,
    messages: [
      { role: 'system', content: 'Answer in one short sentence.' },
      { role: 'user', content: 'Explain a React useEffect cleanup function in one sentence.' }
    ]
  })
  if (sres.statusCode !== 200) {
    console.log('STREAM FAILED HTTP', sres.statusCode, (await collect(sres)).slice(0, 250))
    process.exit(1)
  }
  let tokens = 0
  let full = ''
  let servedBy = '(unknown)'
  let sbuf = ''
  for await (const chunk of sres) {
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
        if (tok) { tokens++; full += tok }
      } catch {}
    }
  }
  console.log('Tokens received:', tokens, '| served by:', servedBy)
  console.log('Streamed answer:', full.trim().slice(0, 220))

  if (answer.length > 10 && full.trim().length > 20) {
    console.log('\n========================================')
    console.log('PASS: OpenRouter free models work end-to-end (no credits needed)')
    console.log('========================================')
    process.exit(0)
  } else {
    console.log('\nFAIL')
    process.exit(1)
  }
})().catch((e) => { console.log('FATAL:', e.message); process.exit(1) })