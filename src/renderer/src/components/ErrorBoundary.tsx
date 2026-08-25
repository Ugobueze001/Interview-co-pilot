import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Catches any renderer crash and displays it instead of a blank screen.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('[UI Crash]', error)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="h-full overflow-auto bg-red-950 p-4 text-xs text-red-200">
          <p className="mb-2 font-bold">⚠ UI Error caught — the app did not crash:</p>
          <pre className="whitespace-pre-wrap break-all rounded bg-black/40 p-2">
            {String(this.state.error.stack ?? this.state.error.message)}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-3 rounded bg-red-800 px-3 py-1.5 font-semibold hover:bg-red-700"
          >
            Reload UI
          </button>
        </div>
      )
    }
    return this.props.children
  }
}