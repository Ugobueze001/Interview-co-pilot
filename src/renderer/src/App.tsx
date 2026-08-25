import { useEffect } from 'react'
import { useAppStore } from './store/useAppStore'
import OnboardingForm from './components/OnboardingForm'
import LiveView from './components/LiveView'
import ErrorBoundary from './components/ErrorBoundary'

declare global {
  interface Window {
    api?: {
      config?: {
        getOpenRouterKey: () => Promise<string>
        getDeepgramKey: () => Promise<string>
      }
      stealth: {
        getStatus: () => Promise<{
          contentProtected: boolean
          clickThrough: boolean
          alwaysOnTop: boolean
        }>
        setClickThrough: (enabled: boolean) => Promise<boolean>
        onClickThroughChanged: (callback: (enabled: boolean) => void) => void
      }
      db?: {
        saveProfile: (profile: unknown) => Promise<{ ok: boolean; error?: string }>
        getLatestProfile: () => Promise<{ ok: boolean; profile?: unknown | null; error?: string }>
      }
      stt?: {
        isAvailable: () => Promise<boolean>
        transcribe: (wav: ArrayBuffer) => Promise<{ ok: boolean; text?: string; error?: string }>
      }
    }
  }
}

function App(): React.JSX.Element {
  const phase = useAppStore((s) => s.phase)
  const clickThrough = useAppStore((s) => s.clickThrough)
  const setClickThrough = useAppStore((s) => s.setClickThrough)

  // Load saved API keys (gitignored files) once at startup
  useEffect(() => {
    window.api?.config?.getOpenRouterKey().then((key) => {
      if (key) useAppStore.getState().setOpenRouterKey(key)
    })
  }, [])

  useEffect(() => {
    if (!window.api?.stealth) return

    // Sync initial stealth status from main process
    window.api.stealth.getStatus().then((status) => {
      setClickThrough(status.clickThrough)
    })

    // Listen for global shortcut toggles (Ctrl/Cmd+Shift+X)
    window.api.stealth.onClickThroughChanged(setClickThrough)
  }, [setClickThrough])

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      {/* Title bar */}
      <div className="titlebar-drag flex items-center justify-between border-b border-slate-800 px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
          <span className="text-xs font-semibold tracking-wider text-slate-300 uppercase">
            Interview Co-Pilot
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`rounded px-2 py-0.5 text-[10px] font-medium ${
              clickThrough
                ? 'bg-amber-500/20 text-amber-300'
                : 'bg-emerald-500/20 text-emerald-300'
            }`}
            title="Ctrl/Cmd + Shift + X to toggle click-through"
          >
            {clickThrough ? 'CLICK-THROUGH' : 'INTERACTIVE'}
          </span>
          <span
            className="rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400"
            title="Window is excluded from all screen captures"
          >
            STEALTH ON
          </span>
        </div>
      </div>

      {/* Main content */}
      <div className="min-h-0 flex-1">
        <ErrorBoundary>
          {phase === 'onboarding' ? <OnboardingForm /> : <LiveView />}
        </ErrorBoundary>
      </div>
    </div>
  )
}

export default App