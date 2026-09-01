import '@ui5/webcomponents-fiori/dist/illustrations/UnableToLoad.js'
import '@ui5/webcomponents-fiori/dist/illustrations/ErrorScreen.js'
import '@ui5/webcomponents-fiori/dist/illustrations/PageNotFound.js'
import '@ui5/webcomponents-fiori/dist/illustrations/Connection.js'
import '@ui5/webcomponents-icons/dist/refresh.js'
import { Button, IllustratedMessage, Text } from '@ui5/webcomponents-react'
import { describeError, isApiError } from '../api/client'

export interface ErrorStateProps {
  error: unknown
  onRetry?: () => void
  className?: string
}

/**
 * CAP writes its error messages for people — `"period 2026-01 has already been cleared by
 * CLR-2026-01."` — so the message is shown verbatim rather than replaced with a generic
 * apology. The status and CAP error code go underneath in small type, because they are what
 * makes a bug report useful.
 */
function illustrationFor(status: number | null): string {
  if (status === 0) return 'Connection'
  if (status === 404) return 'PageNotFound'
  if (status !== null && status >= 500) return 'UnableToLoad'
  return 'ErrorScreen'
}

function headlineFor(status: number | null): string {
  if (status === 0) return 'The ledger is offline'
  if (status === 401 || status === 403) return 'This ledger belongs to somebody else'
  if (status === 404) return 'Nothing to post here'
  if (status !== null && status >= 500) return 'The ledger could not answer'
  return 'That did not go through'
}

export function ErrorState({ error, onRetry, className }: ErrorStateProps) {
  const status = isApiError(error) ? error.status : null
  const detail = isApiError(error) ? error.detail : ''
  const footnote = [status !== null && status > 0 ? `HTTP ${status}` : null, detail]
    .filter(part => typeof part === 'string' && part.length > 0)
    .join(' · ')

  return (
    <div
      className={className ? `twm-error ${className}` : 'twm-error'}
      role="alert"
      data-testid="error-state"
    >
      <IllustratedMessage
        name={illustrationFor(status)}
        titleText={headlineFor(status)}
        subtitleText={describeError(error)}
        design="Auto"
      >
        {onRetry ? (
          <Button design="Emphasized" icon="refresh" onClick={() => onRetry()}>
            Try again
          </Button>
        ) : null}
      </IllustratedMessage>
      {footnote ? <Text className="twm-error__footnote">{footnote}</Text> : null}
    </div>
  )
}

export default ErrorState
