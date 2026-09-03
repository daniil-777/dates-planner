/**
 * One evening, as a card.
 *
 * Read top to bottom it is a sentence: eat *here*, then do *this*, it costs about *that*, and
 * here is why we are suggesting it. The two halves are separated by a rule with the word
 * "then" in it, because the order is part of the suggestion — a walk after dinner is a
 * different evening from dinner after a walk.
 *
 * ## What the footer says, and what it never says
 *
 * "Worked for 12 households" — a fact about the corpus, with its denominator attached. Never
 * a rank, never a badge, never "#3 in Zürich". A league table invites the wrong question
 * ("is this the best?") in place of the right one ("would we like this?"), and it makes
 * everything below third place look like a failure.
 *
 * ## The cost is the pair, per person
 *
 * The two bands added together, and per *person* — nothing in this app may assume a household
 * is two people.
 */
import '@ui5/webcomponents-icons/dist/appointment-2.js'

import type { Evening } from '@/api/commons'
import { MapLinks } from '@/pages/places/PlaceCard'
import { StarRating } from '@/pages/places/Stars'
import { TagChips } from '@/pages/places/Chips'
import { KIND_LABEL, costLabel, distanceLabel, householdsLabel } from '@/pages/places/vocabulary'

export interface EveningCardProps {
  evening: Evening
  /** Position in the deal, used only to vary the card's accent. */
  index: number
  onPlan: () => void
}

export function EveningCardView({ evening, index, onPlan }: EveningCardProps): React.ReactElement {
  const { eat, doPlace, doIdea } = evening

  return (
    <article className={`evening evening--${index % 3}`}>
      <header className="evening__head">
        <span className="evening__cost">{costLabel(evening.costBand)}</span>
        {eat?.distance !== null && eat?.distance !== undefined && (
          <span className="evening__distance">{distanceLabel(eat.distance)}</span>
        )}
      </header>

      {eat !== null && (
        <section className="evening__half">
          <p className="evening__kicker">Eat</p>
          <h3 className="evening__name">{eat.name}</h3>
          <p className="evening__meta">
            {[KIND_LABEL[eat.kind], eat.city].filter(Boolean).join(' · ')}
          </p>
          <StarRating value={eat.stars} households={eat.households} bare />
          <TagChips tags={eat.tags} limit={3} />
        </section>
      )}

      <p className="evening__then" aria-hidden="true">
        <span>then</span>
      </p>

      <section className="evening__half">
        <p className="evening__kicker">Do</p>
        {doPlace !== null ? (
          <>
            <h3 className="evening__name">{doPlace.name}</h3>
            <p className="evening__meta">
              {[KIND_LABEL[doPlace.kind], distanceLabel(doPlace.distance)]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <StarRating value={doPlace.stars} households={doPlace.households} bare />
            <TagChips tags={doPlace.tags} limit={3} />
          </>
        ) : doIdea !== null ? (
          <>
            <h3 className="evening__name">{doIdea.title}</h3>
            {/* An idea from the deck, used when the corpus has nowhere nearby. A card with a
                meal and no second half is half a card. */}
            <p className="evening__summary">{doIdea.summary}</p>
            {doIdea.minutes !== null && (
              <p className="evening__meta">About {doIdea.minutes} minutes</p>
            )}
          </>
        ) : (
          <p className="evening__summary">Whatever you feel like. That counts too.</p>
        )}
      </section>

      <footer className="evening__foot">
        <p className="evening__because">
          {evening.because || (eat !== null ? `Worked for ${householdsLabel(eat.households)}` : '')}
        </p>
        <div className="evening__buttons">
          <button type="button" className="evening__plan" onClick={onPlan}>
            Plan it
          </button>
          {eat !== null && <MapLinks place={eat} />}
        </div>
      </footer>
    </article>
  )
}
