import { Component, Suspense, lazy } from 'react'
import type { ComponentType, ErrorInfo, ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { AuthGate } from './components/AuthGate'
import { ErrorState } from './components/ErrorState'
import { LoadingSkeleton } from './components/LoadingSkeleton'
import { HomePage } from './pages/HomePage'

/**
 * Loads a page module and accepts either export style.
 *
 * The page modules are written by different hands; insisting on `export default`
 * would make the shell the reason a page does not compile. A named export matching the
 * module name works just as well, and the failure — if a module exports neither — is a
 * clear message inside the route's error boundary instead of a blank screen.
 */
function lazyPage(load: () => Promise<unknown>, named: string) {
  return lazy(async () => {
    const module = (await load()) as Record<string, unknown>
    const component = (module.default ?? module[named]) as ComponentType | undefined
    if (!component) throw new Error(`${named}.tsx exports no page component`)
    return { default: component }
  })
}

// Route-level code splitting: the scan page drags in image processing, the memories page
// drags in Leaflet, and the statement page drags in a Markdown renderer. None of that
// belongs in the bundle that has to paint the first screen.
//
// `HomePage` is the exception and is imported eagerly, above: it *is* the first screen
// (FRONTEND-CONTRACT §8), and a launcher that arrives one chunk late is a launcher that
// flashes a skeleton on every cold start. It costs little — a tile grid, and the pure date
// and roll-up helpers the Events and Memories pages already ship.
const ScanPage = lazyPage(() => import('./pages/ScanPage'), 'ScanPage')
const LedgerPage = lazyPage(() => import('./pages/LedgerPage'), 'LedgerPage')
const EventsPage = lazyPage(() => import('./pages/EventsPage'), 'EventsPage')
const CalendarPage = lazyPage(() => import('./pages/CalendarPage'), 'CalendarPage')
const MemoriesPage = lazyPage(() => import('./pages/MemoriesPage'), 'MemoriesPage')
const StatementPage = lazyPage(() => import('./pages/StatementPage'), 'StatementPage')
const SettingsPage = lazyPage(() => import('./pages/SettingsPage'), 'SettingsPage')
// The engineering write-up. Lazy because it is a 60 KB iframe host nobody loads on a
// cold start, and it must never sit in the first-paint bundle.
const HowItWorksPage = lazyPage(() => import('./pages/HowItWorksPage'), 'HowItWorksPage')

interface BoundaryState {
  error: unknown
}

/**
 * Catches a page that threw during render — including a lazy chunk that 404s because the
 * service worker is holding an old build. Reloading is the honest fix for that one.
 */
class RouteErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[twm] a page failed to render', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return <ErrorState error={this.state.error} onRetry={() => window.location.reload()} />
    }
    return this.props.children
  }
}

/**
 * FRONTEND-CONTRACT §6, plus the launcher of §8 and the calendar of §9.
 *
 * `/` renders the home grid; it is no longer a redirect to the ledger. Anything
 * unrecognised lands there too — a launcher is the honest answer to "I do not know where
 * you meant to go", where a list of documents was only ever a guess.
 */
export function App() {
  return (
    <AuthGate>
      <AppShell>
      <RouteErrorBoundary>
        <Suspense fallback={<LoadingSkeleton rows={4} />}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/scan/*" element={<ScanPage />} />
            <Route path="/ledger/*" element={<LedgerPage />} />
            <Route path="/events" element={<EventsPage />} />
            <Route path="/events/:id" element={<EventsPage />} />
            <Route path="/calendar/*" element={<CalendarPage />} />
            <Route path="/memories/*" element={<MemoriesPage />} />
            <Route path="/statement/*" element={<StatementPage />} />
            <Route path="/settings/*" element={<SettingsPage />} />
            <Route path="/how-it-works" element={<HowItWorksPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </RouteErrorBoundary>
      </AppShell>
    </AuthGate>
  )
}

export default App
