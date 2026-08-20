import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  label?: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center h-full p-8 text-center">
          <div className="text-red-500 text-xl mb-2">⚠</div>
          <p className="text-redlog-text-dim text-sm mb-1">
            {this.props.label || 'View'} crashed
          </p>
          <p className="text-redlog-text-faint text-xs font-mono mb-4 max-w-md break-all">
            {this.state.error.message}
          </p>
          <button
            onClick={() => this.setState({ error: null })}
            className="px-3 py-1.5 text-xs bg-redlog-elevated text-redlog-text rounded hover:bg-redlog-elevated-hover"
          >
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
