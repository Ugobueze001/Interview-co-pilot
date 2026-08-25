import { create } from 'zustand'

export type AppPhase = 'onboarding' | 'live'
export type AudioChannel = 'interviewer' | 'user'

export interface CandidateProfile {
  fullName: string
  resume: string
  jobTitle: string
  jobDescription: string
  keySkills: string[]
}

export interface TranscriptEntry {
  id: string
  channel: AudioChannel
  text: string
  timestamp: number
}

interface AppState {
  // Onboarding / phase management
  phase: AppPhase
  profile: CandidateProfile | null
  openRouterKey: string
  openRouterKeys: string[] // extra keys from .env / openrouter.key (rate-limit fallbacks)
  deepgramKey: string

  // Stealth mode
  clickThrough: boolean
  contentProtected: boolean

  // Dual audio
  listening: boolean
  interviewerSpeaking: boolean
  transcripts: TranscriptEntry[]
  sttError: string | null

  // Actions
  setPhase: (phase: AppPhase) => void
  saveProfile: (profile: CandidateProfile) => void
  setOpenRouterKey: (key: string) => void
  setOpenRouterKeys: (keys: string[]) => void
  setDeepgramKey: (key: string) => void
  setClickThrough: (enabled: boolean) => void
  setContentProtected: (enabled: boolean) => void
  setListening: (listening: boolean) => void
  setInterviewerSpeaking: (speaking: boolean) => void
  addTranscript: (channel: AudioChannel, text: string) => void
  setSttError: (error: string | null) => void
}

let transcriptCounter = 0

export const useAppStore = create<AppState>((set) => ({
  phase: 'onboarding',
  profile: null,
  openRouterKey: '',
  openRouterKeys: [],
  deepgramKey: '',

  clickThrough: false,
  contentProtected: true,

  listening: false,
  interviewerSpeaking: false,
  transcripts: [],
  sttError: null,

  setPhase: (phase) => set({ phase }),
  saveProfile: (profile) => set({ profile, phase: 'live' }),
  setOpenRouterKey: (openRouterKey) => set({ openRouterKey }),
  setOpenRouterKeys: (openRouterKeys) => set({ openRouterKeys }),
  setDeepgramKey: (deepgramKey) => set({ deepgramKey }),
  setClickThrough: (clickThrough) => set({ clickThrough }),
  setContentProtected: (contentProtected) => set({ contentProtected }),
  setListening: (listening) => set({ listening }),
  setInterviewerSpeaking: (interviewerSpeaking) => set({ interviewerSpeaking }),
  addTranscript: (channel, text) =>
    set((state) => ({
      transcripts: [
        ...state.transcripts,
        {
          id: `t-${++transcriptCounter}`,
          channel,
          text,
          timestamp: Date.now()
        }
      ]
    })),
  setSttError: (sttError) => set({ sttError })
}))