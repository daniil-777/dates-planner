/**
 * One place, opened.
 *
 * A sheet from the bottom rather than a route, because a place is something you look *into*
 * from a list and then come back out of — a route would put the list's scroll position, the
 * map's viewport and the filters at the mercy of the back button.
 *
 * ## Tips are the part that carries risk
 *
 * They are free text written by strangers, shown to strangers. They appear only above the
 * anonymity threshold, they carry no author and no date, and each one can be reported by
 * anybody with one press. The report is not a form: asking somebody to categorise their
 * objection is asking them to do the moderation, and most people simply close the app
 * instead.
 *
 * ## The histogram earns its place
 *
 * A mean of 4.2 can be forty people who thought it was fine, or thirty who loved it and ten
 * who had a bad night. Those are different restaurants and the shape is the only thing that
 * tells them apart.
 */
import { Button } from '@ui5/webcomponents-react'
import '@ui5/webcomponents-icons/dist/decline.js'
import '@ui5/webcomponents-icons/dist/flag.js'

import type { PlaceDetail } from '@/api/commons'
import { useReportTip } from '@/api/commonsHooks'
import { MapLinks } from './PlaceCard'
import { StarHistogram, StarRating } from './Stars'
import { TagChips } from './Chips'
import { ANONYMITY_THRESHOLD, KIND_LABEL, costLabel, householdsLabel } from './vocabulary'

export interface PlaceDetailPanelProps {
  detail: PlaceDetail | null
  loading: boolean
  onClose: () => void
  onRate: () => void
}

export function PlaceDetailPanel({
  detail,
  loading,
  onClose,
  onRate,
}: PlaceDetailPanelProps): React.ReactElement | null {
  const report = useReportTip()
  if (!loading && detail?.place == null) return null
  const place = detail?.place ?? null

  return (
    <aside className="place-detail" role="dialog" aria-label={place?.name ?? 'Place'}>
      <div className="place-detail__grip" aria-hidden="true" />
      <header className="place-detail__head">
        <div>
          <h2 className="place-detail__name">{place?.name ?? '…'}</h2>
          {place !== null && (
            <p className="place-detail__meta">
              {[KIND_LABEL[place.kind], place.city].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
        <Button design="Transparent" icon="decline" onClick={onClose} aria-label="Close" />
      </header>

      {place !== null && (
        <>
          {place.published ? (
            <>
              <StarRating value={place.stars} households={place.households} size={18} />
              <StarHistogram buckets={detail?.histogram ?? []} />
            </>
          ) : (
            <p className="place-detail__quiet">
              {householdsLabel(place.households)} so far. {ANONYMITY_THRESHOLD - place.households}{' '}
              more and this place appears for everyone — until then nobody sees its rating, because
              with fewer than that a single household could be picked out of it.
            </p>
          )}

          {place.costBand !== null && (
            <p className="place-detail__cost">{costLabel(place.costBand)}</p>
          )}
          <TagChips tags={place.tags} limit={10} />

          {(detail?.tips.length ?? 0) > 0 && (
            <section className="place-detail__tips">
              <h3 className="place-detail__tips-heading">What worked</h3>
              <ul>
                {detail!.tips.map((tip, index) => (
                  <li className="place-detail__tip" key={index}>
                    <p className="place-detail__tip-text">{tip.text}</p>
                    <button
                      type="button"
                      className="place-detail__report"
                      disabled={report.isPending}
                      onClick={() => report.mutate({ placeID: place.ID, reason: 'reported' })}
                    >
                      Report
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="place-detail__actions">
            <Button design="Emphasized" onClick={onRate}>
              {detail?.ratedByYou === true ? 'Change your rating' : 'Rate it'}
            </Button>
            <MapLinks place={place} />
          </div>
        </>
      )}
    </aside>
  )
}
