import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { writeFile, unlink, mkdir } from 'fs/promises'
import { join } from 'path'
import { app } from 'electron'
import { tmpdir } from 'os'

/**
 * Local Whisper.cpp STT service.
 *
 * Expected layout (configurable via env):
 *   WHISPER_BIN   -> path to whisper-cli executable
 *   WHISPER_MODEL -> path to ggml model (tiny/base quantized)
 *
 * Defaults resolve to <userData>/whisper/whisper-cli.exe and
 * <userData>/whisper/models/ggml-tiny.bin
 */

export interface WhisperPaths {
  bin: string
  model: string
}

export function getWhisperPaths(): WhisperPaths {
  const base = join(app.getPath('userData'), 'whisper')
  return {
    bin: process.env['WHISPER_BIN'] ?? join(base, 'whisper-cli.exe'),
    model: process.env['WHISPER_MODEL'] ?? join(base, 'models', 'ggml-tiny.bin')
  }
}

export function isWhisperAvailable(): boolean {
  const { bin, model } = getWhisperPaths()
  return existsSync(bin) && existsSync(model)
}

/**
 * Transcribe a 16kHz mono WAV buffer using local whisper.cpp.
 * Returns the trimmed transcription text.
 */
export async function transcribeWav(wavBuffer: Buffer): Promise<string> {
  const { bin, model } = getWhisperPaths()
  if (!existsSync(bin) || !existsSync(model)) {
    throw new Error(
      'Whisper not installed. Place whisper-cli.exe and ggml-tiny.bin under ' +
        join(app.getPath('userData'), 'whisper')
    )
  }

  const workDir = join(tmpdir(), 'ai-interview-assistant')
  await mkdir(workDir, { recursive: true })
  const wavPath = join(workDir, `seg-${Date.now()}.wav`)
  await writeFile(wavPath, wavBuffer)

  try {
    return await new Promise<string>((resolve, reject) => {
      const proc = spawn(bin, [
        '-m', model,
        '-f', wavPath,
        '-nt', // no timestamps
        '-np', // no prints
        '-t', '4' // threads
      ])

      let stdout = ''
      let stderr = ''
      const timeout = setTimeout(() => {
        proc.kill()
        reject(new Error('Whisper transcription timed out (10s)'))
      }, 10_000)

      proc.stdout.on('data', (d) => (stdout += d.toString()))
      proc.stderr.on('data', (d) => (stderr += d.toString()))
      proc.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
      proc.on('close', (code) => {
        clearTimeout(timeout)
        if (code !== 0) {
          reject(new Error(`whisper-cli exited ${code}: ${stderr.slice(-500)}`))
        } else {
          resolve(stdout.trim())
        }
      })
    })
  } finally {
    void unlink(wavPath).catch(() => {})
  }
}