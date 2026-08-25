import { useState } from 'react'
import { useAppStore, type CandidateProfile } from '../store/useAppStore'

const inputClasses =
  'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none transition focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/40'

export default function OnboardingForm(): React.JSX.Element {
  const saveProfile = useAppStore((s) => s.saveProfile)
  const [fullName, setFullName] = useState('')
  const [resume, setResume] = useState('')
  const [jobTitle, setJobTitle] = useState('')
  const [jobDescription, setJobDescription] = useState('')
  const [keySkills, setKeySkills] = useState('')
  const [openRouterKey, setOpenRouterKey] = useState('')
  const [deepgramKeyInput, setDeepgramKeyInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!fullName.trim()) {
      setError('Please enter your full name.')
      return
    }
    setSaving(true)
    setError(null)

    const profile: CandidateProfile = {
      fullName: fullName.trim(),
      resume: resume.trim(),
      jobTitle: jobTitle.trim(),
      jobDescription: jobDescription.trim(),
      keySkills: keySkills
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    }

    try {
      // Persist to SQLite via main process
      if (window.api?.db) {
        const result = await window.api.db.saveProfile(profile)
        if (!result.ok) throw new Error(result.error ?? 'Failed to save profile')
      }
      useAppStore.getState().setOpenRouterKey(openRouterKey.trim())
      if (deepgramKeyInput.trim()) {
        useAppStore.getState().setDeepgramKey(deepgramKeyInput.trim())
      }
      saveProfile(profile)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <div>
        <h1 className="text-base font-bold text-slate-100">Interview Setup</h1>
        <p className="text-xs text-slate-500">
          Provide your context once — the AI uses it for every answer.
        </p>
      </div>

      <label className="block">
        <span className="mb-1 block text-[11px] font-medium text-slate-400">Full Name *</span>
        <input
          className={inputClasses}
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          placeholder="Jane Doe"
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-[11px] font-medium text-slate-400">
          Resume / Experience Summary
        </span>
        <textarea
          className={`${inputClasses} h-24 resize-none`}
          value={resume}
          onChange={(e) => setResume(e.target.value)}
          placeholder="Paste your resume or a summary of your experience..."
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-[11px] font-medium text-slate-400">Target Job Title</span>
        <input
          className={inputClasses}
          value={jobTitle}
          onChange={(e) => setJobTitle(e.target.value)}
          placeholder="Senior Frontend Engineer"
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-[11px] font-medium text-slate-400">Job Description</span>
        <textarea
          className={`${inputClasses} h-24 resize-none`}
          value={jobDescription}
          onChange={(e) => setJobDescription(e.target.value)}
          placeholder="Paste the full job description..."
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-[11px] font-medium text-slate-400">
          Key Skills (comma separated)
        </span>
        <input
          className={inputClasses}
          value={keySkills}
          onChange={(e) => setKeySkills(e.target.value)}
          placeholder="React, TypeScript, System Design"
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-[11px] font-medium text-slate-400">
          OpenRouter API Key
        </span>
        <input
          className={inputClasses}
          type="password"
          value={openRouterKey}
          onChange={(e) => setOpenRouterKey(e.target.value)}
          placeholder="sk-or-v1-..."
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-[11px] font-medium text-slate-400">
          Deepgram API Key (live speech-to-text)
        </span>
        <input
          className={inputClasses}
          type="password"
          value={deepgramKeyInput}
          onChange={(e) => setDeepgramKeyInput(e.target.value)}
          placeholder="Leave empty to use the saved .env key"
        />
        <span className="mt-1 block text-[10px] text-slate-600">
          Get a free key at console.deepgram.com — or leave blank to reuse the configured one.
        </span>
      </label>

      {error && (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>
      )}

      <button
        type="submit"
        disabled={saving}
        className="mt-auto w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? 'Saving...' : 'Start Interview Mode →'}
      </button>
    </form>
  )
}