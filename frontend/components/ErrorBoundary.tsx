'use client';

import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary] Unhandled error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-screen bg-[#050505] flex items-center justify-center p-6">
          <div className="bg-[#0f0f0f] border border-zinc-800/80 rounded-xl p-8 max-w-[520px] w-full shadow-2xl">
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="w-12 h-12 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center justify-center">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="8" x2="12" y2="12"/>
                  <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-zinc-100">Something went wrong</h2>
              <p className="text-sm text-zinc-400 max-w-xs">
                An unexpected error occurred. Please try refreshing the page.
              </p>
              <pre className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 mt-2 text-xs text-red-400 font-mono overflow-x-auto max-w-full">
                {this.state.error?.message || 'Unknown error'}
              </pre>
              <button
                onClick={() => {
                  this.setState({ hasError: false, error: null });
                  window.location.reload();
                }}
                className="mt-4 bg-zinc-100 hover:bg-white text-zinc-900 font-medium px-5 py-2.5 rounded-lg text-sm transition-colors"
              >
                Refresh Page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
