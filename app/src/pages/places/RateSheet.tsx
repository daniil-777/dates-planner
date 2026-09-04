/**
 * Saying how it was.
 *
 * ## Everything below the stars is optional, and that is the design
 *
 * A rating is one tap. The chips, the cost and the sentence are all things somebody *may*
 * add, and the button is live the moment a star is pressed. The research this is built from
 * is blunt about it — make the action tiny — and a form that demands four fields before it
 * will accept "it was lovely" is a form that collects nothing.
 *
 * So the sheet is ordered by how likely each part is to be filled in, and only the first
 * costs anybody anything.
 *
 * ## Rating again amends
 *
 * Opening this for a place a household has already rated loads their answer and the button
 * says *Update*. One household is one voice (CONTRACTS §14.3), so there is no way to leave a
 * second rating and no need for the sheet to explain that — it simply shows what they said.
 *
 * ## The tip is where the risk is
 *
 * It is public, so the sheet says so under the field rather than in a policy nobody opens,
 * and the server refuses a link or an `@handle` with a sentence this shows verbatim. The
 * counter is a plain count, not a warning: a length limit is not a telling-off.
 */
import { useEffect, useMemo, useState } from 'react'
import { Bar, Button, Dialog, Input, Label, MessageStrip, TextArea } from '@ui5/webcomponents-react'

import type { PlaceCandidate, PlaceCard } from '@/api/commons'
import { useHere } from './useHere'
import { usePlaceSearch, useRate, useWithdrawRating } from '@/api/commonsHooks'
import { StarInput } from './Stars'
import { TagPicker } from './Chips'
import { COST_BANDS, MAX_TIP_LENGTH, costLabel, type CostBand, type PlaceTag } from './vocabulary'

export interface RateSheetProps {
  open: boolean
  /** A place already in the corpus, when the sheet was opened from one. */
  place?: PlaceCard | null
  /**
   * Somewhere the corpus has never heard of, already chosen — a café tapped on the map.
   *
   * The sheet has always been able to rate a place that is not in the corpus; the only way
   * in was to type its name into the search field. Somebody looking at the map is looking
   * at the thing they mean, and asking them to spell it is asking them to do the map's job.
   */
  candidate?: PlaceCandidate | null
  /** What this household said last time, so the sheet opens on their answer. */
  yourStars?: number | null
  onClose: () => void
  onRated?: (place: PlaceCard) => void
}

export function RateSheet({
  open,
  place = null,
  candidate = null,
  yourStars = null,
  onClose,
  onRated,
}: RateSheetProps): React.ReactElement {
  const { here } = useHere()
  const [stars, setStars] = useState<number | null>(null)
  const [costBand, setCostBand] = useState<CostBand | null>(null)
  const [tags, setTags] = useState<PlaceTag[]>([])
  const [tip, setTip] = useState('')
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<PlaceCandidate | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const rate = useRate()
  const withdraw = useWithdrawRating()
  const search = usePlaceSearch(query, here)

  // Reset every time the sheet opens, so it never shows the last place's answer against this
  // one's name — and load this household's own rating when there is one.
  useEffect(() => {
    if (!open) return
    setStars(yourStars)
    setCostBand(place?.costBand ?? null)
    setTags([])
    setTip('')
    setQuery('')
    // A candidate handed in from the map opens the sheet already pointed at it, so the
    // search field never appears and the first thing anybody touches is a star.
    setChosen(candidate)
    setProblem(null)
  }, [open, place?.ID, yourStars, place?.costBand, candidate])

  const target = place ?? chosen
  const name = place?.name ?? chosen?.name ?? null
  const canSave = stars !== null && target !== null && !rate.isPending

  const submit = async (): Promise<void> => {
    if (stars === null || target === null) return
    setProblem(null)
    try {
      const saved = await rate.mutateAsync(
        place !== null
          ? { placeID: place.ID, stars, costBand, tags, tip: tip.trim() || null }
          : {
              name: chosen!.name,
              kind: chosen!.kind,
              lat: chosen!.lat,
              lon: chosen!.lon,
              city: chosen!.city,
              country: chosen!.country,
              osmType: chosen!.osmType,
              osmId: chosen!.osmId,
              stars,
              costBand,
              tags,
              tip: tip.trim() || null,
            },
      )
      onRated?.(saved)
      onClose()
    } catch (error) {
      // CAP's message is written for a person — "A tip cannot contain a link." — so it goes
      // in front of one unchanged.
      setProblem(error instanceof Error ? error.message : 'That did not save.')
    }
  }

  const remove = async (): Promise<void> => {
    if (place === null) return
    setProblem(null)
    try {
      await withdraw.mutateAsync(place.ID)
      onClose()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That did not work.')
    }
  }

  const results = useMemo(() => (search.data ?? []).slice(0, 6), [search.data])

  return (
    <Dialog
      open={open}
      headerText={name === null ? 'Rate a place' : name}
      onClose={onClose}
      className="rate-sheet"
      footer={
        <Bar
          design="Footer"
          startContent={
            place !== null && yourStars !== null ? (
              <Button design="Transparent" onClick={remove} disabled={withdraw.isPending}>
                Take mine back
              </Button>
            ) : undefined
          }
          endContent={
            <>
              <Button design="Transparent" onClick={onClose}>
                Cancel
              </Button>
              <Button design="Emphasized" onClick={submit} disabled={!canSave}>
                {rate.isPending ? 'Saving…' : yourStars !== null ? 'Update' : 'Post'}
              </Button>
            </>
          }
        />
      }
    >
      <div className="rate-sheet__body">
        {problem !== null && <MessageStrip design="Negative">{problem}</MessageStrip>}

        {/*
          The picker is for finding a place by name. When one arrived from the map, that
          question is already answered — showing a search field pointed at the thing somebody
          just tapped invites them to re-answer it, and typing into it silently clears the
          selection. The header already carries the name.
        */}
        {place === null && candidate === null && (
          <section className="rate-sheet__section">
            <Label required>Which place?</Label>
            <Input
              value={chosen?.name ?? query}
              placeholder="Start typing a name"
              onInput={event => {
                setChosen(null)
                setQuery((event.target as unknown as { value: string }).value)
              }}
            />
            {chosen === null && query.trim().length >= 3 && (
              <ul className="rate-sheet__results">
                {search.isFetching && <li className="rate-sheet__hint">Looking…</li>}
                {!search.isFetching && results.length === 0 && (
                  <li className="rate-sheet__hint">
                    Nothing found. Try the name on its own, without the street.
                  </li>
                )}
                {results.map(candidate => (
                  <li key={`${candidate.osmType}-${candidate.osmId}-${candidate.lat}`}>
                    <button
                      type="button"
                      className="rate-sheet__result"
                      onClick={() => setChosen(candidate)}
                    >
                      <span className="rate-sheet__result-name">{candidate.name}</span>
                      <span className="rate-sheet__result-label">{candidate.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section className="rate-sheet__section rate-sheet__section--stars">
          <StarInput value={stars} onChange={setStars} label={name ?? 'this place'} />
          <p className="rate-sheet__hint">Everything below is optional.</p>
        </section>

        <section className="rate-sheet__section">
          <Label>Roughly what did it cost, each?</Label>
          <div className="rate-sheet__costs">
            {COST_BANDS.map(band => (
              <button
                type="button"
                key={band}
                aria-pressed={costBand === band}
                className={`rate-sheet__cost${costBand === band ? ' rate-sheet__cost--on' : ''}`}
                onClick={() => setCostBand(costBand === band ? null : band)}
              >
                {costLabel(band).replace(' each', '')}
              </button>
            ))}
          </div>
        </section>

        <section className="rate-sheet__section">
          {/* No <Label> here: `TagPicker` labels each of its three groups, and the first of
              them is "What was it like?" — which put the same words on screen twice. */}
          <TagPicker value={tags} onChange={setTags} />
        </section>

        <section className="rate-sheet__section">
          <Label>Anything worth knowing?</Label>
          <TextArea
            value={tip}
            rows={3}
            maxlength={MAX_TIP_LENGTH}
            placeholder="Ask for the corner table."
            onInput={event => setTip((event.target as unknown as { value: string }).value)}
          />
          <p className="rate-sheet__hint">
            {/* Said here, next to the field, rather than in a policy nobody opens. */}
            Other households will read this. No names, no links.
            <span className="rate-sheet__count">
              {tip.length}/{MAX_TIP_LENGTH}
            </span>
          </p>
        </section>
      </div>
    </Dialog>
  )
}
