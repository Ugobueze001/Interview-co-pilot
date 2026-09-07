import { contextBridge, ipcRenderer } from 'electron'

export interface ProfileInput {
  fullName: string
  resume: string
  jobTitle: string
  jobDescription: string
  keySkills: string[]
}

export interface ProfileRow {
  id: number
  full_name: string
  resume: string
  job_title: string
  job_description: string
  key_skills: string
  created_at: string
  updated_at: string
}

const api = {
  stealth: {
    getStatus: (): Promise<{ contentProtected: boolean; clickThrough: boolean; alwaysOnTop: boolean }> =>
      ipcRenderer.invoke('stealth:get-status'),
    setClickThrough: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke('stealth:set-click-through', enabled),
    onClickThroughChanged: (callback: (enabled: boolean) => void): void => {
      const listener = (_event: unknown, enabled: boolean): void => callback(enabled)
      ipcRenderer.on('stealth:click-through-changed', listener)
    }
  },
  db: {
    saveProfile: (
      profile: ProfileInput
    ): Promise<{ ok: boolean; profile?: ProfileRow; error?: string }> =>
      ipcRenderer.invoke('db:save-profile', profile),
    getLatestProfile: (): Promise<{ ok: boolean; profile?: ProfileRow | null; error?: string }> =>
      ipcRenderer.invoke('db:get-latest-profile')
  },
  config: {
    getOpenRouterKey: (): Promise<string> => ipcRenderer.invoke('config:get-openrouter-key'),
    getOpenRouterKeys: (): Promise<string[]> => ipcRenderer.invoke('config:get-openrouter-keys'),
    getDeepgramKey: (): Promise<string> => ipcRenderer.invoke('config:get-deepgram-key')
  },
  perm: {
    getMicrophone: (): Promise<string> => ipcRenderer.invoke('perm:get-microphone'),
    getScreen: (): Promise<string> => ipcRenderer.invoke('perm:get-screen')
  },
  stt: {
    isAvailable: (): Promise<boolean> => ipcRenderer.invoke('stt:is-available'),
    transcribe: (wav: ArrayBuffer): Promise<{ ok: boolean; text?: string; error?: string }> =>
      ipcRenderer.invoke('stt:transcribe', wav)
  }
}

export type StealthAPI = typeof api.stealth

contextBridge.exposeInMainWorld('api', api)
