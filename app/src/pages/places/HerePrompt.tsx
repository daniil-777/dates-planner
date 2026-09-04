/**
 * "Where are you?" — asked once, and answerable two ways.
 *
 * The browser's location prompt is the most jarring thing an app can do unannounced, so it is
 * never fired on load. This is the button that fires it, and next to it is the way to answer
 * without it: type a place. Somebody who has said no to location once should not have to keep
 * saying it, and somebody planning an evening in a city they are not in yet needs the typed
 * answer anyway.
 *
 * A refusal is answered with the alternative rather than with the same request again. Nagging
 * is how an app teaches people to say no permanently.
 */
import { useState } from 'react'
import { Button, Input } from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/geographic-bubble-chart.js'

import type { Here } from '@/api/commonsHooks'
import { usePlaceSearch } from '@/api/commonsHooks'
import type { HereStatus } from './useHere'

export interface HerePromptProps {
  status: HereStatus
  onLocate: () => void
  onPick: (here: Here) => void
}

export function HerePrompt({ status, onLocate, onPick }: HerePromptProps): React.ReactElement {
  const [query, setQuery] = useState('')
  const search = usePlaceSearch(query, null)
  const results = (search.data ?? []).slice(0, 5)

  return (
    <div className="here-prompt">
      <p className="here-prompt__lede">
        The commons is arranged by what is near you. Where is that?
      </p>

      {/* Not offered after a refusal — asking again is nagging — and not offered when the
          page is not on a secure origin, because the browser will not even put the prompt up
          and the button would simply do nothing twice. */}
      {status !== 'refused' && status !== 'insecure' && (
        <Button design="Emphasized" icon="geographic-bubble-chart" onClick={onLocate}>
          {status === 'locating'
            ? 'Finding you…'
            : status === 'timeout'
              ? 'Try again'
              : 'Use my location'}
        </Button>
      )}

      {status === 'refused' && (
        <p className="here-prompt__note">
          {/* Answered with the alternative, not with the same request again. */}
          No problem — your browser is set to keep that private. Type a place instead.
        </p>
      )}
      {status === 'insecure' && (
        <p className="here-prompt__note">
          {/* The commonest reason this never works, and the one the old copy could not
              explain: geolocation needs a secure origin. `localhost` counts, a plain-http LAN
              address does not — which is exactly how somebody opens the dev server on their
              phone. "Could not work out where you are" was true and useless. */}
          This page is not on a secure connection, so the browser will not share your location. Open
          it over https, or on localhost — or just type a place below.
        </p>
      )}
      {status === 'timeout' && (
        <p className="here-prompt__note">
          Your device took too long to find a position — that is usually a computer with no GPS
          rather than anything wrong. Try again, or type a place below.
        </p>
      )}
      {status === 'unavailable' && (
        <p className="here-prompt__note">
          Your browser could not work out where you are. On a Mac this is often macOS Location
          Services being off for the browser itself. Typing a place works just as well.
        </p>
      )}

      <div className="here-prompt__search">
        <Input
          value={query}
          placeholder="A city, or a street"
          onInput={event => setQuery((event.target as unknown as { value: string }).value)}
        />
        {query.trim().length >= 3 && (
          <ul className="here-prompt__results">
            {search.isFetching && <li className="here-prompt__hint">Looking…</li>}
            {!search.isFetching && results.length === 0 && (
              <li className="here-prompt__hint">Nothing found.</li>
            )}
            {results.map(candidate => (
              <li key={`${candidate.lat},${candidate.lon}`}>
                <button
                  type="button"
                  className="here-prompt__result"
                  onClick={() => onPick({ lat: candidate.lat, lon: candidate.lon })}
                >
                  {candidate.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
